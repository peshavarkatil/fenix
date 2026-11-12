from datetime import date, timedelta

import pytest

from garmin_dash import normalize
from garmin_dash.sources import DemoSource, FetchError, RealSource
from garmin_dash.store import Store
from garmin_dash.sync import Syncer

TODAY = date(2026, 11, 7)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "t.db")
    yield s
    s.close()


def test_demo_data_parses_into_every_field(store):
    Syncer(DemoSource(), store, history_days=30).run(today=TODAY)
    day = store.merged_days("2026-11-07", "2026-11-07")[0]
    for k in ("steps", "rhr", "sleep_total_s", "sleep_score", "hrv_last", "stress_avg", "bb_high", "bb_series"):
        assert day.get(k) is not None, k
    assert len(store.activities()) > 0


def test_second_sync_only_fetches_recent_days(store):
    calls = []

    class Spy(DemoSource):
        def fetch(self, kind, start, end):
            calls.append((kind, start, end))
            return super().fetch(kind, start, end)

    sy = Syncer(Spy(), store, history_days=60)
    sy.run(today=TODAY)
    calls.clear()
    sy.run(today=TODAY + timedelta(days=1))
    sleep_calls = [c for c in calls if c[0] == "sleep"]
    assert sleep_calls and (sleep_calls[0][2] - sleep_calls[0][1]).days <= 5


def test_one_failing_kind_does_not_block_others(store):
    class Flaky(DemoSource):
        def fetch(self, kind, start, end):
            if kind == "hrv":
                raise FetchError("Garmin kept returning 503", status=503)
            return super().fetch(kind, start, end)

    report = Syncer(Flaky(), store, history_days=10).run(today=TODAY)
    assert report["hrv"]["ok"] is False and report["sleep"]["ok"] is True
    assert "503" in store.get_meta("status")["hrv"]["error"]


def test_parser_bug_is_contained(store, monkeypatch):
    monkeypatch.setitem(normalize.NORMALIZERS, "stress", lambda raw: 1 / 0)
    report = Syncer(DemoSource(), store, history_days=10).run(today=TODAY)
    assert report["stress"]["ok"] is False and report["steps"]["ok"] is True


def test_400_range_error_falls_back_to_weekly_chunks(store):
    seen = []

    class PickyRange(DemoSource):
        def fetch(self, kind, start, end):
            if kind == "steps":
                if (end - start).days + 1 > 7:
                    raise FetchError("too big", status=400)
                seen.append((end - start).days + 1)
            return super().fetch(kind, start, end)

    report = Syncer(PickyRange(), store, history_days=40).run(today=TODAY)
    assert report["steps"]["ok"] and seen and max(seen) <= 7


def test_normalizers_tolerate_missing_and_odd_shapes():
    assert normalize.sleep(None) == {}
    assert normalize.sleep({"unexpected": 1}) == {}
    assert normalize.hrv([{"calendarDate": "2026-11-01"}]) == {
        "2026-11-01": {"hrv_last": None, "hrv_weekly": None, "hrv_status": None, "hrv_base_low": None, "hrv_base_high": None}}
    nested = {"wrapper": {"values": [{"calendarDate": "2026-11-01", "totalSteps": "8123"}]}}
    assert normalize.steps(nested)["2026-11-01"]["steps"] == 8123.0


class _Http(Exception):
    pass


def test_real_source_reauths_once_on_401_and_retries_429(monkeypatch):
    import garmin_personal_api as g

    class FakeHttp(g.HttpError):
        def __init__(self, status):
            Exception.__init__(self, f"http {status}")
            self.status_code = status

    outcomes = [FakeHttp(401), FakeHttp(429), [{"calendarDate": "2026-11-07", "totalSteps": 5}]]
    opens = []

    class FakeClient:
        def get_daily_steps(self, s, e):
            o = outcomes.pop(0)
            if isinstance(o, Exception):
                raise o
            return o

        def close(self):
            pass

    src = RealSource(pace_seconds=0)
    monkeypatch.setattr("time.sleep", lambda *_: None)
    monkeypatch.setattr(RealSource, "_open", lambda self, force=False: (opens.append(force), setattr(self, "_client", FakeClient())))
    out = src.fetch("steps", TODAY, TODAY)
    assert out[0]["totalSteps"] == 5
    assert opens == [False, True]  # initial open, then one forced refresh after the 401


def test_real_source_gives_up_cleanly_on_persistent_429(monkeypatch):
    import garmin_personal_api as g

    class Always429(g.HttpError):
        def __init__(self):
            Exception.__init__(self, "429")
            self.status_code = 429

    class C:
        def get_daily_steps(self, *a):
            raise Always429()

        def close(self):
            pass

    monkeypatch.setattr("time.sleep", lambda *_: None)
    monkeypatch.setattr(RealSource, "_open", lambda self, force=False: setattr(self, "_client", C()))
    with pytest.raises(FetchError) as ei:
        RealSource(pace_seconds=0, max_retries=2).fetch("steps", TODAY, TODAY)
    assert ei.value.status == 429 and ei.value.retryable
