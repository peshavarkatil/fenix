"""Data check: asks Garmin for 3 recent days of every kind of data and reports which
fields we could read. It prints field NAMES and types only, never your actual values,
so the report is safe to copy and share when something looks empty."""
from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from . import normalize
from .sources import ALL_KINDS, FetchError


def shape(obj: Any, depth: int = 0, max_depth: int = 5) -> Any:
    if depth > max_depth:
        return "..."
    if isinstance(obj, dict):
        return {k: shape(v, depth + 1, max_depth) for k, v in list(obj.items())[:40]}
    if isinstance(obj, list):
        return [f"list[{len(obj)}]", shape(obj[0], depth + 1, max_depth)] if obj else "list[0]"
    return type(obj).__name__


def build_report(source: Any, today: date | None = None) -> str:
    end = today or date.today()
    start = end - timedelta(days=3)
    out = [f"Fenix Dash data check, {end.isoformat()}", ""]
    for kind in ALL_KINDS:
        out.append(f"=== {kind} ===")
        try:
            raw = source.fetch(kind, start, end)
        except FetchError as e:
            out += [f"  FAILED: {e}", ""]
            continue
        out.append("  shape: " + json.dumps(shape(raw), indent=2).replace("\n", "\n  "))
        if kind == "activities":
            rows = normalize.activities(raw)
            found = {k for r in rows for k, v in r.items() if v is not None}
            every = set(rows[0]) if rows else set()
            count = len(rows)
        else:
            parsed = normalize.NORMALIZERS[kind](raw)
            found = {k for r in parsed.values() for k, v in r.items() if v is not None}
            every = {k for r in parsed.values() for k in r}
            count = len(parsed)
        out += [f"  parsed rows: {count}", f"  fields found:   {sorted(found)}", f"  fields MISSING: {sorted(every - found)}", ""]
    return "\n".join(out)
