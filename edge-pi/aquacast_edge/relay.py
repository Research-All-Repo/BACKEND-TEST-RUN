"""Aerator relay (and optional buzzer) on the Raspberry Pi GPIO, via gpiozero.

Wiring options (set in edge.env):
  AQUACAST_RELAY_PIN=17                 BCM number of the GPIO driving the relay module
  AQUACAST_RELAY_ACTIVE_HIGH=false      most cheap relay boards switch on a LOW signal
  AQUACAST_RELAY_ON_WHEN_ENERGIZED=true aerator on the NO contact (normal)
      = false                           aerator on the NC contact: if the Pi dies or loses power,
                                        the relay drops and the aerator RUNS (fail-safe)

Without AQUACAST_RELAY_PIN (or without gpiozero, e.g. on a laptop) the relay is simulated:
switching is only logged, which is handy for testing.
"""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger("relay")


class Relay:
    def __init__(self, cfg, store):
        self.cfg, self.store = cfg, store
        self.lock = threading.Lock()
        self.state = store.get("relay_state", "OFF")  # last commanded state survives a reboot
        self.device = None
        if cfg.relay_pin is not None:
            try:
                from gpiozero import OutputDevice
                energized = self._energized(self.state)
                self.device = OutputDevice(cfg.relay_pin, active_high=cfg.relay_active_high, initial_value=energized)
                log.info("relay on GPIO%s restored to %s", cfg.relay_pin, self.state)
            except Exception as e:  # noqa: BLE001
                log.error("relay GPIO%s could not be opened (%s); running SIMULATED", cfg.relay_pin, e)
        else:
            log.warning("AQUACAST_RELAY_PIN not set: aerator relay is SIMULATED (log only)")

    def _energized(self, state):
        on = state == "ON"
        return on if self.cfg.relay_on_when_energized else not on

    @property
    def simulated(self):
        return self.device is None

    def set(self, state: str):
        """Switch the aerator. Raises if the GPIO fails (the command is then reported FAILED)."""
        if state not in ("ON", "OFF"):
            raise ValueError(state)
        with self.lock:
            if self.device is not None:
                if self._energized(state):
                    self.device.on()
                else:
                    self.device.off()
            self.state = state
            self.store.put("relay_state", state)
            self.store.put("relay_changed_at", time.time())
        log.info("aerator relay -> %s%s", state, " (simulated)" if self.simulated else "")

    def on_since(self):
        return self.store.get("relay_changed_at", 0) if self.state == "ON" else None


class Buzzer:
    """Optional local alarm when the pond is CRITICAL (works without internet)."""

    def __init__(self, cfg):
        self.seconds = cfg.buzzer_seconds
        self.device = None
        if cfg.buzzer_pin is not None:
            try:
                from gpiozero import Buzzer as GpioBuzzer
                self.device = GpioBuzzer(cfg.buzzer_pin)
            except Exception as e:  # noqa: BLE001
                log.error("buzzer GPIO%s could not be opened: %s", cfg.buzzer_pin, e)

    def alarm(self):
        if self.device is None:
            return
        log.warning("CRITICAL: local buzzer for %ss", self.seconds)
        self.device.beep(on_time=0.5, off_time=0.5, n=max(1, self.seconds), background=True)
