import json
from datetime import date

import pytest

from garmin_dash import export
from garmin_dash.publish import PublishError, run
from garmin_dash.sources import DemoSource, FetchError

PW = "correct horse battery staple"


def read(out, pw=PW):
    return json.loads(export.decrypt((out / "data.bin").read_bytes(), pw))


def test_encrypt_roundtrip_and_wrong_passphrase():
    blob = export.encrypt(b"hello", PW)
    assert export.decrypt(blob, "  " + PW + " ") == b"hello"      # stray spaces are forgiven
    with pytest.raises(export.WrongPassphrase):
        export.decrypt(blob, "wrong passphrase here")
    bad = bytearray(blob); bad[6] ^= 1                              # tampered header (salt)
    with pytest.raises(export.WrongPassphrase):
        export.decrypt(bytes(bad), PW)
    with pytest.raises(ValueError):
        export.encrypt(b"x", "short")


def test_publish_demo_then_incremental(tmp_path):
    out = tmp_path / "a"
    rep = run(DemoSource(), "demo", PW, out, None, history_days=30)
    assert all(v["ok"] for v in rep.values())
    snap = read(out)
    assert snap["mode"] == "demo" and snap["days"] and snap["activities"]
    first_salt = export.header_salt((out / "data.bin").read_bytes())
    out2 = tmp_path / "b"
    run(DemoSource(), "demo", PW, out2, out / "data.bin", history_days=30)
    assert export.header_salt((out2 / "data.bin").read_bytes()) == first_salt   # phone's saved key stays valid
    assert read(out2)["days"][-1]["date"] == snap["days"][-1]["date"]
    assert "data.bin.tmp" not in {p.name for p in out2.iterdir()}


def test_wrong_passphrase_stops_instead_of_wiping_history(tmp_path):
    run(DemoSource(), "demo", PW, tmp_path / "a", None, history_days=10)
    with pytest.raises(PublishError):
        run(DemoSource(), "demo", "a different passphrase!", tmp_path / "b", tmp_path / "a" / "data.bin", history_days=10)
    assert not (tmp_path / "b" / "data.bin").exists()
    run(DemoSource(), "demo", "a different passphrase!", tmp_path / "c", tmp_path / "a" / "data.bin", history_days=10, reset=True)
    assert (tmp_path / "c" / "data.bin").exists()


def test_real_run_never_inherits_sample_history(tmp_path):
    run(DemoSource(), "demo", PW, tmp_path / "a", None, history_days=10)
    run(DemoSource(), "real", PW, tmp_path / "b", tmp_path / "a" / "data.bin", history_days=10)
    snap = read(tmp_path / "b")
    assert snap["mode"] == "real"


class Dead:
    def fetch(self, kind, start, end):
        raise FetchError("boom", status=500)
    def close(self): pass


def test_total_failure_publishes_nothing(tmp_path):
    with pytest.raises(PublishError):
        run(Dead(), "real", PW, tmp_path / "a", None)
    assert not (tmp_path / "a" / "data.bin").exists()


def test_bad_timezone_is_explained(tmp_path):
    with pytest.raises(PublishError, match="time zone"):
        run(DemoSource(), "demo", PW, tmp_path, None, tz="Mars/Base")
