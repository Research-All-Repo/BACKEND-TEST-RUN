"""DO forecasts for +30, +60, +90 and +120 minutes. >>> YOUR TRAINED MODEL GOES HERE. <<<

Replace load_model() and predict() with your group's model code. Until then a simple
placeholder (persistence with a damped trend) runs, so the whole chain can be tested.

  load_model(cfg)                 called once at start-up; load your model file(s) here
  predict(history, horizon)       return the predicted DO in mg/L for `horizon` minutes ahead
                                  history = recent readings, oldest first (see below)
                                  raise InsufficientHistory if there are too few readings yet

Each history item: {"timestamp_utc": "...Z", "do_mg_l": 5.8 or None, "water_temp_c": 28.1 or None,
                    "observation": {all sensor fields of that reading}}
The last item is the current reading. A reading whose DO is not VALID has do_mg_l = None.

When you install a real model: set AQUACAST_MODEL_FILE (and name/algorithm/version/training dates)
in /etc/aquacast/edge.env. The Pi registers it in the dashboard automatically (Model Evaluation
then shows which model made each forecast).
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from pathlib import Path

log = logging.getLogger("forecast")
HISTORY_HOURS = 6        # how much history predict() receives
MIN_READINGS = 3         # fewer valid readings than this -> INSUFFICIENT_HISTORY
MODEL = None


class InsufficientHistory(Exception):
    pass


# ============================================================================================
def load_model(cfg):
    """Load the trained model once. Example for a scikit-learn / joblib file:
        import joblib
        global MODEL
        MODEL = joblib.load(cfg.model_file)
    """
    global MODEL
    MODEL = None  # placeholder model needs nothing


def predict(history, horizon_minutes: int) -> float:
    """Placeholder: last value plus half of the recent trend, damped for longer horizons.
    Replace with e.g.  return float(MODEL.predict([features(history)])[0])"""
    pts = [h for h in history if h["do_mg_l"] is not None]
    if len(pts) < MIN_READINGS:
        raise InsufficientHistory(f"need {MIN_READINGS} valid readings, have {len(pts)}")
    last = pts[-1]["do_mg_l"]
    recent = pts[-4:]
    slope_per_10min = (recent[-1]["do_mg_l"] - recent[0]["do_mg_l"]) / max(1, len(recent) - 1)
    steps = horizon_minutes / 10
    damping = 0.5 if horizon_minutes <= 60 else 0.3
    return max(0.0, round(last + slope_per_10min * steps * damping, 2))
# ============================================================================================


MODEL_NAMESPACE = uuid.UUID("6f1c3a52-6a8e-4c39-9a51-7b0d2c1e9a10")


def model_file_for(cfg, horizon):
    return cfg.model_files.get(horizon) or cfg.model_file


def file_hash(path: str) -> str:
    if not path:
        return hashlib.sha256(b"aquacast-placeholder-forecaster-v1").hexdigest()
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def model_records(cfg):
    """One forecast_models row per horizon. The id comes from the file hash, so the same model
    always gets the same id and a new model file automatically becomes a new registered model."""
    out = {}
    for hz in (30, 60, 90, 120):
        path = model_file_for(cfg, hz)
        digest = file_hash(path)
        out[hz] = {
            "model_id": str(uuid.uuid5(MODEL_NAMESPACE, f"{digest}:{hz}:{cfg.model_version}")),
            "horizon_minutes": hz,
            "model_name": f"{cfg.model_name} (+{hz} min)",
            "algorithm": cfg.model_algorithm,
            "version": cfg.model_version,
            "training_start_utc": cfg.model_training_start,
            "training_end_utc": cfg.model_training_end,
            "model_file_name": Path(path).name if path else "placeholder (built-in)",
            "model_file_hash": f"sha256:{digest}",
        }
    return out
