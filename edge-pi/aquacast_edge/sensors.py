"""Sensor reading, connected to the group's PD-1.0 hardware driver.

The sensors are read with the SAME driver and the SAME rules as the group's aquacast_logger.py:

  aquacast_hardware_pd1.Hardware(port, light_address, do_address, baud)
      .sht20()   air temperature °C + relative humidity %          (I2C)
      .bmp280()  pressure in kPa (stored as hPa = kPa x 10)         (I2C)
      .light()   light in lux, Modbus address 1                     (RS485)
      .ph()      pH, ph_voltage_v, ph_adc_raw                        (ADC on I2C)
      .do()      DO mg/L, DO saturation %, water temperature °C, Modbus address 2 (RS485)

Copied from aquacast_logger.py without changes in meaning: the read order, the 0.3 s pause between
sensors, closing the RS485 port after a light/DO failure (the driver reopens it), the error
classification (CRC -> CRC_ERROR, serial/Modbus/OSError -> COMMUNICATION_ERROR, other -> SENSOR_ERROR,
pH never CRC_ERROR), the validity ranges, the pH 0-3 V electrical check, the ADC range check, the
non-finite (NaN) handling, AQUACAST_PH_ENABLED=0 for disconnected pH hardware, and the calibration labels.

The driver file itself (aquacast_hardware_pd1.py) goes in edge-pi/hardware/; install.sh copies it next
to this program. AQUACAST_SENSOR_MODE=demo makes fake readings instead (testing without sensors).
"""
from __future__ import annotations

import importlib
import logging
import math
import random
import time
from datetime import datetime, timezone

log = logging.getLogger("sensors")

SENSORS = ["sht20", "bmp280", "light", "ph", "do"]
PH_CALIBRATION = "2026-10-12_6.86_4.01_linear_no_ATC"
DO_CALIBRATION = "user_100pct_only_zero_not_verified"
# (dashboard field, driver key, status field, sensor, scale, lowest valid, highest valid)
FIELDS = [
    ("do_mg_l", "do_mg_l", "do_mg_l_status", "do", 1, 0, 20),
    ("do_saturation_pct", "do_saturation_pct", "do_saturation_status", "do", 1, 0, 200),
    ("water_temp_c", "water_temperature_c", "water_temp_status", "do", 1, 0, 40),
    ("ph_value", "ph", "ph_status", "ph", 1, 0, 14),
    ("light_lux", "light_lux", "light_status", "light", 1, 0, None),
    ("air_temp_c", "air_temperature_c", "air_temp_status", "sht20", 1, -40, 125),
    ("relative_humidity_pct", "relative_humidity_pct", "humidity_status", "sht20", 1, 0, 100),
    ("atmospheric_pressure_hpa", "pressure_kpa", "pressure_status", "bmp280", 10, 300, 1100),
]
STATUS_FIELD = {f[0]: f[2] for f in FIELDS}
# which bus each sensor uses (for the RS485 / I2C status in the dashboard's health card)
BUS = {"light": "rs485", "do": "rs485", "sht20": "i2c", "bmp280": "i2c", "ph": "i2c"}


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def classify_error(error, sensor):
    """Same rules as aquacast_logger.classify_error."""
    text = str(error).lower()
    name = type(error).__name__.lower()
    if "crc" in text or "checksum" in text:
        return "SENSOR_ERROR" if sensor == "ph" else "CRC_ERROR"
    if isinstance(error, OSError) or any(x in name for x in ("serial", "noresponse", "invalidresponse", "modbus")):
        return "COMMUNICATION_ERROR"
    return "SENSOR_ERROR"


class Sensors:
    """Owns the hardware driver (opened once, reopened after a failure)."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.hardware = None
        self.open_error = None

    # ---------- hardware ----------
    def _hardware(self):
        if self.hardware is None:
            try:
                mod = importlib.import_module("aquacast_hardware_pd1")
            except ModuleNotFoundError as e:
                if e.name != "aquacast_hardware_pd1":
                    raise RuntimeError(f"the sensor driver needs the Python package '{e.name}': add it to requirements.txt and run install.sh again") from None
                raise RuntimeError("aquacast_hardware_pd1.py not found: copy it into edge-pi/hardware/ and run install.sh again") from None
            c = self.cfg
            self.hardware = mod.Hardware(c.serial_port, c.light_address, c.do_address, c.baud)
            log.info("sensor driver opened (port %s, light address %s, DO address %s, %s baud)", c.serial_port, c.light_address, c.do_address, c.baud)
        return self.hardware

    def close(self):
        if self.hardware is not None:
            try:
                self.hardware.close()
            except Exception:  # noqa: BLE001
                pass
            self.hardware = None

    # ---------- one acquisition (aquacast_logger.collect) ----------
    def collect(self):
        payload = {"sensors": {}, "ph_calibration": PH_CALIBRATION, "do_calibration": DO_CALIBRATION}
        try:
            hw = self._hardware()
        except Exception as e:  # noqa: BLE001 - driver missing / port not there: every sensor fails this cycle
            self.hardware = None
            if str(e) != self.open_error:
                log.error("sensors cannot be opened: %s", e)
            self.open_error = str(e)
            status = "MISSING" if "not found" in str(e) or "needs the Python package" in str(e) else "COMMUNICATION_ERROR"
            for name in SENSORS:
                payload["sensors"][name] = {"status": "error", "quality_status": status, "measured_utc": _now_iso(), "error": str(e)}
            return payload
        self.open_error = None
        for name in SENSORS:
            if name == "ph" and not self.cfg.ph_enabled:
                payload["sensors"]["ph"] = {"status": "error", "quality_status": "MISSING", "measured_utc": _now_iso(),
                                            "error": "pH acquisition deliberately disabled"}
                continue
            try:
                values = getattr(hw, name)() or {}
                payload.update(values)
                payload["sensors"][name] = {"status": "ok", "measured_utc": _now_iso()}
            except Exception as error:  # noqa: BLE001 - one sensor failing must not stop the others
                payload["sensors"][name] = {"status": "error", "quality_status": classify_error(error, name),
                                            "measured_utc": _now_iso(), "error": str(error)}
                log.warning("%s read failed: %s", name, error)
                if name in ("light", "do") and getattr(hw, "rs485", None) is not None:
                    try:
                        hw.rs485.serial.close()
                    except Exception:  # noqa: BLE001
                        pass
                    hw.rs485 = None  # the driver reopens the RS485 port on the next read
            time.sleep(0.3)
        for key, value in list(payload.items()):  # NaN / infinity cannot be stored: keep the failure visible
            if isinstance(value, float) and not math.isfinite(value):
                payload[key] = None
                for _, source, _, sensor, *_ in FIELDS:
                    if source == key and sensor in payload["sensors"]:
                        payload["sensors"][sensor].setdefault("nonfinite_fields", []).append(key)
        return payload


def record_status(row) -> str:
    valid = sum(row[f[2]] == "VALID" for f in FIELDS)
    return "COMPLETE" if valid == len(FIELDS) else ("PARTIAL" if valid else "FAILED")


def normalize(payload):
    """Driver payload -> dashboard observation fields (aquacast_logger.normalize + save_cycle rules)."""
    row = {}
    for target, source, status, sensor, scale, lower, upper in FIELDS:
        result = payload.get("sensors", {}).get(sensor, {})
        raw = payload.get(source)
        row[target] = None
        if result.get("status") not in ("ok", "VALID"):
            row[status] = result.get("quality_status", "SENSOR_ERROR" if result else "MISSING")
        elif source in result.get("nonfinite_fields", []):
            row[status] = "SENSOR_ERROR"
        elif raw is None:
            row[status] = "MISSING"
        elif not isinstance(raw, (int, float)) or isinstance(raw, bool) or not math.isfinite(raw):
            row[status] = "SENSOR_ERROR"
        else:
            value = float(raw) * scale
            if not math.isfinite(value):
                row[status] = "SENSOR_ERROR"
                continue
            row[target] = round(value, 4)
            row[status] = "VALID" if value >= lower and (upper is None or value <= upper) else "OUT_OF_RANGE"
    row["ph_voltage_mv"] = None
    voltage = payload.get("ph_voltage_v")
    if isinstance(voltage, (int, float)) and not isinstance(voltage, bool) and math.isfinite(voltage):
        if voltage >= 0:
            row["ph_voltage_mv"] = round(voltage * 1000.0, 3)
        if not 0 <= voltage <= 3 and row["ph_status"] == "VALID":
            row["ph_status"] = "OUT_OF_RANGE"
    row["ph_adc_raw"] = None
    raw = payload.get("ph_adc_raw")
    if isinstance(raw, int) and not isinstance(raw, bool) and -32768 <= raw <= 32767:
        row["ph_adc_raw"] = raw
    elif raw is not None and row["ph_status"] == "VALID":
        row["ph_status"] = "SENSOR_ERROR"
    if row["ph_status"] == "CRC_ERROR":
        row["ph_status"] = "SENSOR_ERROR"  # pH has no CRC status in the data dictionary
    record = record_status(row)

    buses = {}
    for bus in ("rs485", "i2c"):
        used = [s for s, b in BUS.items() if b == bus and (payload["sensors"].get(s) or {}).get("quality_status") != "MISSING"]
        bad = [s for s in used if (payload["sensors"].get(s) or {}).get("status") != "ok"]
        buses[bus] = "OK" if not bad else ("FAILED" if len(bad) == len(used) else "DEGRADED")
    return row, buses, record


def demo_payload(do_shift=0.0):
    """Fake but realistic pond values (AQUACAST_SENSOR_MODE=demo) in the driver's format."""
    now = datetime.now(timezone.utc)
    h = (now.hour + 8 + now.minute / 60) % 24  # Manila time
    do = max(0.2, 5.6 + 2.2 * math.sin(2 * math.pi * (h - 10) / 24) + random.gauss(0, 0.05) - do_shift)
    wt = 28 + 1.6 * math.sin(2 * math.pi * (h - 9) / 24)
    sat = 14.62 - 0.3898 * wt + 0.006969 * wt ** 2 - 0.00005897 * wt ** 3
    ok = {"status": "ok", "measured_utc": _now_iso()}
    return {
        "sensors": {s: dict(ok) for s in SENSORS}, "ph_calibration": "demo", "do_calibration": "demo",
        "do_mg_l": round(do, 2), "do_saturation_pct": round(do / sat * 100, 1), "water_temperature_c": round(wt, 2),
        "ph": round(7.5 + 0.4 * math.sin(2 * math.pi * (h - 10) / 24), 2), "ph_voltage_v": 1.59, "ph_adc_raw": 8480,
        "light_lux": round(max(0.0, 60000 * math.sin(math.pi * (h - 6) / 12)) if 6 < h < 18 else 1.0, 0),
        "air_temperature_c": round(27 + 4 * math.sin(2 * math.pi * (h - 9) / 24), 2), "relative_humidity_pct": 75.0, "pressure_kpa": 101.01,
    }


def read_all(sensors, mode="real", demo_do_shift=0.0):
    """One reading of every sensor. Returns (observation fields, bus statuses, record_status, raw payload)."""
    payload = demo_payload(demo_do_shift) if mode == "demo" else sensors.collect()
    row, buses, record = normalize(payload)
    return row, buses, record, payload
