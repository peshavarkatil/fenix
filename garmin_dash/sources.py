"""Where raw data comes from: Garmin's Personal API (real) or a generator (demo).

Both expose the same `fetch(kind, start, end)` and return raw, Garmin-shaped
JSON, so demo data exercises exactly the same parsing path as real data.
"""
from __future__ import annotations

import logging
import math
import random
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

log = logging.getLogger("garmin_dash.sources")

RANGE_KINDS = ("daily_summaries", "steps", "stress", "hrv", "sleep", "body_battery")
ALL_KINDS = RANGE_KINDS + ("activities",)


class FetchError(Exception):
    """A failure fetching one kind of data. `status` is the HTTP status if any."""

    def __init__(self, message: str, status: int | None = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


# ======================================================================= real
class RealSource:
    """Reads your own data through Garmin's official Personal API (read-only)."""

    name = "garmin"

    def __init__(self, pace_seconds: float = 0.3, max_retries: int = 3):
        self._client: Any = None
        self._lock = threading.Lock()
        self.pace = pace_seconds
        self.max_retries = max_retries

    # -- auth: key -> 24h bearer token (Garmin has no refresh tokens) -------
    def _open(self, force: bool = False) -> None:
        from garmin_personal_api import (
            GarminPersonalApiClient,
            GarminPersonalApiError,
            HttpError,
            PersonalApiAuthenticator,
            resolve_api_key,
        )

        try:
            key = resolve_api_key()
        except GarminPersonalApiError as e:
            raise FetchError(
                "No Garmin Personal API key found. Create one in Garmin Connect "
                "(Settings > Personal API) and save it, see README.",
                status=None,
            ) from e
        try:
            with PersonalApiAuthenticator() as auth:
                token = auth.obtain_token(key, force_refresh=force)
        except HttpError as e:
            if e.status_code in (400, 401, 403):
                raise FetchError(
                    "Garmin rejected your Personal API key. It may have expired or been deleted. "
                    "Create a new key in Garmin Connect and replace the old one.",
                    status=e.status_code,
                ) from e
            raise FetchError(f"Garmin's login service returned {e.status_code}", status=e.status_code, retryable=True) from e
        except Exception as e:  # never include the key in the message
            raise FetchError(f"Could not get an access token from Garmin: {type(e).__name__}", retryable=True) from e
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
        self._client = GarminPersonalApiClient(token.access_token, timeout=30.0)

    def _call(self, fn_name: str, *args: Any, **kwargs: Any) -> Any:
        from garmin_personal_api import HttpError
        import requests

        delay = 4.0
        reauthed = False
        for attempt in range(self.max_retries + 1):
            with self._lock:
                if self._client is None:
                    self._open()
                client = self._client
            try:
                result = getattr(client, fn_name)(*args, **kwargs)
                time.sleep(self.pace)
                return result
            except HttpError as e:
                status = e.status_code
                if status == 401 and not reauthed:
                    reauthed = True
                    with self._lock:
                        self._open(force=True)
                    continue
                if status == 429 or (status is not None and status >= 500):
                    if attempt < self.max_retries:
                        log.warning("Garmin returned %s for %s, retrying in %.0fs", status, fn_name, delay)
                        time.sleep(delay)
                        delay *= 3
                        continue
                    raise FetchError(f"Garmin kept returning {status}", status=status, retryable=True) from e
                raise FetchError(f"Garmin returned {status} for {fn_name}", status=status) from e
            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt < self.max_retries:
                    time.sleep(delay)
                    delay *= 3
                    continue
                raise FetchError("Could not reach Garmin (network problem)", retryable=True) from e
        raise FetchError("Gave up after repeated retries", retryable=True)

    def fetch(self, kind: str, start: date, end: date) -> Any:
        s, e = start.isoformat(), end.isoformat()
        if kind == "daily_summaries":
            return self._call("get_daily_summaries", s, e)
        if kind == "steps":
            return self._call("get_daily_steps", s, e)
        if kind == "stress":
            return self._call("get_daily_stress", s, e)
        if kind == "hrv":
            return self._call("get_daily_hrv_summaries", s, e)
        if kind == "sleep":
            return self._call("get_daily_sleep_summaries", s, e)
        if kind == "body_battery":
            return self._call("get_daily_body_battery", s, e)
        if kind == "activities":
            return self._fetch_activities(s, e)
        raise ValueError(f"unknown kind {kind}")

    def _fetch_activities(self, s: str, e: str) -> list[Any]:
        from .normalize import records

        out: list[Any] = []
        page, offset = 50, 0
        while offset < 2000:  # hard ceiling so a bad response can't loop forever
            batch = self._call("search_activities", start=offset, limit=page, start_date=s, end_date=e)
            items = records(batch) if batch else []
            out.extend(items)
            if len(items) < page:
                break
            offset += page
        return out

    def close(self) -> None:
        if self._client is not None:
            self._client.close()


# ======================================================================= demo
class DemoSource:
    """Synthetic but plausible data in the same shapes Garmin's API returns.
    Deterministic: the same day always yields the same numbers."""

    name = "demo"

    def _rng(self, d: date, salt: str) -> random.Random:
        return random.Random(f"{d.isoformat()}-{salt}")

    def _profile(self, d: date) -> dict[str, float]:
        r = self._rng(d, "p")
        wk = d.weekday()
        trained = wk in (1, 3, 5) or r.random() < 0.15
        ramp = 1 + 0.06 * math.sin(d.toordinal() / 9)
        hrv = 52 * ramp + r.gauss(0, 5) - (6 if trained and r.random() < 0.4 else 0)
        sleep_h = max(4.8, min(9.2, r.gauss(7.2, 0.8) + (0.4 if wk in (5, 6) else 0)))
        return {
            "trained": trained,
            "hrv": hrv,
            "sleep_s": sleep_h * 3600,
            "rhr": 54 - (hrv - 52) * 0.12 + r.gauss(0, 1.2),
            "steps": max(2500, r.gauss(9200, 2600) + (3500 if trained else 0)),
            "stress": max(14, min(70, r.gauss(32, 8) - (hrv - 52) * 0.3)),
        }

    def fetch(self, kind: str, start: date, end: date) -> Any:
        days = list(daterange(start, end))
        if kind == "steps":
            return [
                {"calendarDate": d.isoformat(), "totalSteps": int(self._profile(d)["steps"]),
                 "stepGoal": 10000, "totalDistance": int(self._profile(d)["steps"] * 0.76)}
                for d in days
            ]
        if kind == "daily_summaries":
            out = []
            for d in days:
                p = self._profile(d)
                out.append({
                    "calendarDate": d.isoformat(), "totalSteps": int(p["steps"]), "dailyStepGoal": 10000,
                    "totalDistanceMeters": int(p["steps"] * 0.76), "restingHeartRate": round(p["rhr"]),
                    "minHeartRate": round(p["rhr"] - 4), "maxHeartRate": round(142 if p["trained"] else 118),
                    "bodyBatteryHighestValue": round(min(100, 62 + (p["hrv"] - 45) * 1.4 + p["sleep_s"] / 3600 * 2)),
                    "bodyBatteryLowestValue": round(18 + self._rng(d, "bbl").random() * 14),
                    "activeKilocalories": int(420 + (380 if p["trained"] else 0) + self._rng(d, "k").random() * 90),
                    "totalKilocalories": int(2350 + (420 if p["trained"] else 40)),
                    "averageStressLevel": round(p["stress"]),
                    "moderateIntensityMinutes": int(p["trained"] * 26 + 8),
                    "vigorousIntensityMinutes": int(p["trained"] * 14),
                    "floorsAscended": int(self._rng(d, "f").random() * 14),
                })
            return out
        if kind == "stress":
            out = []
            for d in days:
                p = self._profile(d)
                total = 16 * 3600
                hi = int(total * max(0, p["stress"] - 20) / 200)
                me = int(total * p["stress"] / 200)
                lo = int(total * 0.30)
                out.append({"calendarDate": d.isoformat(), "overallStressLevel": round(p["stress"]),
                            "restStressDuration": total - hi - me - lo, "lowStressDuration": lo,
                            "mediumStressDuration": me, "highStressDuration": hi})
            return out
        if kind == "hrv":
            out = []
            for d in days:
                p = self._profile(d)
                out.append({"calendarDate": d.isoformat(), "weeklyAvg": round(52 + 4 * math.sin(d.toordinal() / 9)),
                            "lastNightAvg": round(p["hrv"]),
                            "status": "BALANCED" if p["hrv"] > 46 else "UNBALANCED",
                            "baseline": {"balancedLow": 46, "balancedUpper": 62}})
            return {"hrvSummaries": out}
        if kind == "sleep":
            out = []
            for d in days:
                p = self._profile(d)
                r = self._rng(d, "s")
                tot = p["sleep_s"]
                deep, rem = tot * r.uniform(0.15, 0.22), tot * r.uniform(0.18, 0.25)
                light, awake = tot - deep - rem, tot * r.uniform(0.03, 0.09)
                score = max(38, min(97, 52 + (tot / 3600 - 5) * 9 + (p["hrv"] - 45) * 0.5 + r.gauss(0, 4)))
                start_dt = datetime(d.year, d.month, d.day) - timedelta(hours=1.2) + timedelta(minutes=r.randint(-40, 50))
                out.append({"dailySleepDTO": {
                    "calendarDate": d.isoformat(), "sleepTimeSeconds": int(tot), "deepSleepSeconds": int(deep),
                    "lightSleepSeconds": int(light), "remSleepSeconds": int(rem), "awakeSleepSeconds": int(awake),
                    "sleepScores": {"overall": {"value": round(score)}},
                    "sleepStartTimestampLocal": start_dt.replace(tzinfo=timezone.utc).timestamp() * 1000,
                    "sleepEndTimestampLocal": (start_dt + timedelta(seconds=tot + awake)).replace(tzinfo=timezone.utc).timestamp() * 1000,
                    "avgOvernightHrv": round(p["hrv"]), "restingHeartRate": round(p["rhr"]),
                    "averageSpO2Value": round(r.uniform(93, 97)), "averageRespirationValue": round(r.uniform(13, 16), 1),
                }})
            return {"dailySleepDTOList": out}
        if kind == "body_battery":
            out = []
            for d in days:
                p = self._profile(d)
                r = self._rng(d, "bb")
                level = 14 + (p["sleep_s"] / 3600 - 5) * 7 + (p["hrv"] - 45) * 0.5
                pts, base = [], datetime(d.year, d.month, d.day).timestamp() * 1000
                for i in range(0, 96):  # 15-minute resolution
                    h = i / 4
                    if h < 6.5:
                        level = min(100, level + 2.6 + r.random())
                    elif h < 22.5:
                        level = max(5, level - (0.6 + r.random() * 0.55) * (2.2 if p["trained"] and 17 < h < 19 else 1))
                    else:
                        level = min(100, level + 0.6)
                    pts.append([base + i * 900000, round(level)])
                if d == date.today():  # a real watch has no readings from the future
                    now_ms = datetime.now().timestamp() * 1000
                    pts = [pt for pt in pts if pt[0] <= now_ms] or pts[:1]
                hi = max(v for _, v in pts)
                out.append({"date": d.isoformat(), "charged": round(hi - 25), "drained": round(hi - pts[-1][1] + 25),
                            "bodyBatteryValuesArray": pts})
            return out
        if kind == "activities":
            return self._activities(start, end)
        raise ValueError(f"unknown kind {kind}")

    def _activities(self, start: date, end: date) -> list[dict[str, Any]]:
        kinds = [("running", "Morning Run", 7800, 3400), ("running", "Tempo Run", 9100, 3200),
                 ("strength_training", "Strength", 0, 3300), ("cycling", "Evening Ride", 24000, 3900),
                 ("hiking", "Foothills Hike", 8200, 5400), ("walking", "Lunch Walk", 3400, 2400)]
        out = []
        for d in daterange(start, end):
            p = self._profile(d)
            if not p["trained"]:
                continue
            r = self._rng(d, "a")
            t, name, dist, dur = kinds[r.randrange(len(kinds))]
            f = r.uniform(0.8, 1.25)
            begin = datetime(d.year, d.month, d.day, r.choice([6, 7, 12, 17, 18]), r.choice([0, 15, 30, 45]))
            out.append({
                "activityId": int(d.strftime("%Y%m%d")) * 10 + 1,
                "activityName": name, "activityType": {"typeKey": t},
                "startTimeLocal": begin.strftime("%Y-%m-%d %H:%M:%S"),
                "duration": dur * f, "distance": dist * f,
                "averageHR": round(r.uniform(128, 156)), "maxHR": round(r.uniform(165, 188)),
                "calories": round(dur * f / 60 * r.uniform(8, 12)),
                "elevationGain": round(r.uniform(10, 380)) if t in ("hiking", "running", "cycling") else 0,
                "averageSpeed": (dist * f) / (dur * f) if dist else 0,
                "aerobicTrainingEffect": round(r.uniform(1.8, 4.2), 1),
            })
        return out

    def close(self) -> None:
        pass
