"""The three loops of the edge program.

  cycle loop    every 10 minutes: read sensors -> forecasts -> risk -> save to SD card
                (-> automatic aerator control, local buzzer). Works with or without internet.
  sync loop     uploads the SD-card outbox oldest-first whenever the server is reachable.
  control loop  every 15 s: reports the relay state, receives dashboard ON/OFF requests and
                mode changes, answers them.
"""
from __future__ import annotations

import logging
import math
import socket
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from . import VERSION, forecast, health, risk, sensors
from .api import EdgeApi, Offline, Refused
from .relay import Buzzer, Relay
from .store import Store, iso, parse_iso, utc_now

log = logging.getLogger("edge")
HORIZONS = (30, 60, 90, 120)


class Edge:
    def __init__(self, cfg):
        self.cfg = cfg
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        self.store = Store(cfg.db_path)
        self.api = EdgeApi(cfg)
        self.relay = Relay(cfg, self.store)
        self.buzzer = Buzzer(cfg)
        self.stop = threading.Event()
        self.wake_sync = threading.Event()
        self.wake_control = threading.Event()
        self.decide = threading.Lock()  # one aerator decision at a time
        self.sensors = sensors.Sensors(cfg)
        forecast.load_model(cfg)
        self.models = forecast.model_records(cfg)

    # ------------------------------------------------------------------ cycle
    def slot_for(self, t: datetime) -> datetime:
        step = self.cfg.cycle_minutes * 60
        return datetime.fromtimestamp(math.floor(t.timestamp() / step) * step, tz=timezone.utc)

    def run_cycle(self, slot: datetime):
        if slot.year < self.cfg.min_valid_year:
            log.error("clock looks wrong (%s): skipping this reading. Check internet time or the RTC module.", iso(slot))
            return None
        slot_iso = iso(slot)
        if self.store.has_reading(slot_iso):
            return None
        started = utc_now()
        values, buses, record, raw_payload = sensors.read_all(self.sensors, self.cfg.sensor_mode, demo_do_shift=self.cfg.demo_do_shift)
        completed = utc_now()
        if completed < started or started < slot:  # same guard as aquacast_logger.py
            log.error("clock moved backwards during the reading; cycle not saved")
            return None
        obs = {
            "observation_id": str(uuid.uuid4()),
            "timestamp_utc": slot_iso,
            "acquisition_started_at_utc": iso(started),
            "acquisition_completed_at_utc": iso(completed),
            **values,
            "record_status": record,
        }
        connected, rssi = health.wifi()
        hlth = {
            "timestamp_utc": iso(utc_now()),
            "pi_cpu_temp_c": health.cpu_temp_c(),
            "pi_uptime_s": health.uptime_s(),
            "ram_used_pct": health.ram_used_pct(),
            "storage_free_mb": health.storage_free_mb(str(self.cfg.data_dir)),
            "wifi_connected": connected,
            "wifi_signal_rssi_dbm": rssi if connected else None,
            "internet_reachable": self.api.internet_reachable(),
            "last_cloud_sync_at_utc": self.store.get("last_cloud_sync"),
            "battery_voltage_v": None,
            "rs485_bus_status": buses["rs485"],
            "i2c_bus_status": buses["i2c"],
            "local_database_operational": self.store.ok(),
        }
        current_do = obs["do_mg_l"] if obs["do_mg_l_status"] == "VALID" else None
        hist = [{"timestamp_utc": r["timestamp_utc"], "do_mg_l": r["do_mg_l"] if r["do_status"] == "VALID" else None,
                 "water_temp_c": r["water_temp_c"] if r["water_temp_status"] == "VALID" else None, "observation": None}
                for r in self.store.history(slot - timedelta(hours=forecast.HISTORY_HOURS))]
        hist.append({"timestamp_utc": slot_iso, "do_mg_l": current_do,
                     "water_temp_c": obs["water_temp_c"] if obs["water_temp_status"] == "VALID" else None, "observation": obs})
        fcs = []
        for hz in HORIZONS:
            status, pred = "VALID", None
            if current_do is None:
                status = "INPUT_UNAVAILABLE"
            else:
                try:
                    pred = float(forecast.predict(hist, hz))
                    if math.isnan(pred) or pred < 0 or pred > 30:
                        log.warning("forecast +%s gave %s; recorded as MODEL_ERROR", hz, pred)
                        status, pred = "MODEL_ERROR", None
                    else:
                        pred = round(pred, 3)
                except forecast.InsufficientHistory:
                    status = "INSUFFICIENT_HISTORY"
                except Exception as e:  # noqa: BLE001
                    log.exception("forecast +%s failed: %s", hz, e)
                    status = "MODEL_ERROR"
            fcs.append({
                "forecast_id": str(uuid.uuid4()), "model_id": self.models[hz]["model_id"], "generated_at_utc": iso(utc_now()),
                "target_timestamp_utc": iso(slot + timedelta(minutes=hz)), "horizon_minutes": hz,
                "predicted_do_mg_l": pred, "forecast_status": status,
            })
        state, outlook, crossing = risk.assess(current_do, fcs)
        rsk = {"risk_id": str(uuid.uuid4()), "assessment_timestamp_utc": iso(utc_now()), "current_risk_state": state,
               "forecast_outlook": outlook, "expected_threshold_crossing_utc": crossing, "rule_version": risk.RULE_VERSION}
        cycle = {"observation": obs, "health": hlth, "forecasts": fcs, "risk": rsk}
        self.store.save_cycle(cycle, raw_payload)  # on the SD card before anything else happens
        log.info("reading %s  DO=%s (%s)  risk=%s  waiting to upload=%s", slot_iso, obs["do_mg_l"], obs["do_mg_l_status"], state,
                 self.store.count_pending("cycle"))
        self.automatic_control(state)
        if state == "CRITICAL":
            self.buzzer.alarm()
        self.wake_sync.set()
        return cycle

    def cycle_loop(self):
        last_cleanup = 0.0
        if self.cfg.sensor_mode == "real" and self.cfg.warmup_seconds:
            log.info("sensor warm-up: first reading after %s s", self.cfg.warmup_seconds)
            self.stop.wait(self.cfg.warmup_seconds)
        while not self.stop.is_set():
            now = utc_now()
            slot = self.slot_for(now)
            # a reading belongs to its 10-minute slot and is taken at the start of it (like aquacast_logger.py);
            # after a late start or a long pause the slot is skipped, never filled in afterwards
            if now - slot < timedelta(minutes=min(2, self.cfg.cycle_minutes / 2)):
                try:
                    self.run_cycle(slot)
                except Exception:  # noqa: BLE001 - never let one bad cycle stop the program
                    log.exception("cycle failed")
            if time.time() - last_cleanup > 86400:
                last_cleanup = time.time()
                try:
                    n = self.store.cleanup(self.cfg.keep_days)
                    if n:
                        log.info("housekeeping: removed %s old rows (older than %s days, already uploaded)", n, self.cfg.keep_days)
                except Exception:  # noqa: BLE001
                    log.exception("housekeeping failed")
            next_slot = slot + timedelta(minutes=self.cfg.cycle_minutes)
            self.stop.wait(max(1.0, (next_slot - utc_now()).total_seconds() + 0.5))

    # ------------------------------------------------------------------ aerator
    def mode(self):
        return self.store.get("applied_mode", "MANUAL")

    def automatic_control(self, risk_state):
        """AUTOMATIC mode: ON for WARNING/CRITICAL, OFF when NORMAL (kept ON at least AUTO_MIN_ON_MINUTES)."""
        with self.decide:
            if self.mode() != "AUTOMATIC" or not risk_state:
                return
            desired = "ON" if risk_state in ("WARNING", "CRITICAL") else "OFF" if risk_state == "NORMAL" else None
            if desired is None or desired == self.relay.state:
                return
            since = self.relay.on_since()
            if desired == "OFF" and since and time.time() - since < self.cfg.auto_min_on_minutes * 60:
                return
            try:
                self.relay.set(desired)
            except Exception as e:  # noqa: BLE001
                log.error("automatic switch to %s failed: %s", desired, e)
                return
            cid = str(uuid.uuid4())
            self.store.add("automatic_command", cid, {"command_id": cid, "requested_state": desired, "at": iso(utc_now()),
                                                      "rule_version": self.store.get("automatic_rule_version") or self.cfg.automatic_rule_version,
                                                      "risk_state": risk_state})
            log.info("AUTOMATIC: aerator %s (risk %s)", desired, risk_state)
        self.wake_control.set()

    def apply_settings(self, s):
        """Take over the mode an Admin requested in the dashboard (acknowledged in the next poll)."""
        if not s or s.get("settings_revision") == self.store.get("applied_revision"):
            return False
        with self.decide:
            self.store.put("applied_mode", s["requested_mode"])
            self.store.put("applied_revision", s["settings_revision"])
            self.store.put("automatic_rule_version", s.get("automatic_rule_version") or self.cfg.automatic_rule_version)
        log.info("mode is now %s (revision %s)", s["requested_mode"], s["settings_revision"])
        if s["requested_mode"] == "AUTOMATIC":
            latest = self.store.latest_risk()
            if latest:
                self.automatic_control(latest["risk_state"])
        return True

    def handle_command(self, c):
        cid = c["command_id"]
        if self.store.command_handled(cid):
            return False  # already acted on; the answer is in the outbox
        now = utc_now()
        with self.decide:
            if now >= parse_iso(c["expires_at_utc"]):
                status, reason = "EXPIRED", "Not applied before the command expiry time (controller received it too late)"
            elif self.mode() != "MANUAL":
                status, reason = "REJECTED", f"Controller is in {self.mode()} mode; manual commands are not accepted"
            else:
                try:
                    self.relay.set(c["requested_state"])
                    status, reason = "APPLIED", None
                except Exception as e:  # noqa: BLE001
                    status, reason = "FAILED", f"Relay could not be switched: {e}"
            self.store.record_command(cid, status, {"command_id": cid, "status": status, "at": iso(utc_now()), "reason": reason})
        log.info("dashboard request %s %s -> %s%s", c["requested_state"], cid[:8], status, f" ({reason})" if reason else "")
        return True

    # ------------------------------------------------------------------ control loop
    def control_once(self):
        results = self.store.pending("command_result", 50)
        autos = self.store.pending("automatic_command", 200)
        rev = self.store.get("applied_revision")
        body = {
            "output_state": self.relay.state,
            "mode_ack": {"revision": rev, "mode": self.mode()} if rev is not None else None,
            "command_results": [p for _, _, p in results],
            "automatic_commands": [p for _, _, p in autos],
        }
        data = self.api.control(body)
        handled = data.get("handled", {})
        self.store.mark_sent(handled.get("command_results", []) + handled.get("automatic_commands", []))
        for p in data.get("problems") or []:
            log.warning("server: %s", p)
        busy = self.apply_settings(data.get("settings"))
        for c in data.get("pending_commands", []):
            busy = self.handle_command(c) or busy
        return busy or bool(self.store.count_pending("command_result") or self.store.count_pending("automatic_command"))

    def control_loop(self):
        backoff, last_problem = 0, None
        while not self.stop.is_set():
            wait = self.cfg.control_poll_seconds
            try:
                if self.control_once():
                    wait = 1  # report results / acknowledge the mode right away
                backoff, last_problem = 0, None
            except Offline as e:
                backoff = min(60, max(self.cfg.control_poll_seconds, backoff * 2))
                wait = backoff
                if last_problem != "offline":
                    log.warning("control: server not reachable (%s); relay stays %s, mode %s", e, self.relay.state, self.mode())
                last_problem = "offline"
            except Refused as e:
                wait = 120
                if last_problem != e.code:
                    log.error("control refused: %s", e)
                last_problem = e.code
            except Exception:  # noqa: BLE001
                log.exception("control loop error")
                wait = 30
            self.wake_control.wait(wait)
            self.wake_control.clear()

    # ------------------------------------------------------------------ sync loop
    def ensure_registered(self):
        info = self.api.hello(socket.gethostname())
        skew = (utc_now() - parse_iso(info["server_time"])).total_seconds()
        if abs(skew) > 120:
            log.error("Pi clock differs from the server by %.0f s. Fix the time (internet time / RTC) or forecasts will be refused.", skew)
        if info.get("simulator_enabled"):
            log.error("The dashboard simulator is still ON. Set MOCK_EDGE_ENABLED=false in Vercel and redeploy; readings wait on the SD card.")
        deployed = info.get("deployed_models") or {}
        missing = [m for hz, m in self.models.items() if (deployed.get(str(hz)) or {}).get("model_id") != m["model_id"]]
        if missing:
            res = self.api.register_models(missing)
            for m in res.get("models", []):
                log.info("forecast model +%s min %s: %s", m["horizon_minutes"], m["model_id"][:8], m["status"])
        self.store.put("registered_models", [m["model_id"] for m in self.models.values()])

    def upload_pending(self):
        sent = 0
        while not self.stop.is_set():
            batch = self.store.pending("cycle", self.cfg.upload_batch)
            if not batch:
                break
            backlog = self.store.count_pending("cycle")
            try:  # tell the dashboard how many will still be waiting after this batch
                data = self.api.upload_cycles([p for _, _, p in batch], max(0, backlog - len(batch)))
            except (Offline, Refused) as e:
                self.store.mark_attempt([i for _, i, _ in batch], e)
                raise
            ok = []
            for (_, item_id, _), r in zip(batch, data.get("results", [])):
                if r.get("status") in ("STORED", "DUPLICATE"):
                    ok.append(item_id)
                else:
                    self.store.mark_rejected(item_id, r.get("error"))
                    log.error("reading %s refused by the server: %s", item_id[:8], r.get("error"))
            self.store.mark_sent(ok)
            self.store.put("last_cloud_sync", iso(utc_now()))
            sent += len(ok)
            if len(batch) > 1 or backlog > 1:
                log.info("uploaded %s reading(s); %s still waiting", len(ok), self.store.count_pending("cycle"))
        return sent

    def sync_loop(self):
        backoff, registered_at, last_problem = 0, 0.0, None
        while not self.stop.is_set():
            wait = 60
            try:
                if time.time() - registered_at > 3600:
                    self.ensure_registered()
                    registered_at = time.time()
                self.upload_pending()
                if last_problem:
                    log.info("connection to the dashboard is back")
                backoff, last_problem = 0, None
            except Offline as e:
                backoff = min(300, max(15, backoff * 2))
                wait = backoff
                if last_problem != "offline":
                    log.warning("offline (%s): readings are kept on the SD card and sent later", e)
                last_problem = "offline"
            except Refused as e:
                wait = 300
                registered_at = 0  # check the models / simulator again next time
                if last_problem != e.code:
                    log.error("upload refused: %s", e)
                last_problem = e.code
            except Exception:  # noqa: BLE001
                log.exception("sync loop error")
                wait = 60
            self.wake_sync.wait(wait)
            self.wake_sync.clear()

    # ------------------------------------------------------------------ main
    def run(self):
        import fcntl
        lock = open(self.cfg.data_dir / "edge.lock", "a")  # noqa: SIM115 - held for the whole run
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another AquaCast edge program is already running (sudo systemctl status aquacast-edge).") from None
        log.info("AquaCast edge %s starting: server %s, sensors %s, relay %s, %s reading(s) waiting on the SD card",
                 VERSION, self.cfg.server_url, self.cfg.sensor_mode, "simulated" if self.relay.simulated else f"GPIO{self.cfg.relay_pin}",
                 self.store.count_pending("cycle"))
        threads = [threading.Thread(target=self.sync_loop, name="sync", daemon=True),
                   threading.Thread(target=self.control_loop, name="control", daemon=True)]
        for t in threads:
            t.start()
        try:
            self.cycle_loop()
        finally:
            self.stop.set()
            self.wake_sync.set()
            self.wake_control.set()
            for t in threads:
                t.join(timeout=10)
            self.sensors.close()
            lock.close()
            log.info("stopped (relay left %s)", self.relay.state)
