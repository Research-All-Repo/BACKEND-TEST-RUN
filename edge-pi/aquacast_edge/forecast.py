"""DO forecasts for +30, +60, +90 and +120 minutes: one XGBoost regression model per horizon.

The model file (aquacast-do-xgb.json) holds the four XGBoost models plus their name, version and
training dates. Which file is used, first match wins:
  1. AQUACAST_MODEL_FILE in /etc/aquacast/edge.env (only if you want a specific file)
  2. /var/lib/aquacast/models/aquacast-do-xgb.json   made on this Pi by `sudo aquacast-edge train --install`
  3. /opt/aquacast-edge/models/aquacast-do-xgb.json  the initial model shipped with the program
If none can be loaded, a simple placeholder (persistence with a damped trend) runs instead and the
log says so; the dashboard's Model Evaluation page shows which model made each forecast.

predict() needs no extra packages: xgbtree.py walks the XGBoost trees in plain Python.
(Training does need xgboost + numpy: see train.py.)

Each history item: {"timestamp_utc": "...Z", "do_mg_l": 5.8 or None, "water_temp_c": 28.1 or None, ...}
oldest first; the last item is the current reading. A reading whose DO is not VALID has do_mg_l = None.
"""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from pathlib import Path

from . import features
from .xgbtree import XGBRegressor

log = logging.getLogger("forecast")
HISTORY_HOURS = 6        # how much history predict() receives
MIN_READINGS = 3         # fewer valid readings than this -> INSUFFICIENT_HISTORY
MODEL_FILE_NAME = "aquacast-do-xgb.json"
BUNDLE_FORMAT = "aquacast-xgb/1"
MODELS = {}              # horizon -> XGBRegressor
INFO = {}                # horizon -> (path, bundle metadata) of the loaded model


class InsufficientHistory(Exception):
    pass


def candidate_files(cfg, horizon):
    files = []
    explicit = cfg.model_files.get(horizon) or cfg.model_file
    if explicit:
        files.append(Path(explicit))
    files.append(Path(cfg.data_dir) / "models" / MODEL_FILE_NAME)
    files.append(Path(__file__).resolve().parent.parent / "models" / MODEL_FILE_NAME)
    return files


def _read_bundle(path):
    b = json.loads(Path(path).read_text())
    if b.get("format") != BUNDLE_FORMAT:
        raise ValueError(f"not an AquaCast XGBoost model file (format {b.get('format')!r})")
    if b.get("features") != features.FEATURES:
        raise ValueError("the model was trained with different inputs than this program version computes")
    return b


def load_model(cfg):
    """Load the newest usable model file once at start-up (falls back per horizon)."""
    MODELS.clear()
    INFO.clear()
    cache = {}
    for hz in (30, 60, 90, 120):
        for path in candidate_files(cfg, hz):
            if not path.is_file() or cache.get(path, 0) is None:
                continue
            try:
                if path not in cache:
                    cache[path] = None
                    cache[path] = _read_bundle(path)
                b = cache[path]
                MODELS[hz] = XGBRegressor(b["horizons"][str(hz)])
                INFO[hz] = (str(path), {k: v for k, v in b.items() if k not in ("horizons", "metrics")})
                break
            except Exception as e:  # noqa: BLE001  a broken file must never stop the readings
                log.error("model file %s cannot be used for +%s min: %s", path, hz, e)
        if hz not in MODELS:
            log.warning("no XGBoost model for +%s min: using the placeholder forecast", hz)
    if MODELS:
        p, meta = INFO[min(INFO)]
        log.info("forecast model %s %s (%s)", meta.get("name"), meta.get("version"), p)


def predict(history, horizon_minutes: int) -> float:
    pts = [h for h in history if h["do_mg_l"] is not None]
    if len(pts) < MIN_READINGS:
        raise InsufficientHistory(f"need {MIN_READINGS} valid readings, have {len(pts)}")
    model = MODELS.get(horizon_minutes)
    if model is None:
        return placeholder(pts, horizon_minutes)
    x = features.from_history(history)
    change = model.predict(x)
    return max(0.0, min(20.0, round(x[0] + change, 3)))


def placeholder(pts, horizon_minutes):
    """Persistence with a damped trend: only used when no model file can be loaded."""
    last = pts[-1]["do_mg_l"]
    recent = pts[-4:]
    slope_per_10min = (recent[-1]["do_mg_l"] - recent[0]["do_mg_l"]) / max(1, len(recent) - 1)
    steps = horizon_minutes / 10
    damping = 0.5 if horizon_minutes <= 60 else 0.3
    return max(0.0, round(last + slope_per_10min * steps * damping, 2))


MODEL_NAMESPACE = uuid.UUID("6f1c3a52-6a8e-4c39-9a51-7b0d2c1e9a10")


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
        if hz in INFO:   # the XGBoost model file: its own name, version and training dates
            path, meta = INFO[hz]
            digest = file_hash(path)
            name, algo, version = meta.get("name") or cfg.model_name, meta.get("algorithm") or "XGBoost regression", meta.get("version") or "1"
            start, end = meta.get("training_start_utc") or cfg.model_training_start, meta.get("training_end_utc") or cfg.model_training_end
        else:            # placeholder
            path, digest = "", file_hash("")
            name, algo, version = cfg.model_name, cfg.model_algorithm, cfg.model_version
            start, end = cfg.model_training_start, cfg.model_training_end
        out[hz] = {
            "model_id": str(uuid.uuid5(MODEL_NAMESPACE, f"{digest}:{hz}:{version}")),
            "horizon_minutes": hz,
            "model_name": f"{name} (+{hz} min)",
            "algorithm": algo,
            "version": version,
            "training_start_utc": start,
            "training_end_utc": end,
            "model_file_name": Path(path).name if path else "placeholder (built-in)",
            "model_file_hash": f"sha256:{digest}",
        }
    return out
