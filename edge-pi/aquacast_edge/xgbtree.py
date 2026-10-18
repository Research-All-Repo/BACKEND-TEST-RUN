"""Runs a trained XGBoost regression model without installing XGBoost.

XGBoost saves a model as JSON (booster.save_model("x.json")): a list of decision trees. A
prediction is base_score + the sum of the leaf each tree lands in. That is all this does, in plain
Python, so the Raspberry Pi needs no extra packages to forecast (training does need xgboost).
tests/test_edge.py checks that this gives exactly the same numbers as XGBoost itself.
"""
from __future__ import annotations

import math
import struct
from array import array


def _base_score(learner) -> float:
    v = learner["learner_model_param"]["base_score"]
    return float(str(v).strip("[]"))  # "5E-1" (XGBoost 2.x) or "[5E-1]" (3.x)


class Tree:
    __slots__ = ("left", "right", "feat", "cond", "default_left")

    def __init__(self, t):
        # compact arrays: a few MB of model stay small in the Pi's memory
        self.left = array("i", t["left_children"])
        self.right = array("i", t["right_children"])
        self.feat = array("i", t["split_indices"])
        # thresholds are 32-bit floats inside XGBoost; JSON prints them as short decimals (29.06),
        # so turn them back into the exact 32-bit value, or a reading of exactly 29.06 goes the wrong way
        self.cond = array("d", (_f32(float(c)) for c in t["split_conditions"]))
        self.default_left = bytes(1 if d else 0 for d in t["default_left"])

    def leaf(self, x) -> float:
        i = 0
        left, right, feat, cond, dl = self.left, self.right, self.feat, self.cond, self.default_left
        while left[i] != -1:
            v = x[feat[i]]
            if v != v:  # NaN = missing: XGBoost's learned default direction
                i = left[i] if dl[i] else right[i]
            else:
                i = left[i] if v < cond[i] else right[i]
        return cond[i]  # for a leaf, split_conditions holds the leaf value


class XGBRegressor:
    """model = XGBRegressor(json.load(open("model.json")));  model.predict([f1, f2, ...])"""

    def __init__(self, model_json: dict):
        learner = model_json["learner"]
        obj = learner.get("objective", {}).get("name", "reg:squarederror")
        if obj not in ("reg:squarederror", "reg:pseudohubererror", "reg:absoluteerror"):
            raise ValueError(f"unsupported XGBoost objective {obj!r} (needs a plain regression model)")
        gb = learner["gradient_booster"]
        if gb.get("name") != "gbtree":
            raise ValueError("only tree models (gbtree) are supported")
        self.base = _base_score(learner)
        self.trees = [Tree(t) for t in gb["model"]["trees"]]
        self.n_features = int(learner["learner_model_param"].get("num_feature", 0))

    def predict(self, x) -> float:
        if self.n_features and len(x) != self.n_features:
            raise ValueError(f"model expects {self.n_features} features, got {len(x)}")
        x = [float("nan") if v is None or (isinstance(v, float) and math.isnan(v)) else float(v) for v in x]
        # XGBoost works in 32-bit floats: round the inputs the same way so splits match exactly
        x = [_f32(v) for v in x]
        return self.base + math.fsum(t.leaf(x) for t in self.trees)


def _f32(v: float) -> float:
    if v != v:
        return v
    return struct.unpack("f", struct.pack("f", v))[0]
