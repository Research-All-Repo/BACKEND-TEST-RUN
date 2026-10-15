"""Official risk level for one cycle: RISK-RULE-1.0 (same rule the dashboard explains).

  NORMAL            current DO >= 5.0 mg/L and all forecasts >= 5.0
  WATCH             current DO >= 5.0 and at least one forecast > 3.0 but < 5.0
  WARNING           current DO > 3.0 but < 5.0, or any forecast <= 3.0
  CRITICAL          current observed DO <= 3.0
  DATA_UNAVAILABLE  current DO or required forecasts unavailable

If your group changes the thresholds, also change RULE_VERSION (e.g. RISK-RULE-1.1) and tell
whoever maintains the dashboard so the explanation there matches.
"""
from __future__ import annotations

RULE_VERSION = "RISK-RULE-1.0"
CRITICAL = 3.0
WATCH = 5.0
HORIZONS = (30, 60, 90, 120)


def assess(current_do, forecasts):
    """current_do: mg/L or None (not VALID). forecasts: the 4 forecast dicts of this cycle.
    Returns (state, outlook, crossing_utc_or_None)."""
    valid = [f for f in forecasts if f["forecast_status"] == "VALID"]
    preds = [f["predicted_do_mg_l"] for f in valid]
    if current_do is None:
        state = "DATA_UNAVAILABLE"
    elif current_do <= CRITICAL:
        state = "CRITICAL"
    elif current_do < WATCH:
        state = "WARNING"
    elif any(p <= CRITICAL for p in preds):
        state = "WARNING"
    elif any(CRITICAL < p < WATCH for p in preds):
        state = "WATCH"
    elif len(valid) == len(HORIZONS):
        state = "NORMAL"
    else:
        state = "DATA_UNAVAILABLE"

    crossing = next((f for f in sorted(valid, key=lambda f: f["horizon_minutes"]) if f["predicted_do_mg_l"] <= CRITICAL), None)
    if crossing:
        outlook = "CROSSING_EXPECTED"
    elif len(valid) == len(HORIZONS):
        outlook = "NO_CROSSING_EXPECTED"
    else:
        outlook = "DATA_UNAVAILABLE"
    return state, outlook, (crossing["target_timestamp_utc"] if crossing else None)
