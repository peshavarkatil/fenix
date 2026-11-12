"""Incremental sync from a source into the local cache.

Safe by design:
- each kind of data syncs independently; one failure never blocks the others
- only the days that are missing (plus a small overlap) are fetched
- big ranges are chunked, and chunked smaller if Garmin rejects the size
- errors are recorded and shown in the UI, never swallowed
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, timedelta
from typing import Any

from . import normalize
from .sources import ALL_KINDS, RANGE_KINDS, FetchError
from .store import Store

log = logging.getLogger("garmin_dash.sync")

CHUNK_DAYS = 30
OVERLAP_DAYS = 3  # re-fetch recent days: Garmin revises today and last night


def _chunks(start: date, end: date, size: int):
    d = start
    while d <= end:
        e = min(d + timedelta(days=size - 1), end)
        yield d, e
        d = e + timedelta(days=1)


def _fetch_range(source: Any, kind: str, start: date, end: date) -> list[Any]:
    """Fetch [start, end] in chunks; on a 400, retry that chunk in weekly pieces."""
    raws = []
    for cs, ce in _chunks(start, end, CHUNK_DAYS):
        try:
            raws.append(source.fetch(kind, cs, ce))
        except FetchError as e:
            if e.status == 400 and (ce - cs).days >= 7:
                for ws, we in _chunks(cs, ce, 7):
                    raws.append(source.fetch(kind, ws, we))
            else:
                raise
    return raws


class Syncer:
    def __init__(self, source: Any, store: Store, history_days: int = 90):
        self.source, self.store, self.history_days = source, store, history_days
        self._lock = threading.Lock()
        self.running = False
        self.last_raw: dict[str, Any] = {}  # latest raw response per kind (for `probe`)

    def run(self, today: date | None = None, full: bool = False) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            return {"skipped": "sync already running"}
        self.running = True
        try:
            return self._run(today or date.today(), full)
        finally:
            self.running = False
            self._lock.release()

    def _run(self, today: date, full: bool) -> dict[str, Any]:
        report: dict[str, Any] = {}
        status = self.store.get_meta("status", {})
        floor = today - timedelta(days=self.history_days)
        for kind in ALL_KINDS:
            try:
                last = None if full else self.store.get_meta(f"through:{kind}")
                start = floor if not last else max(floor, date.fromisoformat(last) - timedelta(days=OVERLAP_DAYS))
                n = self._sync_kind(kind, start, today)
                self.store.set_meta(f"through:{kind}", today.isoformat())
                status[kind] = {"ok_at": time.time(), "error": None, "rows": n}
                report[kind] = {"ok": True, "rows": n}
            except FetchError as e:
                log.error("sync %s failed: %s", kind, e)
                prev = status.get(kind, {})
                status[kind] = {"ok_at": prev.get("ok_at"), "error": str(e), "rows": prev.get("rows")}
                report[kind] = {"ok": False, "error": str(e)}
            except Exception as e:  # a parsing bug must not take down the app
                log.exception("unexpected error syncing %s", kind)
                prev = status.get(kind, {})
                status[kind] = {"ok_at": prev.get("ok_at"), "error": f"Unexpected error: {type(e).__name__}", "rows": prev.get("rows")}
                report[kind] = {"ok": False, "error": f"Unexpected error: {type(e).__name__}"}
        self.store.set_meta("status", status)
        self.store.set_meta("last_sync", time.time())
        return report

    def _sync_kind(self, kind: str, start: date, end: date) -> int:
        if kind == "activities":
            raw = self.source.fetch("activities", start, end)
            self.last_raw[kind] = raw
            items = normalize.activities(raw)
            self.store.put_activities(items)
            return len(items)
        total = 0
        for raw in _fetch_range(self.source, kind, start, end):
            self.last_raw[kind] = raw
            rows = normalize.NORMALIZERS[kind](raw)
            self.store.put_daily(kind, rows)
            total += len(rows)
        return total


__all__ = ["Syncer", "RANGE_KINDS"]
