"""Train / retrain the XGBoost DO forecast (one model per horizon: +30, +60, +90, +120 min).

On the Raspberry Pi (normal use, after the pond has some days of readings):

    sudo aquacast-edge train                 train on this pond's readings, show the accuracy report
    sudo aquacast-edge train --install       ... and switch to the new model if it is more accurate
    sudo aquacast-edge train --rollback      go back to the model used before the last --install

Options: --since "2026-10-20 08:00"  ignore readings before this (e.g. setup / probe tests), local time
         --csv FILE                  also use a dashboard export (Export -> Sensor readings), repeatable
         --from-scratch              also try a model built fresh from simulated + this pond's data

How it decides: the newest 25% of the pond's readings are kept aside as a test the models never
train on. The installed model, an updated copy of it and (with --from-scratch, or automatically
after 14 days of data) a fresh model are compared on that test, horizon by horizon. A new model is
installed only where it beats the current one; otherwise the current model stays.

Developers (any computer with `pip install xgboost numpy`):
    python -m aquacast_edge train --synthetic-only --out models     build the initial model
"""
from __future__ import annotations

import csv
import json
import math
import os
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import features as F

HORIZONS = (30, 60, 90, 120)
MODEL_FILE_NAME = "aquacast-do-xgb.json"
FORMAT = "aquacast-xgb/1"
EXIT_INSTALLED = 10  # tells the aquacast-edge command to restart the service
PARAMS = {
    "objective": "reg:squarederror", "eval_metric": "mae", "tree_method": "hist",
    "max_depth": 5, "eta": 0.15, "subsample": 0.8, "colsample_bytree": 0.8,
    "min_child_weight": 10, "lambda": 1.0,
}
FINE_TUNE_PARAMS = dict(PARAMS, eta=0.03, max_depth=4, min_child_weight=20)
MIN_REAL_DAYS = 2.0
SCRATCH_AUTO_DAYS = 14.0
MIN_GAIN = 0.02      # a new model must be at least 2% more accurate (MAE) to replace the current one
MISS_COST = 3.0      # low-DO warning cost: a missed drop to <= 3.0 mg/L counts as much as 3 false alarms;
MAX_COST_RISE = 0.05  # a new model may not raise that cost by more than 5% (safety before average accuracy)
LOW_FOCUS_DO = 4.0   # training counts readings heading to <= 4.0 mg/L three times: the dangerous
LOW_WEIGHT = 3.0     # nights matter more than the exact peak on a sunny afternoon


def _np():
    try:
        import numpy as np
        import xgboost as xgb
    except ImportError as e:
        raise SystemExit(
            f"Training needs numpy and xgboost ({e.name} is missing).\n"
            "On the Raspberry Pi:  sudo /opt/aquacast-edge/venv/bin/pip install -r /opt/aquacast-edge/requirements-train.txt\n"
            "Forecasting itself does not need them.") from None
    return np, xgb


# ------------------------------------------------------------------ data
def samples(times, do, temp):
    """Regular 10-minute series -> (X rows, targets {h: [change or nan]}, sample times, placeholder preds {h: [...]})"""
    n = len(times)
    nan = float("nan")
    X, T, Y, B = [], [], {h: [] for h in HORIZONS}, {h: [] for h in HORIZONS}
    val = [None if v is None or v != v else float(v) for v in do]
    tmp = [None if v is None or v != v else float(v) for v in temp]
    for i in range(n):
        if val[i] is None:
            continue
        w_do = [val[i - k] if i - k >= 0 else None for k in range(F.SPAN + 1)]
        w_t = [tmp[i - k] if i - k >= 0 else None for k in range(F.SPAN + 1)]
        X.append(F.build(w_do, w_t, times[i]))
        T.append(times[i])
        recent = [v for v in reversed(w_do[:F.SPAN + 1]) if v is not None][-4:]
        for h in HORIZONS:
            j = i + h // F.STEP_MIN
            Y[h].append(val[j] - val[i] if j < n and val[j] is not None else nan)
            # the old placeholder (persistence with a damped trend), for comparison in the report
            if len(recent) >= 3:
                slope = (recent[-1] - recent[0]) / max(1, len(recent) - 1)
                B[h].append(slope * (h / 10) * (0.5 if h <= 60 else 0.3))
            else:
                B[h].append(nan)
    return X, Y, T, B


def to_grid(readings):
    """[(datetime, do or None, temp or None)] -> regular 10-minute (times, do, temp) with None in gaps."""
    by_slot = {}
    for t, d, w in readings:
        slot = t.replace(second=0, microsecond=0) - timedelta(minutes=t.minute % F.STEP_MIN)
        by_slot[slot] = (d, w)
    if not by_slot:
        return [], [], []
    first, last = min(by_slot), max(by_slot)
    times, do, temp = [], [], []
    t = first
    while t <= last:
        d, w = by_slot.get(t, (None, None))
        times.append(t)
        do.append(d)
        temp.append(w)
        t += timedelta(minutes=F.STEP_MIN)
    return times, do, temp


def _valid_do(v, status):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if status not in (None, "", "VALID") or not (0.0 <= x <= 20.0):
        return None
    return x


def _valid_temp(v, status):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if status in (None, "", "VALID") and -5 < x < 50 else None


def load_sqlite(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    if "readings" in tables:      # the edge program's database
        q = "select timestamp_utc, do_mg_l, do_status as s1, water_temp_c, water_temp_status as s2 from readings"
    elif "raw_observations" in tables:   # the old aquacast_logger.py database
        q = "select timestamp_utc, do_mg_l, do_mg_l_status as s1, water_temp_c, water_temp_status as s2 from raw_observations"
    else:
        raise SystemExit(f"{path}: no readings table found")
    out = []
    for r in con.execute(q):
        try:
            out.append((F.parse_utc(r["timestamp_utc"]), _valid_do(r["do_mg_l"], r["s1"]), _valid_temp(r["water_temp_c"], r["s2"])))
        except (TypeError, ValueError):
            pass
    con.close()
    return out


def load_csv(path):
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            try:
                out.append((F.parse_utc(r["timestamp_utc"]), _valid_do(r.get("do_mg_l"), r.get("do_mg_l_status")),
                            _valid_temp(r.get("water_temp_c"), r.get("water_temp_status"))))
            except (KeyError, TypeError, ValueError):
                pass
    return out


def parse_local(s):
    """'2026-10-20 08:00' (pond-local time) or an ISO time with a zone -> UTC datetime"""
    s = s.strip()
    if s.endswith("Z") or "+" in s[10:] or "-" in s[10:]:
        return F.parse_utc(s)
    d = datetime.fromisoformat(s.replace(" ", "T"))
    return (d - timedelta(hours=F.LOCAL_UTC_OFFSET_H)).replace(tzinfo=timezone.utc)


# ------------------------------------------------------------------ model bundle
def find_model_file(cfg):
    """The model file the Pi uses now (same order as forecast.py)."""
    from .forecast import candidate_files
    return next((p for p in candidate_files(cfg, 30) if p.is_file()), None)


def booster_json(booster):
    return json.loads(bytes(booster.save_raw(raw_format="json")).decode())


def booster_from_json(xgb, j):
    b = xgb.Booster()
    b.load_model(bytearray(json.dumps(j).encode()))
    return b


def iso(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ evaluation
def evaluate(np, pred_change, true_change, do_now, base_change=None):
    """Accuracy of one horizon on the test readings."""
    m = ~np.isnan(true_change) & ~np.isnan(pred_change)
    if m.sum() == 0:
        return None
    pred = do_now[m] + pred_change[m]
    act = do_now[m] + true_change[m]
    err = pred - act
    pers = np.abs(true_change[m])  # persistence: "DO stays as it is now"
    r = {
        "n": int(m.sum()),
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(np.sqrt(np.mean(err ** 2))),
        "within_0_5": float(np.mean(np.abs(err) <= 0.5)),
        "persistence_mae": float(np.mean(pers)),
    }
    r["skill_vs_persistence"] = 1 - r["mae"] / r["persistence_mae"] if r["persistence_mae"] > 0 else 0.0
    low = act <= 3.0
    flagged = pred <= 3.0
    r["low_do_missed"] = int((low & ~flagged).sum())
    r["false_alarms"] = int((flagged & ~low).sum())
    r["warning_cost"] = MISS_COST * r["low_do_missed"] + r["false_alarms"]
    if low.sum():
        r["low_do_cases"] = int(low.sum())
        r["low_do_caught"] = float(np.mean(pred[low] <= 3.0))
    if flagged.sum():
        r["low_do_forecasts_correct"] = float(np.mean(act[flagged] <= 3.0))
    return r


def fmt_table(title, rows):
    """rows: {name: {h: metrics}}"""
    lines = [title, f"  {'model':<26}{'horizon':>8}{'MAE':>8}{'RMSE':>8}{'±0.5':>7}{'vs no-change':>14}{'low DO caught':>15}{'false alarms':>14}  n"]
    for name, by_h in rows.items():
        for h in HORIZONS:
            r = by_h.get(h)
            if not r:
                continue
            low = f"{r['low_do_caught'] * 100:.0f}% of {r['low_do_cases']}" if "low_do_cases" in r else "-"
            fa = f"{(1 - r['low_do_forecasts_correct']) * 100:.0f}%" if "low_do_forecasts_correct" in r else "-"
            lines.append(f"  {name:<26}{'+' + str(h):>8}{r['mae']:>8.3f}{r['rmse']:>8.3f}{r['within_0_5'] * 100:>6.0f}%"
                         f"{r['skill_vs_persistence'] * 100:>+13.0f}%{low:>15}{fa:>14}  {r['n']}")
    return "\n".join(lines)


# ------------------------------------------------------------------ training
def fit(np, xgb, X, y, w=None, Xv=None, yv=None, base=None, params=PARAMS, rounds=300, early=30, nthread=None):
    m = ~np.isnan(y)
    focus = np.where(X[:, 0] + np.nan_to_num(y, nan=99.0) <= LOW_FOCUS_DO, LOW_WEIGHT, 1.0)
    w = focus if w is None else w * focus
    d = xgb.DMatrix(X[m], label=y[m], weight=w[m], missing=np.nan, nthread=nthread or -1)
    p = dict(params, nthread=nthread or os.cpu_count() or 2, seed=7)
    evals, kw = [], {}
    if Xv is not None:
        mv = ~np.isnan(yv)
        dv = xgb.DMatrix(Xv[mv], label=yv[mv], missing=np.nan)
        evals = [(dv, "valid")]
        kw = {"early_stopping_rounds": early}
    b = xgb.train(p, d, num_boost_round=rounds, evals=evals, xgb_model=base, verbose_eval=False, **kw)
    if Xv is not None:
        added = b.best_iteration + 1 - (base.num_boosted_rounds() if base is not None else 0)
        b = b[: b.best_iteration + 1]
        return b, max(0, added)
    return b, rounds


def predict(np, xgb, booster, X):
    return booster.predict(xgb.DMatrix(X, missing=np.nan))


def stack(np, parts):
    X = np.array([r for p in parts for r in p[0]], dtype=np.float32) if parts else np.zeros((0, len(F.FEATURES)), np.float32)
    Y = {h: np.array([v for p in parts for v in p[1][h]], dtype=np.float64) for h in HORIZONS}
    B = {h: np.array([v for p in parts for v in p[3][h]], dtype=np.float64) for h in HORIZONS}
    T = [t for p in parts for t in p[2]]
    return X, Y, T, B


def synthetic_set(np, ponds, days, seed):
    from .synthetic import simulate
    series = simulate(n_ponds=ponds, days=days, seed=seed)
    return [samples(s["times"], list(s["do"]), list(s["temp"])) for s in series]


def make_bundle(boosters, meta, metrics, xgb):
    return {
        "format": FORMAT,
        "name": meta["name"], "algorithm": "XGBoost regression", "version": meta["version"],
        "built_at_utc": iso(datetime.now(timezone.utc)),
        "training_start_utc": meta["training_start_utc"], "training_end_utc": meta["training_end_utc"],
        "training_data": meta["training_data"],
        "target": "change in DO from now to now + horizon (mg/L)",
        "features": F.FEATURES, "local_utc_offset_h": F.LOCAL_UTC_OFFSET_H,
        "xgboost_version": xgb.__version__,
        "metrics": metrics,
        "horizons": {str(h): boosters[h] for h in HORIZONS},
    }


def write_bundle(bundle, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(bundle, separators=(",", ":")))
    os.replace(tmp, path)


def train_synthetic(args, np, xgb):
    """The initial model: trained on simulated ponds only."""
    print(f"simulating {args.ponds} ponds x {args.days} days ...")
    sets = synthetic_set(np, args.ponds, args.days, args.seed)
    n = len(sets)
    n_test = max(2, n // 10)
    n_val = max(2, n // 10)
    tr, va, te = sets[: n - n_val - n_test], sets[n - n_val - n_test: n - n_test], sets[n - n_test:]
    Xtr, Ytr, _, _ = stack(np, tr)
    Xva, Yva, _, _ = stack(np, va)
    Xte, Yte, _, Bte = stack(np, te)
    print(f"training samples {len(Xtr)}, validation {len(Xva)}, test {len(Xte)} (test ponds never seen in training)")
    boosters, rounds, results = {}, {}, {"XGBoost": {}, "old placeholder": {}, "no-change (persistence)": {}}
    for h in HORIZONS:
        b, r = fit(np, xgb, Xtr, Ytr[h], Xv=Xva, yv=Yva[h])
        boosters[h], rounds[h] = b, r
        p = predict(np, xgb, b, Xte)
        results["XGBoost"][h] = evaluate(np, p, Yte[h], Xte[:, 0])
        results["old placeholder"][h] = evaluate(np, Bte[h], Yte[h], Xte[:, 0])
        results["no-change (persistence)"][h] = evaluate(np, np.zeros_like(Yte[h]), Yte[h], Xte[:, 0])
        print(f"  +{h} min: {r} trees, test MAE {results['XGBoost'][h]['mae']:.3f} mg/L")
    report = [fmt_table(f"Held-out simulated ponds ({n_test} ponds x {args.days} days, never used in training)", results)]
    metrics = {"synthetic_test": {k: {str(h): v for h, v in by.items()} for k, by in results.items()}}
    for path in args.test_csv or []:
        times, do, temp = to_grid(load_csv(path))
        X, Y, _, B = stack(np, [samples(times, do, temp)])
        ext = {"XGBoost": {}, "old placeholder": {}, "no-change (persistence)": {}}
        for h in HORIZONS:
            ext["XGBoost"][h] = evaluate(np, predict(np, xgb, boosters[h], X), Y[h], X[:, 0])
            ext["old placeholder"][h] = evaluate(np, B[h], Y[h], X[:, 0])
            ext["no-change (persistence)"][h] = evaluate(np, np.zeros_like(Y[h]), Y[h], X[:, 0])
        days = len(times) / 144
        report.append(fmt_table(f"{Path(path).name}: {days:.0f} days, a different pond model (not used in training)", ext))
        metrics[f"external:{Path(path).name}"] = {k: {str(h): v for h, v in by.items()} for k, by in ext.items()}
    now = datetime.now(timezone.utc)
    meta = {"name": "AquaCast DO XGBoost", "version": now.strftime("xgb-%Y%m%d-sim"),
            "training_start_utc": iso(now), "training_end_utc": iso(now),
            "training_data": f"simulated tilapia ponds: {len(tr)} ponds x {args.days} days (initial model, not yet adapted to the real pond)"}
    bundle = make_bundle({h: booster_json(boosters[h]) for h in HORIZONS}, meta, metrics, xgb)
    out = Path(args.out or ".") / MODEL_FILE_NAME
    write_bundle(bundle, out)
    text = "\n\n".join(report)
    (out.parent / "aquacast-do-xgb-report.txt").write_text(text + "\n")
    print("\n" + text + f"\n\nsaved {out}")
    return 0


def train_real(args, cfg, np, xgb):
    readings = []
    db = Path(args.db) if args.db else Path(cfg.db_path)
    if db.is_file() and not args.no_db:
        readings += load_sqlite(db)
    for p in args.csv or []:
        readings += load_csv(p)
    if args.since:
        since = parse_local(args.since)
        readings = [r for r in readings if r[0] >= since]
    readings = [r for r in readings if r[1] is not None]
    times, do, temp = to_grid(readings)
    X, Y, T, _ = stack(np, [samples(times, do, temp)])
    usable = int((~np.isnan(Y[30])).sum())
    days = usable / 144
    print(f"pond readings with a valid DO: {len(readings)}   usable for training: {usable} (about {days:.1f} days)")

    current_path = find_model_file(cfg)
    current = json.loads(current_path.read_text()) if current_path else None
    if current and current.get("format") != FORMAT:
        current = None
    if current is None:
        raise SystemExit("No installed XGBoost model to start from. Copy models/aquacast-do-xgb.json to the Pi and run install.sh.")
    if current.get("features") != F.FEATURES:
        print("The installed model uses different inputs than this program version; it will be compared but not fine-tuned.")
    cur_boosters = {h: booster_from_json(xgb, current["horizons"][str(h)]) for h in HORIZONS}

    if days < MIN_REAL_DAYS:
        print(f"\nNot enough real readings yet: about {days:.1f} days; training needs at least {MIN_REAL_DAYS:.0f} days of readings\n"
              "with the probe in the pond (more is better: retrain weekly). The current model stays.")
        if usable >= 30:
            res = {"installed model": {}, "no-change (persistence)": {}}
            for h in HORIZONS:
                res["installed model"][h] = evaluate(np, predict(np, xgb, cur_boosters[h], X), Y[h], X[:, 0])
                res["no-change (persistence)"][h] = evaluate(np, np.zeros_like(Y[h]), Y[h], X[:, 0])
            print("\n" + fmt_table("How the installed model did on the readings so far:", res))
        return 0

    # chronological split: train | early-stopping check | test (newest 25%)
    order = np.argsort(np.array([t.timestamp() for t in T]))
    n = len(order)
    i_test = int(n * 0.75)
    i_val = int(i_test * 0.8)
    tr, va, te = order[:i_val], order[i_val:i_test], order[i_test:]
    nthread = max(1, (os.cpu_count() or 2) - 1)   # leave one core for the running service
    # a fresh model is also tried once there is plenty of pond data, or when repeated updates made the model big
    big = max(b.num_boosted_rounds() for b in cur_boosters.values()) > 700
    scratch = args.from_scratch or days >= SCRATCH_AUTO_DAYS or big
    synth = None
    if scratch:
        print("simulating ponds for the fresh model ...")
        synth = stack(np, synthetic_set(np, 30, 20, args.seed))

    cands = {"installed model": {}, "updated (fine-tuned)": {}, "no-change (persistence)": {}}
    if scratch:
        cands["fresh (sim + pond)"] = {}
    made, extra_rounds = {}, {}
    for h in HORIZONS:
        y = Y[h]
        cands["installed model"][h] = evaluate(np, predict(np, xgb, cur_boosters[h], X[te]), y[te], X[te, 0])
        cands["no-change (persistence)"][h] = evaluate(np, np.zeros(len(te)), y[te], X[te, 0])
        if current.get("features") == F.FEATURES:
            b, r = fit(np, xgb, X[tr], y[tr], Xv=X[va], yv=y[va], base=cur_boosters[h], params=FINE_TUNE_PARAMS, rounds=150, early=30, nthread=nthread)
            made[("updated (fine-tuned)", h)], extra_rounds[("updated (fine-tuned)", h)] = b, r
            cands["updated (fine-tuned)"][h] = evaluate(np, predict(np, xgb, b, X[te]), y[te], X[te, 0])
        if scratch:
            Xs, Ys = synth[0], synth[1][h]
            real_w = max(1.0, len(Xs) / max(1, len(tr)))  # the pond counts as much as all simulated ponds together
            Xc = np.vstack([Xs, X[tr]])
            yc = np.concatenate([Ys, y[tr]])
            wc = np.concatenate([np.ones(len(Xs)), np.full(len(tr), real_w)])
            b, r = fit(np, xgb, Xc, yc, w=wc, Xv=X[va], yv=y[va], nthread=nthread)
            made[("fresh (sim + pond)", h)], extra_rounds[("fresh (sim + pond)", h)] = b, r
            cands["fresh (sim + pond)"][h] = evaluate(np, predict(np, xgb, b, X[te]), y[te], X[te, 0])

    test_days = len(te) / 144
    text = fmt_table(f"Test: the newest {test_days:.1f} days of this pond (kept aside, not used for training)", cands)
    print("\n" + text)

    # choose per horizon; a new model must beat the installed one by MIN_GAIN
    choice, notes = {}, []
    for h in HORIZONS:
        cur = cands["installed model"][h]
        best, best_mae = "installed model", (cur["mae"] if cur else math.inf)
        limit = best_mae * (1 - MIN_GAIN)
        for name in ("updated (fine-tuned)", "fresh (sim + pond)"):
            r = cands.get(name, {}).get(h)
            if not r or r["mae"] >= min(best_mae, limit):
                continue
            if cur and cur.get("low_do_cases", 0) >= 10 and r["warning_cost"] > cur["warning_cost"] * (1 + MAX_COST_RISE):
                notes.append(f"  +{h} min: {name} is closer on average but worse at low-DO warnings"
                             f" (caught {r.get('low_do_caught', 0) * 100:.0f}% vs {cur['low_do_caught'] * 100:.0f}%,"
                             f" false alarms {r['false_alarms']} vs {cur['false_alarms']}), so it is not used")
                continue
            best, best_mae = name, r["mae"]
        if args.force and best == "installed model" and ("updated (fine-tuned)", h) in made:
            best = "updated (fine-tuned)"
        choice[h] = best
    lines = ["", "Choice per horizon:"] + [f"  +{h} min: {choice[h]}" for h in HORIZONS] + notes
    print("\n".join(lines))
    text += "\n" + "\n".join(lines)
    if all(c == "installed model" for c in choice.values()):
        print("\nThe installed model is still the most accurate: nothing to change. Retrain again after more days of readings.")
        _save_report(cfg, text)
        return 0

    # refit the chosen new models on ALL the pond's readings (incl. the test days) with the same size
    all_idx = order
    boosters = {}
    for h in HORIZONS:
        name = choice[h]
        if name == "installed model":
            boosters[h] = current["horizons"][str(h)]
            continue
        k = extra_rounds[(name, h)]
        y = Y[h]
        if name == "updated (fine-tuned)":
            b, _ = fit(np, xgb, X[all_idx], y[all_idx], base=cur_boosters[h], params=FINE_TUNE_PARAMS, rounds=max(1, k), nthread=nthread)
        else:
            Xs, Ys = synth[0], synth[1][h]
            real_w = max(1.0, len(Xs) / max(1, n))
            b, _ = fit(np, xgb, np.vstack([Xs, X[all_idx]]), np.concatenate([Ys, y[all_idx]]),
                       w=np.concatenate([np.ones(len(Xs)), np.full(n, real_w)]), rounds=max(1, k), nthread=nthread)
        boosters[h] = booster_json(b)

    real_times = [r[0] for r in readings]
    now = datetime.now(timezone.utc)
    meta = {"name": "AquaCast DO XGBoost", "version": now.strftime("xgb-%Y%m%d-%H%M"),
            "training_start_utc": iso(min(real_times)), "training_end_utc": iso(max(real_times)),
            "training_data": f"this pond: {usable} readings ({days:.1f} days) on top of: {current.get('training_data', 'previous model')}"[:400]}
    metrics = {"pond_test": {k: {str(h): v for h, v in by.items()} for k, by in cands.items()},
               "choice": {str(h): choice[h] for h in HORIZONS}, "previous": current.get("metrics")}
    bundle = make_bundle(boosters, meta, metrics, xgb)
    models_dir = Path(cfg.data_dir) / "models"
    cand_path = models_dir / "candidate" / MODEL_FILE_NAME
    write_bundle(bundle, cand_path)
    _save_report(cfg, text)
    print(f"\nNew model saved: {cand_path}")
    if not args.install:
        print("Not installed yet. To use it:  sudo aquacast-edge train --install   (or re-run with --install)")
        return 0
    return install(cfg, cand_path)


def _save_report(cfg, text):
    p = Path(cfg.data_dir) / "models" / "last-training-report.txt"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"{iso(datetime.now(timezone.utc))}\n{text}\n")


def install(cfg, src):
    models_dir = Path(cfg.data_dir) / "models"
    dst = models_dir / MODEL_FILE_NAME
    prev = models_dir / "aquacast-do-xgb.previous.json"
    if dst.is_file():
        shutil.copy2(dst, prev)
    shutil.copy2(src, dst.with_suffix(".tmp"))
    os.replace(dst.with_suffix(".tmp"), dst)
    print(f"Installed {dst}. The service restarts and registers the new model in the dashboard (Model Evaluation).")
    return EXIT_INSTALLED


def rollback(cfg):
    models_dir = Path(cfg.data_dir) / "models"
    dst, prev = models_dir / MODEL_FILE_NAME, models_dir / "aquacast-do-xgb.previous.json"
    if not prev.is_file():
        if dst.is_file():
            dst.rename(models_dir / "aquacast-do-xgb.removed.json")
            print("No earlier trained model; removed the trained model, so the initial (shipped) model is used again.")
            return EXIT_INSTALLED
        print("Nothing to roll back: the initial (shipped) model is in use.")
        return 0
    os.replace(prev, dst)
    print("Rolled back to the model used before the last install.")
    return EXIT_INSTALLED


def main(args, cfg):
    if args.rollback:
        return rollback(cfg)
    np, xgb = _np()
    if args.synthetic_only:
        return train_synthetic(args, np, xgb)
    return train_real(args, cfg, np, xgb)


def add_arguments(ap):
    ap.add_argument("--install", action="store_true", help="train: switch to the new model if it is more accurate")
    ap.add_argument("--force", action="store_true", help="train --install: install the updated model even if it is not better")
    ap.add_argument("--rollback", action="store_true", help="train: go back to the previous model")
    ap.add_argument("--since", help="train: ignore readings before this local time, e.g. '2026-10-20 08:00'")
    ap.add_argument("--csv", action="append", help="train: also use a dashboard export CSV (repeatable)")
    ap.add_argument("--db", help="train: readings database (default: the edge database)")
    ap.add_argument("--no-db", action="store_true", help="train: only use the --csv files")
    ap.add_argument("--from-scratch", action="store_true", help="train: also try a fresh model (sim + pond)")
    ap.add_argument("--synthetic-only", action="store_true", help="train: build the initial model from simulated ponds")
    ap.add_argument("--ponds", type=int, default=120, help="--synthetic-only: number of simulated ponds")
    ap.add_argument("--days", type=int, default=30, help="--synthetic-only: days per pond")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", help="--synthetic-only: output folder")
    ap.add_argument("--test-csv", action="append", help="--synthetic-only: extra test series (CSV), not used in training")
