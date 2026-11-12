"""Build the data file the phone app reads.

    fetch from Garmin  ->  merge with the previous file  ->  encrypt  ->  data.bin

Safety rules (each one protects your history):
- Real data is never replaced by sample data. No key = hard failure.
- If the previous file can't be opened with your passphrase, we stop instead of
  silently starting over (unless you explicitly ask with FENIX_RESET=1).
- If every kind of data failed to download, nothing is published.
"""
from __future__ import annotations

import json
import os
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from . import export
from .store import Store
from .sync import Syncer

KEEP_DAYS = 400
DEFAULT_TZ = "America/Los_Angeles"


class PublishError(Exception):
    pass


def today_in(tz: str) -> date:
    try:
        return datetime.now(ZoneInfo(tz)).date()
    except Exception as e:
        raise PublishError(f"FENIX_TIMEZONE '{tz}' is not a valid time zone name (example: Europe/London).") from e


def restore(store: Store, snapshot: dict[str, Any]) -> None:
    for kind, rows in snapshot.get("state", {}).get("daily", {}).items():
        store.put_daily(kind, rows)
    store.put_activities(snapshot.get("activities", []))
    for key, val in snapshot.get("state", {}).get("through", {}).items():
        store.set_meta(f"through:{key}", val)
    store.set_meta("status", snapshot.get("status", {}))


def snapshot_of(store: Store, mode: str, tz: str, today: date, report: dict[str, Any]) -> dict[str, Any]:
    keep_from = (today - timedelta(days=KEEP_DAYS)).isoformat()
    status = store.get_meta("status", {})
    kinds = {}
    for k, v in status.items():
        v = dict(v)
        if k in report and report[k].get("ok"):
            v["ok_at"] = v.get("ok_at") or time.time()
        kinds[k] = v
    return {
        "v": 1, "mode": mode, "tz": tz, "today": today.isoformat(),
        "generated": datetime.now(UTC).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": store.merged_days(keep_from, today.isoformat()),
        "activities": store.activities(start=keep_from, limit=1000),
        "status": kinds,
        "state": {
            "daily": store.dump_daily(keep_from),
            "through": {k: store.get_meta(f"through:{k}") for k in status if store.get_meta(f"through:{k}")},
        },
    }


def run(source: Any, mode: str, passphrase: str, out_dir: Path, previous: Path | None = None,
        tz: str = DEFAULT_TZ, reset: bool = False, history_days: int = 90, full: bool = False) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    store = Store(":memory:")
    salt, fresh = None, False
    prev_blob = previous.read_bytes() if previous and previous.exists() and previous.stat().st_size else None
    if prev_blob and not reset:
        try:
            prev = json.loads(export.decrypt(prev_blob, passphrase))
        except export.WrongPassphrase as e:
            raise PublishError(
                "The existing published data can't be opened with this passphrase. "
                "If you changed your passphrase on purpose, run again with FENIX_RESET=1 "
                "(this throws away old history and rebuilds from Garmin)."
            ) from e
        if prev.get("mode") == "demo" and mode == "real":
            prev, fresh = {}, True  # never mix sample data into real history
        restore(store, prev)
        salt = export.header_salt(prev_blob)  # same salt => the phone's remembered key keeps working
    today = today_in(tz)
    syncer = Syncer(source, store, history_days=history_days)
    report = syncer.run(today=today, full=full or fresh or not prev_blob or reset)
    if not any(v.get("ok") for v in report.values()):
        raise PublishError("Garmin returned nothing for every kind of data, so nothing was published. Details: " + json.dumps(report))
    snap = snapshot_of(store, mode, tz, today, report)
    blob = export.encrypt(json.dumps(snap, separators=(",", ":")).encode(), passphrase, salt=salt)
    tmp = out_dir / "data.bin.tmp"
    tmp.write_bytes(blob)
    tmp.replace(out_dir / "data.bin")
    (out_dir / "status.json").write_text(json.dumps({  # no personal data: only when it was built
        "generated": snap["generated"], "mode": mode,
        "ok": {k: bool(v.get("ok")) for k, v in report.items()},
    }))
    return report
