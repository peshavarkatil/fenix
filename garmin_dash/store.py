"""SQLite cache. The dashboard reads only from here, so it opens instantly,
works offline, and a Garmin outage can never blank the screen."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS daily (
    kind TEXT NOT NULL, day TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (kind, day)
);
CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY, start TEXT, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);
CREATE INDEX IF NOT EXISTS idx_act_start ON activities(start);
"""


class Store:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        try:
            Path(self.path).chmod(0o600)
        except OSError:
            pass

    # ---- daily metrics -------------------------------------------------
    def put_daily(self, kind: str, rows: dict[str, dict[str, Any]]) -> None:
        with self._lock, self._conn:
            self._conn.executemany(
                "INSERT INTO daily(kind, day, payload) VALUES (?,?,?) "
                "ON CONFLICT(kind, day) DO UPDATE SET payload=excluded.payload",
                [(kind, d, json.dumps(v)) for d, v in rows.items()],
            )

    def merged_days(self, start: str, end: str) -> list[dict[str, Any]]:
        """One merged record per day across all metric kinds."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT kind, day, payload FROM daily WHERE day BETWEEN ? AND ? ORDER BY day, kind",
                (start, end),
            )
            rows = cur.fetchall()
        out: dict[str, dict[str, Any]] = {}
        for _kind, day, payload in rows:
            rec = out.setdefault(day, {"date": day})
            for k, v in json.loads(payload).items():
                if v is not None:
                    rec[k] = v
        return [out[d] for d in sorted(out)]

    def dump_daily(self, keep_from: str | None = None) -> dict[str, dict[str, dict[str, Any]]]:
        """Everything, grouped by kind then day. Used to carry history between runs."""
        q, args = "SELECT kind, day, payload FROM daily", []
        if keep_from:
            q += " WHERE day >= ?"
            args.append(keep_from)
        with self._lock:
            rows = self._conn.execute(q + " ORDER BY kind, day", args).fetchall()
        out: dict[str, dict[str, dict[str, Any]]] = {}
        for kind, day, payload in rows:
            out.setdefault(kind, {})[day] = json.loads(payload)
        return out

    def latest_day(self, kind: str) -> str | None:
        with self._lock:
            row = self._conn.execute("SELECT MAX(day) FROM daily WHERE kind=?", (kind,)).fetchone()
        return row[0] if row else None

    # ---- activities ----------------------------------------------------
    def put_activities(self, items: Iterable[dict[str, Any]]) -> None:
        with self._lock, self._conn:
            self._conn.executemany(
                "INSERT INTO activities(id, start, payload) VALUES (?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET start=excluded.start, payload=excluded.payload",
                [(str(a["id"]), a.get("start"), json.dumps(a)) for a in items if a.get("id") is not None],
            )

    def activities(self, start: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        q = "SELECT payload FROM activities"
        args: list[Any] = []
        if start:
            q += " WHERE start >= ?"
            args.append(start)
        q += " ORDER BY start DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            return [json.loads(r[0]) for r in self._conn.execute(q, args).fetchall()]

    # ---- meta ----------------------------------------------------------
    def set_meta(self, key: str, value: Any) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO meta(key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )

    def get_meta(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def stamp(self) -> float:
        return time.time()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
