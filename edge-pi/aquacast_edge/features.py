"""Model inputs (features) for the DO forecast.

The SAME code turns readings into features on the Raspberry Pi (forecast.py) and when the model is
trained (train.py), so the model always sees its inputs exactly the way it was trained on them.
Standard library only (no numpy), works on Python 3.9+.

Inputs: the readings of the last 6 hours on the 10-minute grid. Missing or invalid readings are
NaN; XGBoost was trained with gaps, so a few missing readings are fine.

Target (what the model predicts): the CHANGE in DO from now to now + horizon. The forecast is
DO now + predicted change. Predicting the change (not the level) makes the model carry over to
ponds whose normal DO level differs from the training data.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone

STEP_MIN = 10
SPAN = 36                  # 36 x 10 min = 6 hours of history (+ the current reading)
LOCAL_UTC_OFFSET_H = 8     # Asia/Manila: hour-of-day features use pond-local time
NAN = float("nan")

FEATURES = [
    "do_now",            # DO now (mg/L)
    "d_10", "d_20", "d_30", "d_60", "d_120", "d_180", "d_360",  # DO now minus DO that many minutes ago
    "slope_60",          # trend over the last hour (least squares, mg/L per 10 min)
    "accel_60",          # is the trend speeding up or slowing down
    "mean_3h_rel",       # 3-hour average minus DO now
    "below_max_6h",      # 6-hour maximum minus DO now
    "above_min_6h",      # DO now minus 6-hour minimum
    "noise_60",          # how jumpy the readings were in the last hour
    "hour_sin", "hour_cos",   # time of day (pond-local)
    "water_temp",        # water temperature now (C)
    "water_temp_d60",    # water temperature change over the last hour
    "sat_pct",           # DO as % of saturation at this water temperature
    "valid_frac_6h",     # share of the last 6 hours with a valid DO reading
]

_FRACTION = re.compile(r"\.\d+")


def parse_utc(ts) -> datetime:
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    s = _FRACTION.sub("", str(ts).strip().replace(" ", "T")).replace("Z", "+00:00")
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def do_saturation(temp_c: float) -> float:
    """Fresh water, sea level (mg/L). Same formula as the dashboard simulator."""
    t = temp_c
    return 14.62 - 0.3898 * t + 0.006969 * t ** 2 - 0.00005897 * t ** 3


def _ok(v) -> bool:
    return v is not None and not (isinstance(v, float) and math.isnan(v))


def grid_from_history(history, now=None):
    """history (oldest first, last item = now) -> (do[0..SPAN], temp[0..SPAN], now) where index k is
    k x 10 minutes ago. Readings that are not on the grid are put on the nearest 10-minute slot."""
    if not history:
        return [None] * (SPAN + 1), [None] * (SPAN + 1), now
    now = parse_utc(now or history[-1]["timestamp_utc"])
    do = [None] * (SPAN + 1)
    wt = [None] * (SPAN + 1)
    for h in history:
        k = round((now - parse_utc(h["timestamp_utc"])).total_seconds() / (STEP_MIN * 60))
        if 0 <= k <= SPAN:
            if _ok(h.get("do_mg_l")):
                do[k] = float(h["do_mg_l"])
            if _ok(h.get("water_temp_c")):
                wt[k] = float(h["water_temp_c"])
    return do, wt, now


def _slope(points):
    """least-squares slope of [(x, y)]"""
    n = len(points)
    mx = sum(p[0] for p in points) / n
    my = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mx) ** 2 for p in points)
    return sum((p[0] - mx) * (p[1] - my) for p in points) / sxx if sxx else NAN


def build(do, wt, now) -> list:
    """Feature vector (same order as FEATURES). do/wt: index k = k x 10 minutes ago, None = missing.
    do[0] (DO now) must be present."""
    d0 = do[0]
    nan = NAN

    def diff(k):
        return d0 - do[k] if do[k] is not None else nan

    hour_pts = [(-k, do[k]) for k in range(0, 7) if do[k] is not None]
    slope = _slope(hour_pts) if len(hour_pts) >= 4 else nan
    # acceleration: change over the last 30 min minus the change over the 30 min before that
    accel = (d0 - do[3]) - (do[3] - do[6]) if do[3] is not None and do[6] is not None else nan
    last3h = [v for v in do[:19] if v is not None]
    last6h = [v for v in do if v is not None]
    steps = [do[k] - do[k + 1] for k in range(6) if do[k] is not None and do[k + 1] is not None]
    if len(steps) >= 3:
        m = sum(steps) / len(steps)
        noise = math.sqrt(sum((s - m) ** 2 for s in steps) / len(steps))
    else:
        noise = nan
    local = now + timedelta(hours=LOCAL_UTC_OFFSET_H)
    hour = local.hour + local.minute / 60
    t0 = wt[0]
    t6 = wt[6]
    return [
        d0,
        diff(1), diff(2), diff(3), diff(6), diff(12), diff(18), diff(36),
        slope,
        accel,
        (sum(last3h) / len(last3h) - d0) if len(last3h) >= 6 else nan,
        max(last6h) - d0,
        d0 - min(last6h),
        noise,
        math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24),
        t0 if t0 is not None else nan,
        (t0 - t6) if t0 is not None and t6 is not None else nan,
        (d0 / do_saturation(t0) * 100) if t0 is not None and 0 < t0 < 45 else nan,
        len(last6h) / (SPAN + 1),
    ]


def from_history(history) -> list:
    do, wt, now = grid_from_history(history)
    return build(do, wt, now)
