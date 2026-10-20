"""Raspberry Pi health for the system_health table (CPU temperature, RAM, storage, Wi-Fi ...)."""
from __future__ import annotations

import os
import re
import shutil


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def cpu_temp_c():
    raw = _read("/sys/class/thermal/thermal_zone0/temp")
    return round(int(raw) / 1000, 1) if raw and raw.strip().isdigit() else None


def uptime_s():
    raw = _read("/proc/uptime")
    return int(float(raw.split()[0])) if raw else None


def ram_used_pct():
    raw = _read("/proc/meminfo")
    if not raw:
        return None
    vals = {k: int(v) for k, v in re.findall(r"^(\w+):\s+(\d+)", raw, re.M)}
    total, avail = vals.get("MemTotal"), vals.get("MemAvailable")
    return round((1 - avail / total) * 100, 1) if total and avail is not None else None


def storage_free_mb(path):
    try:
        return round(shutil.disk_usage(path).free / 1_048_576, 0)
    except OSError:
        return None


def wifi():
    """(connected, rssi_dbm) from /proc/net/wireless; (False, None) without Wi-Fi."""
    raw = _read("/proc/net/wireless")
    if raw:
        for line in raw.splitlines()[2:]:
            parts = line.split()
            if len(parts) >= 4 and parts[0].rstrip(":").startswith("wl"):
                try:
                    level = float(parts[3].rstrip("."))
                    return True, (level if level < 0 else level - 256)
                except ValueError:
                    return True, None
    # wired / other link counts as connected when it has an address; RSSI unknown
    for name in os.listdir("/sys/class/net") if os.path.isdir("/sys/class/net") else []:
        if name != "lo" and (_read(f"/sys/class/net/{name}/operstate") or "").strip() == "up":
            return True, None
    return False, None
