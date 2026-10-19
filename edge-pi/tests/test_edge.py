"""Tests for the Pi program that need no hardware or server:  python3 -m unittest discover -s tests"""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aquacast_edge import config, features, forecast, risk, sensors  # noqa: E402
from aquacast_edge.store import Store  # noqa: E402


def fc(h, value, status="VALID"):
    return {"horizon_minutes": h, "forecast_status": status, "predicted_do_mg_l": value if status == "VALID" else None,
            "target_timestamp_utc": f"T+{h}"}


class RiskRule(unittest.TestCase):
    def test_levels(self):
        normal = [fc(h, 6.0) for h in (30, 60, 90, 120)]
        self.assertEqual(risk.assess(6.5, normal)[0], "NORMAL")
        self.assertEqual(risk.assess(6.5, normal[:3] + [fc(120, 4.5)])[0], "WATCH")
        self.assertEqual(risk.assess(4.5, normal)[0], "WARNING")
        state, outlook, crossing = risk.assess(6.5, [fc(30, 5.5), fc(60, 2.9), fc(90, 2.5), fc(120, 2.0)])
        self.assertEqual((state, outlook, crossing), ("WARNING", "CROSSING_EXPECTED", "T+60"))
        self.assertEqual(risk.assess(3.0, normal)[0], "CRITICAL")
        self.assertEqual(risk.assess(None, normal)[0], "DATA_UNAVAILABLE")
        self.assertEqual(risk.assess(6.5, normal[:3] + [fc(120, None, "MODEL_ERROR")]), ("DATA_UNAVAILABLE", "DATA_UNAVAILABLE", None))


class FakeSerial:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeHardware:
    """Behaves like aquacast_hardware_pd1.Hardware as aquacast_logger.py uses it."""
    fail = {}

    def __init__(self, *args):
        self.args = args
        self.rs485 = types.SimpleNamespace(serial=FakeSerial())
        self.closed = False

    def _maybe_fail(self, name):
        if name in self.fail:
            raise self.fail[name]

    def sht20(self):
        self._maybe_fail("sht20")
        return {"air_temperature_c": 30.0, "relative_humidity_pct": 140.0}

    def bmp280(self):
        self._maybe_fail("bmp280")
        return {"pressure_kpa": 100.95}

    def light(self):
        self._maybe_fail("light")
        return {"light_lux": 2500.0}

    def ph(self):
        self._maybe_fail("ph")
        return {"ph": 7.21, "ph_voltage_v": 1.62, "ph_adc_raw": 8650}

    def do(self):
        self._maybe_fail("do")
        return {"do_mg_l": 6.1, "do_saturation_pct": float("nan"), "water_temperature_c": 28.0}

    def close(self):
        self.closed = True


class SensorDriver(unittest.TestCase):
    def setUp(self):
        sys.modules["aquacast_hardware_pd1"] = types.SimpleNamespace(Hardware=FakeHardware)
        self.cfg = config.Config(server_url="http://localhost", edge_key="k" * 40, data_dir=Path(tempfile.gettempdir()))
        sensors.time.sleep = lambda s: None  # skip the 0.3 s pauses in tests

    def tearDown(self):
        FakeHardware.fail = {}
        sys.modules.pop("aquacast_hardware_pd1", None)

    def test_same_rules_as_the_logger(self):
        class NoResponseError(Exception):
            pass
        FakeHardware.fail = {"light": NoResponseError("No answer from slave 1"), "ph": RuntimeError("CRC mismatch")}
        drv = sensors.Sensors(self.cfg)
        obs, buses, record, payload = sensors.read_all(drv, "real")
        self.assertEqual(drv.hardware.args, ("/dev/ttyUSB0", 1, 2, 9600))
        self.assertEqual(obs["do_mg_l_status"], "VALID")
        self.assertEqual(obs["do_saturation_status"], "SENSOR_ERROR")       # NaN from the probe stays visible
        self.assertEqual(obs["light_status"], "COMMUNICATION_ERROR")        # Modbus no-response
        self.assertIsNone(drv.hardware.rs485)                               # RS485 port closed after the failure
        self.assertEqual(obs["ph_status"], "SENSOR_ERROR")                  # CRC on pH -> SENSOR_ERROR
        self.assertEqual(obs["humidity_status"], "OUT_OF_RANGE")
        self.assertAlmostEqual(obs["atmospheric_pressure_hpa"], 1009.5)     # kPa x 10
        self.assertEqual(obs["pressure_status"], "VALID")
        self.assertEqual(record, "PARTIAL")
        self.assertEqual(buses, {"rs485": "DEGRADED", "i2c": "DEGRADED"})
        self.assertEqual(payload["do_calibration"], sensors.DO_CALIBRATION)
        drv.close()

    def test_ph_values_and_disabled_ph(self):
        drv = sensors.Sensors(self.cfg)
        obs, *_ = sensors.read_all(drv, "real")
        self.assertEqual((obs["ph_value"], obs["ph_voltage_mv"], obs["ph_adc_raw"], obs["ph_status"]), (7.21, 1620.0, 8650, "VALID"))
        self.cfg.ph_enabled = False
        obs, *_ = sensors.read_all(sensors.Sensors(self.cfg), "real")
        self.assertEqual(obs["ph_status"], "MISSING")

    def test_ph_voltage_outside_0_to_3_volts(self):
        row, _, _ = sensors.normalize({"sensors": {"ph": {"status": "ok"}}, "ph": 7.0, "ph_voltage_v": 3.4})
        self.assertEqual(row["ph_status"], "OUT_OF_RANGE")

    def test_missing_driver_file(self):
        sys.modules.pop("aquacast_hardware_pd1", None)
        obs, buses, record, payload = sensors.read_all(sensors.Sensors(self.cfg), "real")
        self.assertEqual(record, "FAILED")
        self.assertEqual(obs["do_mg_l_status"], "MISSING")
        self.assertIn("not found", payload["sensors"]["do"]["error"])


class OutboxStore(unittest.TestCase):
    def test_cycle_and_commands(self):
        with tempfile.TemporaryDirectory() as d:
            st = Store(Path(d) / "t.sqlite3")
            cycle = {"observation": {"observation_id": "a", "timestamp_utc": "2026-10-15T00:00:00.000Z", "do_mg_l": 5.0,
                                     "do_mg_l_status": "VALID", "water_temp_c": 28.0, "water_temp_status": "VALID"},
                     "risk": {"current_risk_state": "WARNING"}}
            st.save_cycle(cycle)
            self.assertTrue(st.has_reading("2026-10-15T00:00:00.000Z"))
            self.assertEqual(st.count_pending("cycle"), 1)
            with self.assertRaises(Exception):
                st.save_cycle(cycle)  # same slot twice is refused, and nothing half-written remains
            self.assertEqual(st.count_pending("cycle"), 1)
            st.mark_rejected("a", "test")
            self.assertEqual(st.count_pending("cycle"), 0)
            self.assertEqual(st.retry_rejected(), 1)
            st.mark_sent(["a"])
            self.assertEqual(st.count_pending(), 0)
            st.record_command("c1", "APPLIED", {"command_id": "c1", "status": "APPLIED", "at": "2026-10-15T00:01:00Z"})
            st.record_command("c1", "APPLIED", {"command_id": "c1", "status": "APPLIED", "at": "2026-10-15T00:01:00Z"})
            self.assertEqual(st.command_handled("c1"), "APPLIED")
            self.assertEqual(st.count_pending("command_result"), 1)
            st.put("k", {"x": 1})
            self.assertEqual(st.get("k"), {"x": 1})
            self.assertTrue(st.ok())


class Settings(unittest.TestCase):
    def test_env_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("# comment\nAQUACAST_EDGE_KEY='" + "k" * 40 + "'\nAQUACAST_RELAY_PIN=17\nAQUACAST_RELAY_ACTIVE_HIGH=false\n")
        try:
            cfg = config.load(f.name)
            self.assertEqual(cfg.relay_pin, 17)
            self.assertFalse(cfg.relay_active_high)
            self.assertEqual(config.problems(cfg), [])
            self.assertEqual(cfg.cycle_minutes, 10)
        finally:
            os.unlink(f.name)


def _history(values, start="2026-10-20T10:00:00Z", temp=29.0):
    from datetime import timedelta
    t0 = features.parse_utc(start)
    return [{"timestamp_utc": (t0 + timedelta(minutes=10 * i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "do_mg_l": v, "water_temp_c": temp} for i, v in enumerate(values)]


class ForecastModel(unittest.TestCase):
    def cfg(self, data_dir, model_file=""):
        return config.Config(server_url="http://localhost", edge_key="k" * 40, data_dir=Path(data_dir), model_file=model_file)

    def test_features_handle_gaps(self):
        x = features.from_history(_history([6.0, None, 5.8, 5.7, None, 5.5, 5.4]))
        self.assertEqual(len(x), len(features.FEATURES))
        self.assertAlmostEqual(x[0], 5.4)
        self.assertAlmostEqual(x[1], 5.4 - 5.5)          # d_10
        self.assertTrue(x[2] != x[2])                     # d_20: missing reading -> NaN
        self.assertAlmostEqual(x[4], 5.4 - 6.0)           # d_60
        # 11:00 UTC = 19:00 Manila
        self.assertAlmostEqual(x[14], __import__("math").sin(2 * __import__("math").pi * 19 / 24), places=6)

    def test_shipped_xgboost_model_is_used(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = self.cfg(d)
            forecast.load_model(cfg)
            self.assertEqual(sorted(forecast.MODELS), [30, 60, 90, 120])
            falling = _history([7.0 - 0.15 * i for i in range(20)], start="2026-10-20T12:00:00Z")  # evening decline
            p30, p120 = forecast.predict(falling, 30), forecast.predict(falling, 120)
            now = falling[-1]["do_mg_l"]
            self.assertTrue(0 < p120 < p30 < now, (now, p30, p120))
            rec = forecast.model_records(cfg)[60]
            self.assertEqual(rec["algorithm"], "XGBoost regression")
            self.assertEqual(rec["model_file_name"], "aquacast-do-xgb.json")
            self.assertLessEqual(rec["training_start_utc"], rec["training_end_utc"])
            with self.assertRaises(forecast.InsufficientHistory):
                forecast.predict(_history([6.0, 6.1]), 30)

    def test_broken_model_file_falls_back(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.json"
            bad.write_text("{not json")
            forecast.load_model(self.cfg(d, model_file=str(bad)))   # skipped, the shipped model is used
            self.assertEqual(len(forecast.MODELS), 4)
            self.assertNotIn("bad.json", forecast.model_records(self.cfg(d, model_file=str(bad)))[30]["model_file_name"])
            import json
            wrong = Path(d) / "wrong.json"
            wrong.write_text(json.dumps({"format": forecast.BUNDLE_FORMAT, "features": ["other"], "horizons": {}}))
            forecast.load_model(self.cfg(d, model_file=str(wrong)))
            self.assertEqual(len(forecast.MODELS), 4)

    def test_placeholder_when_no_model_at_all(self):
        with tempfile.TemporaryDirectory() as d:
            forecast.MODELS.clear()
            forecast.INFO.clear()
            self.assertAlmostEqual(forecast.predict(_history([6.0, 5.9, 5.8, 5.7]), 30), 5.55)
            self.assertEqual(forecast.model_records(self.cfg(d))[30]["model_file_name"], "placeholder (built-in)")

    def test_pure_python_matches_xgboost(self):
        try:
            import numpy as np
            import xgboost as xgb
        except ImportError:
            self.skipTest("xgboost not installed (only needed for training)")
        import json
        from aquacast_edge.xgbtree import XGBRegressor
        bundle = json.loads((Path(__file__).resolve().parent.parent / "models" / "aquacast-do-xgb.json").read_text())
        rng = np.random.default_rng(3)
        X = []
        for _ in range(300):
            vals = list(np.round(6 + np.cumsum(rng.normal(0, 0.15, 37)), 2))
            vals = [None if rng.random() < 0.1 else float(v) for v in vals]
            vals[-1] = vals[-1] or 5.0
            X.append(features.from_history(_history(vals, start=f"2026-10-20T{rng.integers(0, 24):02d}:00:00Z")))
        X = np.array(X, dtype=np.float32)
        for h in (30, 120):
            j = bundle["horizons"][str(h)]
            b = xgb.Booster()
            b.load_model(bytearray(json.dumps(j).encode()))
            ref = b.predict(xgb.DMatrix(X, missing=np.nan))
            m = XGBRegressor(j)
            mine = np.array([m.predict([float(v) for v in row]) for row in X])
            self.assertLess(float(np.abs(ref - mine).max()), 1e-4)


class BackupReading(unittest.TestCase):
    """A sensor that fails in the 10-minute reading is filled from the halfway backup reading,
    at most 3 readings in a row; after that it stays blank."""

    def make(self, d, **kw):
        from aquacast_edge.runner import Edge
        cfg = config.Config(server_url="http://localhost", edge_key="k" * 40, data_dir=Path(d), sensor_mode="demo", **kw)
        return Edge(cfg)

    def reading(self, do_ok=True, ph_ok=True, do=6.5):
        v = {f[0]: 1.0 for f in sensors.FIELDS}
        v.update({f[2]: "VALID" for f in sensors.FIELDS})
        v["do_mg_l"], v["ph_voltage_mv"], v["ph_adc_raw"] = do, 1500.0, 8000
        if not do_ok:
            v["do_mg_l"], v["do_mg_l_status"] = None, "COMMUNICATION_ERROR"
        if not ph_ok:
            v["ph_value"], v["ph_status"], v["ph_voltage_mv"], v["ph_adc_raw"] = None, "SENSOR_ERROR", None, None
        return v

    def test_fill_then_blank_after_three(self):
        from datetime import datetime, timedelta, timezone
        with tempfile.TemporaryDirectory() as d:
            e = self.make(d)
            t0 = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
            results = []
            for i in range(5):
                slot = t0 + timedelta(minutes=10 * i)
                e.backup = {"slot": slot - timedelta(minutes=5), "taken": slot - timedelta(minutes=5) + timedelta(seconds=3),
                            "values": self.reading(do=6.0 + i / 10), "payload": {}}
                v = self.reading(do_ok=False)
                fills = e.fill_from_backup(v, slot)
                results.append((v["do_mg_l_status"], v["do_mg_l"], "do_mg_l" in fills))
            self.assertEqual([r[0] for r in results[:3]], ["VALID"] * 3)
            self.assertEqual(results[0][1], 6.0)
            self.assertTrue(all(r[2] for r in results[:3]))
            self.assertEqual(results[3], ("COMMUNICATION_ERROR", None, False))   # 4th failure in a row: blank
            self.assertEqual(results[4], ("COMMUNICATION_ERROR", None, False))
            # the sensor works again -> counter resets -> a later single failure is filled again
            slot = t0 + timedelta(minutes=50)
            e.fill_from_backup(self.reading(), slot)
            slot += timedelta(minutes=10)
            e.backup = {"slot": slot - timedelta(minutes=5), "taken": slot - timedelta(minutes=5), "values": self.reading(do=5.5), "payload": {}}
            v = self.reading(do_ok=False)
            self.assertEqual(e.fill_from_backup(v, slot), {"do_mg_l": "2026-10-19T12:55:00.000Z"})
            self.assertEqual(v["do_mg_l"], 5.5)

    def test_no_fill_from_bad_or_old_backup_or_when_off(self):
        from datetime import datetime, timedelta, timezone
        slot = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as d:
            e = self.make(d)
            e.backup = {"slot": slot - timedelta(minutes=5), "taken": slot - timedelta(minutes=5), "values": self.reading(do_ok=False), "payload": {}}
            v = self.reading(do_ok=False)
            self.assertEqual(e.fill_from_backup(v, slot), {})                    # backup failed too
            e.backup = {"slot": slot - timedelta(minutes=25), "taken": slot - timedelta(minutes=25), "values": self.reading(), "payload": {}}
            v = self.reading(do_ok=False)
            self.assertEqual(e.fill_from_backup(v, slot), {})                    # backup too old
            e.backup = {"slot": slot - timedelta(minutes=5), "taken": slot - timedelta(minutes=5), "values": self.reading(), "payload": {}}
            v = self.reading(ph_ok=False)
            fills = e.fill_from_backup(v, slot)
            self.assertEqual(list(fills), ["ph_value"])                          # only the failed sensor
            self.assertEqual((v["ph_status"], v["ph_voltage_mv"], v["ph_adc_raw"]), ("VALID", 1500.0, 8000))
        with tempfile.TemporaryDirectory() as d:
            e = self.make(d, backup_reading=False)
            e.backup = {"slot": slot - timedelta(minutes=5), "taken": slot - timedelta(minutes=5), "values": self.reading(), "payload": {}}
            v = self.reading(do_ok=False)
            self.assertEqual(e.fill_from_backup(v, slot), {})

    def test_settings(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("AQUACAST_BACKUP_READING=0\nAQUACAST_BACKUP_MAX_FILLS=2\n")
        cfg = config.load(f.name)
        self.assertEqual((cfg.backup_reading, cfg.backup_max_fills), (False, 2))
        self.assertEqual((config.load("/nonexistent").backup_reading, config.load("/nonexistent").backup_max_fills), (True, 3))


if __name__ == "__main__":
    unittest.main()
