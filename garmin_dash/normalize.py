"""Turn Garmin's raw JSON into small, flat, UI-friendly records.

Garmin's responses are large and nested, and the exact field names are the part
of this app most likely to need a tweak once it meets your real data. So every
extractor is *tolerant*: it searches nested objects for any of several
candidate key names, and returns None (not an error) when a field is missing.
The dashboard shows "no data" for that card instead of breaking.

Run `python -m garmin_dash probe` to see the real response shapes, then add
any missing key names to the candidate lists below.
"""
from __future__ import annotations

from typing import Any

Json = Any


# ---------------------------------------------------------------- helpers
def find(obj: Json, *names: str, depth: int = 4) -> Json:
    """First value whose key matches one of `names` (case-insensitive),
    searching breadth-first through nested dicts. Names are tried in order."""
    wanted = [n.lower() for n in names]
    level = [obj]
    for _ in range(depth + 1):
        nxt: list[Json] = []
        for node in level:
            if isinstance(node, dict):
                lowered = {str(k).lower(): v for k, v in node.items()}
                for w in wanted:
                    if w in lowered and lowered[w] is not None:
                        return lowered[w]
                nxt.extend(v for v in node.values() if isinstance(v, dict))
        if not nxt:
            break
        level = nxt
    return None


def num(v: Json) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def first_num(obj: Json, *names: str) -> float | None:
    return num(find(obj, *names))


def records(raw: Json) -> list[dict[str, Any]]:
    """Pull the list of per-day (or per-item) dicts out of a response,
    whether it is a bare list or wrapped in an object."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    if isinstance(raw, dict):
        best = _largest_dict_list(raw, 3)
        return best or [raw]
    return []


def _largest_dict_list(node: Json, depth: int) -> list[dict[str, Any]]:
    best: list[dict[str, Any]] = []
    if not isinstance(node, dict):
        return best
    for v in node.values():
        if isinstance(v, list) and v and all(isinstance(i, dict) for i in v):
            cand = v
        elif isinstance(v, dict) and depth > 0:
            cand = _largest_dict_list(v, depth - 1)
        else:
            continue
        if len(cand) > len(best):
            best = cand
    return best


def day_of(rec: dict[str, Any]) -> str | None:
    v = find(rec, "calendarDate", "sleepDate", "date", "summaryDate", depth=2)
    if isinstance(v, str) and len(v) >= 10:
        return v[:10]
    return None


# ------------------------------------------------------------ per-kind
def steps(raw: Json) -> dict[str, dict[str, Any]]:
    out = {}
    for r in records(raw):
        d = day_of(r)
        if not d:
            continue
        out[d] = {
            "steps": first_num(r, "totalSteps", "steps"),
            "step_goal": first_num(r, "stepGoal", "dailyStepGoal"),
            "distance_m": first_num(r, "totalDistance", "distanceInMeters"),
        }
    return out


def daily_summaries(raw: Json) -> dict[str, dict[str, Any]]:
    out = {}
    for r in records(raw):
        d = day_of(r)
        if not d:
            continue
        out[d] = {
            "steps": first_num(r, "totalSteps"),
            "step_goal": first_num(r, "dailyStepGoal", "stepGoal"),
            "distance_m": first_num(r, "totalDistanceMeters", "totalDistance"),
            "rhr": first_num(r, "restingHeartRate"),
            "hr_min": first_num(r, "minHeartRate"),
            "hr_max": first_num(r, "maxHeartRate"),
            "bb_high": first_num(r, "bodyBatteryHighestValue", "bodyBatteryMostRecentValue"),
            "bb_low": first_num(r, "bodyBatteryLowestValue"),
            "active_kcal": first_num(r, "activeKilocalories"),
            "total_kcal": first_num(r, "totalKilocalories"),
            "stress_avg": first_num(r, "averageStressLevel"),
            "intensity_min": _sum(
                first_num(r, "moderateIntensityMinutes"), first_num(r, "vigorousIntensityMinutes", )
            ),
            "floors": first_num(r, "floorsAscended"),
        }
    return out


def _sum(*vals: float | None) -> float | None:
    got = [v for v in vals if v is not None]
    return sum(got) if got else None


def stress(raw: Json) -> dict[str, dict[str, Any]]:
    out = {}
    for r in records(raw):
        d = day_of(r)
        if not d:
            continue
        out[d] = {
            "stress_avg": first_num(r, "overallStressLevel", "avgStressLevel", "averageStressLevel"),
            "stress_rest_s": first_num(r, "restStressDuration"),
            "stress_low_s": first_num(r, "lowStressDuration"),
            "stress_med_s": first_num(r, "mediumStressDuration"),
            "stress_high_s": first_num(r, "highStressDuration"),
        }
    return out


def hrv(raw: Json) -> dict[str, dict[str, Any]]:
    out = {}
    for r in records(raw):
        d = day_of(r)
        if not d:
            continue
        status = find(r, "status")
        out[d] = {
            "hrv_last": first_num(r, "lastNightAvg", "lastNight"),
            "hrv_weekly": first_num(r, "weeklyAvg"),
            "hrv_status": str(status).title().replace("_", " ") if isinstance(status, str) else None,
            "hrv_base_low": first_num(r, "balancedLow"),
            "hrv_base_high": first_num(r, "balancedUpper"),
        }
    return out


def sleep(raw: Json) -> dict[str, dict[str, Any]]:
    out = {}
    for r in records(raw):
        d = day_of(r)
        if not d:
            continue
        score = find(r, "overall")
        if isinstance(score, dict):
            score = score.get("value")
        if score is None:
            score = find(r, "sleepScore", "overallScore")
        out[d] = {
            "sleep_total_s": first_num(r, "sleepTimeSeconds", "totalSleepSeconds"),
            "sleep_deep_s": first_num(r, "deepSleepSeconds"),
            "sleep_light_s": first_num(r, "lightSleepSeconds"),
            "sleep_rem_s": first_num(r, "remSleepSeconds"),
            "sleep_awake_s": first_num(r, "awakeSleepSeconds"),
            "sleep_score": num(score),
            "sleep_start": _ts(find(r, "sleepStartTimestampLocal", "sleepStartTimestampGMT")),
            "sleep_end": _ts(find(r, "sleepEndTimestampLocal", "sleepEndTimestampGMT")),
            "hrv_last": first_num(r, "avgOvernightHrv"),
            "rhr": first_num(r, "restingHeartRate"),
            "spo2_avg": first_num(r, "averageSpO2Value", "avgSpO2"),
            "resp_avg": first_num(r, "averageRespirationValue"),
        }
    return out


def body_battery(raw: Json) -> dict[str, dict[str, Any]]:
    out = {}
    for r in records(raw):
        d = day_of(r)
        if not d:
            continue
        series = _series(find(r, "bodyBatteryValuesArray", "bodyBatteryValues"))
        values = [v for _, v in series]
        out[d] = {
            "bb_charged": first_num(r, "charged"),
            "bb_drained": first_num(r, "drained"),
            "bb_high": max(values) if values else None,
            "bb_low": min(values) if values else None,
            "bb_series": series,
        }
    return out


def _series(raw: Json, max_points: int = 96) -> list[list[float]]:
    """[[epoch_ms, value], ...] thinned to at most max_points."""
    pts: list[list[float]] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                t, v = num(item[0]), num(item[-1] if len(item) == 2 else item[1])
                if t is not None and v is not None:
                    pts.append([t, v])
            elif isinstance(item, dict):
                t = num(find(item, "timestamp", "startGMT", "time"))
                v = num(find(item, "value", "bodyBatteryLevel"))
                if t is not None and v is not None:
                    pts.append([t, v])
    if len(pts) > max_points:
        step = len(pts) / max_points
        pts = [pts[int(i * step)] for i in range(max_points)]
    return pts


def _ts(v: Json) -> float | None:
    n = num(v)
    return n


def activities(raw: Json) -> list[dict[str, Any]]:
    items = records(raw)
    out = []
    for r in items:
        aid = find(r, "activityId", "id", depth=1)
        if aid is None:
            continue
        a_type = find(r, "typeKey", depth=3)
        start = find(r, "startTimeLocal", "startTimeGMT", depth=2)
        out.append(
            {
                "id": str(aid),
                "name": find(r, "activityName", depth=1) or "Activity",
                "type": a_type if isinstance(a_type, str) else "other",
                "start": start if isinstance(start, str) else None,
                "duration_s": first_num(r, "duration", "elapsedDuration"),
                "distance_m": first_num(r, "distance"),
                "avg_hr": first_num(r, "averageHR", "avgHr"),
                "max_hr": first_num(r, "maxHR", "maxHr"),
                "calories": first_num(r, "calories"),
                "elev_gain_m": first_num(r, "elevationGain"),
                "avg_speed_ms": first_num(r, "averageSpeed"),
                "training_effect": first_num(r, "aerobicTrainingEffect"),
            }
        )
    return out


NORMALIZERS = {
    "steps": steps,
    "daily_summaries": daily_summaries,
    "stress": stress,
    "hrv": hrv,
    "sleep": sleep,
    "body_battery": body_battery,
}

