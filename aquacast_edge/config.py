"""Settings, read from /etc/aquacast/edge.env (or the file in AQUACAST_ENV_FILE).

The file is plain KEY=VALUE lines. Only root and the aquacast user can read it, because it
holds AQUACAST_EDGE_KEY. Environment variables override the file.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_ENV_FILE = "/etc/aquacast/edge.env"


def _load_env_file(path: str) -> dict:
    values = {}
    p = Path(path)
    if not p.exists():
        return values
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _int_or_none(v: str | None):
    v = (v or "").strip()
    return int(v) if v else None


@dataclass
class Config:
    server_url: str
    edge_key: str
    data_dir: Path
    cycle_minutes: int = 10
    control_poll_seconds: int = 15
    upload_batch: int = 20
    keep_days: int = 90
    min_valid_year: int = 2026
    # sensors: "real" uses sensors.py (your hardware code); "demo" makes fake readings for testing
    sensor_mode: str = "real"
    demo_do_shift: float = 0.0  # demo mode only: lower the fake DO by this much to test alerts / automatic aeration
    # sensor driver (aquacast_hardware_pd1.Hardware), same defaults as aquacast_logger.py
    serial_port: str = "/dev/ttyUSB0"
    baud: int = 9600
    light_address: int = 1
    do_address: int = 2
    ph_enabled: bool = True
    warmup_seconds: int = 60
    backup_reading: bool = True   # extra reading halfway through each cycle (kept on the Pi, never uploaded)
    backup_max_fills: int = 3     # a failed sensor is filled from it at most this many readings in a row
    # aerator relay (BCM pin numbers). Empty pin = no relay connected (simulated, logs only)
    relay_pin: int | None = None
    relay_active_high: bool = True
    relay_on_when_energized: bool = True
    auto_min_on_minutes: int = 20
    automatic_rule_version: str = "AUTO-RULE-1.0"
    # optional local buzzer for CRITICAL (works without internet)
    buzzer_pin: int | None = None
    buzzer_seconds: int = 30
    # forecast model description (registered in the dashboard's forecast_models table)
    model_file: str = ""
    model_files: dict = field(default_factory=dict)  # per horizon, optional
    model_name: str = "AquaCast DO forecaster"
    model_algorithm: str = "Persistence with damped trend (placeholder until the trained model is installed)"
    model_version: str = "baseline-1"
    model_training_start: str = "2026-01-01T00:00:00Z"
    model_training_end: str = "2026-01-01T00:00:00Z"
    log_level: str = "INFO"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "aquacast-edge.sqlite3"


def load(env_file: str | None = None) -> Config:
    path = env_file or os.environ.get("AQUACAST_ENV_FILE") or DEFAULT_ENV_FILE
    v = _load_env_file(path)
    v.update({k: val for k, val in os.environ.items() if k.startswith("AQUACAST_")})
    g = lambda k, d="": (v.get(k) or d).strip()  # noqa: E731

    server = g("AQUACAST_SERVER_URL", "https://aquacast-research.vercel.app").rstrip("/")
    cfg = Config(
        server_url=server,
        edge_key=g("AQUACAST_EDGE_KEY"),
        data_dir=Path(g("AQUACAST_DATA_DIR", "/var/lib/aquacast")),
        cycle_minutes=int(g("AQUACAST_CYCLE_MINUTES", "10")),
        control_poll_seconds=max(5, int(g("AQUACAST_CONTROL_POLL_SECONDS", "15"))),
        upload_batch=min(50, max(1, int(g("AQUACAST_UPLOAD_BATCH", "20")))),
        keep_days=int(g("AQUACAST_KEEP_DAYS", "90")),
        min_valid_year=int(g("AQUACAST_MIN_VALID_YEAR", "2026")),
        sensor_mode=g("AQUACAST_SENSOR_MODE", "real").lower(),
        demo_do_shift=float(g("AQUACAST_DEMO_DO_SHIFT", "0")),
        serial_port=g("AQUACAST_SERIAL_PORT", "/dev/ttyUSB0"),
        baud=int(g("AQUACAST_BAUD", "9600")),
        light_address=int(g("AQUACAST_LIGHT_ADDRESS", "1")),
        do_address=int(g("AQUACAST_DO_ADDRESS", "2")),
        ph_enabled=_bool(v.get("AQUACAST_PH_ENABLED"), True),
        warmup_seconds=max(0, int(g("AQUACAST_WARMUP_SECONDS", "60"))),
        backup_reading=g("AQUACAST_BACKUP_READING", "1").strip().lower() not in ("0", "false", "no", "off"),
        backup_max_fills=max(0, int(g("AQUACAST_BACKUP_MAX_FILLS", "3"))),
        relay_pin=_int_or_none(v.get("AQUACAST_RELAY_PIN")),
        relay_active_high=_bool(v.get("AQUACAST_RELAY_ACTIVE_HIGH"), True),
        relay_on_when_energized=_bool(v.get("AQUACAST_RELAY_ON_WHEN_ENERGIZED"), True),
        auto_min_on_minutes=int(g("AQUACAST_AUTO_MIN_ON_MINUTES", "20")),
        automatic_rule_version=g("AQUACAST_AUTOMATIC_RULE_VERSION", "AUTO-RULE-1.0"),
        buzzer_pin=_int_or_none(v.get("AQUACAST_BUZZER_PIN")),
        buzzer_seconds=int(g("AQUACAST_BUZZER_SECONDS", "30")),
        model_file=g("AQUACAST_MODEL_FILE"),
        model_files={h: g(f"AQUACAST_MODEL_FILE_{h}") for h in (30, 60, 90, 120) if g(f"AQUACAST_MODEL_FILE_{h}")},
        model_name=g("AQUACAST_MODEL_NAME", "AquaCast DO forecaster"),
        model_algorithm=g("AQUACAST_MODEL_ALGORITHM", Config.model_algorithm),
        model_version=g("AQUACAST_MODEL_VERSION", "baseline-1"),
        model_training_start=g("AQUACAST_MODEL_TRAINING_START", "2026-01-01T00:00:00Z"),
        model_training_end=g("AQUACAST_MODEL_TRAINING_END", "2026-01-01T00:00:00Z"),
        log_level=g("AQUACAST_LOG_LEVEL", "INFO").upper(),
    )
    if cfg.cycle_minutes < 1 or 60 % cfg.cycle_minutes:
        raise SystemExit("AQUACAST_CYCLE_MINUTES must divide 60 (e.g. 10)")
    return cfg


def problems(cfg: Config) -> list:
    """Things that stop the Pi from talking to the dashboard (shown by `check`)."""
    out = []
    if not cfg.server_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        out.append("AQUACAST_SERVER_URL must start with https://")
    if len(cfg.edge_key) < 32:
        out.append("AQUACAST_EDGE_KEY is missing or shorter than 32 characters (same value as EDGE_API_KEY in Vercel)")
    if not (1 <= cfg.light_address <= 247 and 1 <= cfg.do_address <= 247) or cfg.light_address == cfg.do_address:
        out.append("AQUACAST_LIGHT_ADDRESS and AQUACAST_DO_ADDRESS must be different Modbus addresses 1-247")
    for name, pin in (("AQUACAST_RELAY_PIN", cfg.relay_pin), ("AQUACAST_BUZZER_PIN", cfg.buzzer_pin)):
        if pin in (2, 3):
            out.append(f"{name}={pin} is an I2C pin (SDA/SCL) used by the SHT20, BMP280 and pH board; pick another GPIO, e.g. 17")
    if cfg.relay_pin is not None and cfg.relay_pin == cfg.buzzer_pin:
        out.append("AQUACAST_RELAY_PIN and AQUACAST_BUZZER_PIN must be different GPIOs")
    if cfg.sensor_mode not in ("real", "demo"):
        out.append("AQUACAST_SENSOR_MODE must be real or demo")
    return out
