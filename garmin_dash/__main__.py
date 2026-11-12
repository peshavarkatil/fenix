"""Command line.

  python -m garmin_dash publish   build the encrypted data file from your real Garmin data
  python -m garmin_dash probe     check what Garmin returns (field names only, no values)
  python -m garmin_dash preview   build a file of SAMPLE data to try the app (passphrase: sample-passphrase)
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from . import config
from .publish import DEFAULT_TZ, PublishError, run
from .sources import DemoSource, RealSource

SAMPLE_PASSPHRASE = "sample-passphrase"


def cmd_publish(a: argparse.Namespace) -> int:
    pw = os.environ.get("FENIX_PASSPHRASE", "")
    if not pw:
        print("FENIX_PASSPHRASE is not set. Add it as a repository secret (see SETUP.md).")
        return 2
    if not config.has_api_key():
        print("No Garmin Personal API key found (GARMIN_PERSONAL_API_KEY). Nothing was published.")
        return 2
    try:
        report = run(RealSource(), "real", pw, Path(a.out), Path(a.previous) if a.previous else None,
                     tz=os.environ.get("FENIX_TIMEZONE") or DEFAULT_TZ,
                     reset=os.environ.get("FENIX_RESET") == "1", full=a.full)
    except (PublishError, ValueError) as e:
        print(f"ERROR: {e}")
        return 1
    for kind, r in report.items():
        print(f"  {kind:16} {'ok, %s rows' % r['rows'] if r.get('ok') else 'FAILED: ' + r['error']}")
    return 0


def cmd_preview(a: argparse.Namespace) -> int:
    run(DemoSource(), "demo", SAMPLE_PASSPHRASE, Path(a.out), None, history_days=120)
    print(f"Wrote sample data to {a.out}/data.bin  (passphrase: {SAMPLE_PASSPHRASE})")
    return 0


def cmd_probe(_a: argparse.Namespace) -> int:
    from .diag import build_report

    if not config.has_api_key():
        print("No Garmin Personal API key found (GARMIN_PERSONAL_API_KEY).")
        return 2
    print(build_report(RealSource()))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="garmin_dash")
    p.add_argument("--verbose", "-v", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("publish")
    s.add_argument("--out", default="site")
    s.add_argument("--previous", help="the data.bin published last time, if any")
    s.add_argument("--full", action="store_true", help="re-download the whole history")
    s = sub.add_parser("preview")
    s.add_argument("--out", default="site")
    sub.add_parser("probe")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    return {"publish": cmd_publish, "preview": cmd_preview, "probe": cmd_probe}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
