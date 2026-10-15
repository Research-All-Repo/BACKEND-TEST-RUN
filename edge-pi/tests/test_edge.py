"""Tests for the Pi program that need no hardware or server:  python3 -m unittest discover -s tests"""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aquacast_edge import config, risk, sensors  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
