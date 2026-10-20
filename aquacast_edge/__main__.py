"""Command line:

  python3 -m aquacast_edge run              the edge program (what the systemd service runs)
  python3 -m aquacast_edge check            test settings, clock, server connection and sensors once
  python3 -m aquacast_edge status           what is waiting on the SD card, mode, relay, refused items
  python3 -m aquacast_edge retry-rejected   queue refused readings again (after fixing the cause)
  python3 -m aquacast_edge relay-test --yes switch the aerator ON for 5 seconds, then back
  python3 -m aquacast_edge train [--install]  retrain the DO forecast on this pond's readings (see train.py)
"""
from __future__ import annotations

import argparse
import logging
import signal
import socket
import sys
import time

from . import VERSION, config, sensors


def main(argv=None):
    ap = argparse.ArgumentParser(prog="aquacast_edge", description=f"AquaCast edge program {VERSION}")
    ap.add_argument("command", nargs="?", default="run", choices=["run", "check", "status", "retry-rejected", "relay-test", "import-logger", "train"])
    ap.add_argument("path", nargs="?", help="import-logger: the old logger database (aquacast.sqlite)")
    ap.add_argument("--env", help="settings file (default /etc/aquacast/edge.env)")
    ap.add_argument("--yes", action="store_true", help="confirm relay-test")
    from . import train as _train
    _train.add_arguments(ap)
    args = ap.parse_args(argv)
    cfg = config.load(args.env)
    logging.basicConfig(level=getattr(logging, cfg.log_level, logging.INFO), stream=sys.stdout,
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")

    if args.command == "check":
        return check(cfg)
    if args.command == "train":
        return _train.main(args, cfg)
    from .runner import Edge
    if args.command == "status":
        return status(cfg)
    if args.command == "import-logger":
        return import_logger(cfg, args.path)
    if args.command == "retry-rejected":
        from .store import Store
        n = Store(cfg.db_path).retry_rejected()
        print(f"{n} refused item(s) queued again; they upload within a minute while the service runs.")
        return 0
    if args.command == "relay-test":
        if not args.yes:
            print("This switches the AERATOR. Run again with --yes when it is safe.")
            return 1
        edge = Edge(cfg)
        if edge.relay.simulated:
            print("The relay GPIO is not available (AQUACAST_RELAY_PIN empty, or the running service is using it).")
            print("Stop the service first:  sudo systemctl stop aquacast-edge   (start it again afterwards)")
            return 1
        before = edge.relay.state
        other = "OFF" if before == "ON" else "ON"
        print(f"relay {before} -> {other} for 5 s ...")
        edge.relay.set(other)
        time.sleep(5)
        edge.relay.set(before)
        print(f"relay back to {before}. (Not reported to the dashboard: this is a wiring test.)")
        return 0

    problems = config.problems(cfg)
    if problems:
        for p in problems:
            logging.error("setting problem: %s", p)
        logging.error("fix /etc/aquacast/edge.env, then: sudo systemctl restart aquacast-edge")
        return 2
    edge = Edge(cfg)
    signal.signal(signal.SIGTERM, lambda *_: edge.stop.set())
    signal.signal(signal.SIGINT, lambda *_: edge.stop.set())
    edge.run()
    return 0


def check(cfg):
    from .api import EdgeApi, Offline, Refused
    ok = True
    print(f"AquaCast edge {VERSION} on {socket.gethostname()}")
    for p in config.problems(cfg):
        ok = False
        print(f"  [!] {p}")
    year = time.gmtime().tm_year
    print(f"  [{'ok' if year >= cfg.min_valid_year else '!'}] clock: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")
    try:
        info = EdgeApi(cfg).hello(socket.gethostname())
        from .store import parse_iso, utc_now
        skew = (utc_now() - parse_iso(info["server_time"])).total_seconds()
        print(f"  [ok] server {cfg.server_url} answered (edge API v{info.get('api_version')})")
        print(f"  [{'ok' if abs(skew) < 60 else '!'}] clock difference to the server: {skew:+.1f} s")
        if info.get("simulator_enabled"):
            ok = False
            print("  [!] the dashboard simulator is still ON: set MOCK_EDGE_ENABLED=false in Vercel and redeploy")
        s = info.get("settings") or {}
        print(f"  [i] aerator mode requested in the dashboard: {s.get('requested_mode')} (revision {s.get('settings_revision')})")
    except Refused as e:
        ok = False
        print(f"  [!] server refused: {e}")
    except Offline as e:
        ok = False
        print(f"  [!] server not reachable: {e}")
    from . import forecast
    forecast.load_model(cfg)
    if forecast.INFO:
        path, meta = forecast.INFO[min(forecast.INFO)]
        print(f"  [ok] forecast model: {meta.get('name')} {meta.get('version')} ({path})")
        missing = [h for h in (30, 60, 90, 120) if h not in forecast.MODELS]
        if missing:
            print(f"  [!] no model for +{', +'.join(map(str, missing))} min: placeholder forecast used there")
    else:
        ok = False
        print("  [!] no forecast model file found: the simple placeholder forecast is used (copy models/ and run install.sh)")
    print(f"  [i] sensor mode: {cfg.sensor_mode}" + (f" (driver port {cfg.serial_port}, light {cfg.light_address}, DO {cfg.do_address}, {cfg.baud} baud, pH {'on' if cfg.ph_enabled else 'off'})" if cfg.sensor_mode == "real" else ""))
    if service_running(cfg):
        print("  [i] the service is running and using the sensors: sensor test skipped.")
        print("      To test the sensors here: sudo systemctl stop aquacast-edge, run check, then start it again.")
    else:
        drv = sensors.Sensors(cfg)
        try:
            values, buses, record, payload = sensors.read_all(drv, cfg.sensor_mode, demo_do_shift=cfg.demo_do_shift)
        finally:
            drv.close()
        for target, _, status_field, sensor, *_ in sensors.FIELDS:
            err = (payload["sensors"].get(sensor) or {}).get("error")
            print(f"      {target:26} {str(values[target]):>10}  {values[status_field]}{'  (' + err[:90] + ')' if err and values[status_field] != 'VALID' else ''}")
        print(f"      pH voltage {values['ph_voltage_mv']} mV, ADC {values['ph_adc_raw']} | record {record}, RS485 {buses['rs485']}, I2C {buses['i2c']}")
        if record != "COMPLETE":
            ok = False
            print("  [!] not every sensor gave a VALID value (see the messages above)")
    print("all good" if ok else "fix the [!] items above")
    return 0 if ok else 1


def import_logger(cfg, path):
    """Queue the readings the old aquacast_logger.py already collected, so they also reach the dashboard.
    Only the readings are imported: forecasts and risk levels cannot be made afterwards (a forecast must
    be made before the time it predicts), so those cycles show readings only. Idempotent: run it twice
    and nothing is doubled (same observation_id / timestamp)."""
    import sqlite3
    from pathlib import Path
    from .store import Store, iso, parse_iso
    if not path or not Path(path).is_file():
        print("usage: sudo aquacast-edge import-logger /var/lib/aquacast/logger-import.sqlite")
        return 1
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    rows = src.execute("select * from raw_observations order by timestamp_utc").fetchall()
    st = Store(cfg.db_path)
    added = skipped = 0
    for r in rows:
        o = dict(r)
        try:
            ts = iso(parse_iso(o["timestamp_utc"]))
        except (TypeError, ValueError):
            skipped += 1
            continue
        if st.has_reading(ts):
            skipped += 1
            continue
        obs = {k: o.get(k) for k in ("observation_id", "do_mg_l", "do_saturation_pct", "water_temp_c", "ph_adc_raw", "ph_voltage_mv", "ph_value",
                                     "light_lux", "air_temp_c", "relative_humidity_pct", "atmospheric_pressure_hpa", "do_mg_l_status",
                                     "do_saturation_status", "water_temp_status", "ph_status", "light_status", "air_temp_status",
                                     "humidity_status", "pressure_status", "record_status")}
        obs["timestamp_utc"] = ts
        obs["acquisition_started_at_utc"] = iso(parse_iso(o["acquisition_started_at_utc"]))
        obs["acquisition_completed_at_utc"] = iso(parse_iso(o["acquisition_completed_at_utc"])) if o.get("acquisition_completed_at_utc") else None
        if obs["ph_voltage_mv"] is not None and obs["ph_voltage_mv"] < 0:
            obs["ph_voltage_mv"] = None  # the cloud database only accepts >= 0
        try:
            st.save_cycle({"observation": obs, "health": None, "forecasts": [], "risk": None}, {"imported_from": str(path)})
            added += 1
        except sqlite3.IntegrityError:
            skipped += 1
    print(f"{added} old reading(s) queued for upload, {skipped} skipped (already there or unreadable).")
    print("They upload within a minute while the service runs (sudo aquacast-edge status shows the queue).")
    return 0


def service_running(cfg):
    """True when another edge program holds the lock (the service is using the sensors)."""
    import fcntl
    path = cfg.data_dir / "edge.lock"
    if not path.exists():
        return False
    try:
        with open(path, "a") as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
        return False
    except BlockingIOError:
        return True
    except OSError:
        return False


def status(cfg):
    from .store import Store
    st = Store(cfg.db_path)
    latest = st.latest_risk()
    print(f"readings waiting to upload : {st.count_pending('cycle')}")
    print(f"answers waiting to upload  : {st.count_pending('command_result') + st.count_pending('automatic_command')}")
    print(f"last upload                : {st.get('last_cloud_sync') or 'never'}")
    print(f"latest reading             : {latest['timestamp_utc'] + ' risk ' + str(latest['risk_state']) if latest else 'none'}")
    print(f"aerator mode / relay       : {st.get('applied_mode', 'MANUAL')} (revision {st.get('applied_revision')}) / {st.get('relay_state', 'OFF')}")
    rej = st.rejected()
    if rej:
        print(f"refused by the server ({len(rej)} shown):")
        for r in rej:
            print(f"  {r['created_at']} {r['kind']} {r['item_id'][:8]}: {r['last_error']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
