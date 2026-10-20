#!/bin/bash
# AquaCast edge installer for Raspberry Pi OS (Bookworm or Bullseye).
#   cd edge-pi && sudo bash install.sh
# Safe to run again after changing the code: it updates the program and restarts the service.
# It never overwrites /etc/aquacast/edge.env (your key and settings) or the SD-card data.
set -euo pipefail
cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash install.sh"; exit 1; fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9 or newer is needed."; exit 1; }

echo "1/6 system packages"
if command -v apt-get >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq python3-venv python3-gpiozero python3-lgpio i2c-tools sqlite3 >/dev/null 2>&1 \
    || apt-get install -y -qq python3-venv python3-gpiozero i2c-tools sqlite3 >/dev/null
fi

echo "2/6 service user 'aquacast'"
id aquacast >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin aquacast
for g in gpio i2c spi dialout; do getent group "$g" >/dev/null && usermod -aG "$g" aquacast; done

echo "3/6 program -> /opt/aquacast-edge"
install -d -m 755 /opt/aquacast-edge
rm -rf /opt/aquacast-edge/aquacast_edge
cp -r aquacast_edge /opt/aquacast-edge/
cp requirements.txt /opt/aquacast-edge/
# the group's sensor driver (hardware/aquacast_hardware_pd1.py and any helper modules it imports)
if ls hardware/*.py >/dev/null 2>&1; then cp hardware/*.py /opt/aquacast-edge/; else
  echo "   NOTE: hardware/aquacast_hardware_pd1.py is missing; real sensor readings will show MISSING until you add it."; fi
# extra files next to the code (e.g. your model file) can go in /opt/aquacast-edge/models
install -d -m 755 /opt/aquacast-edge/models
[ -d models ] && cp -r models/. /opt/aquacast-edge/models/ || true
find /opt/aquacast-edge -name '__pycache__' -prune -exec rm -rf {} +
# files copied from Windows (scp / USB) can arrive as owner-only: the service user must be able to read them
chmod -R a+rX /opt/aquacast-edge

echo "4/6 Python environment (+ requirements.txt)"
[ -x /opt/aquacast-edge/venv/bin/python ] || python3 -m venv --system-site-packages /opt/aquacast-edge/venv
if grep -qvE '^\s*(#|$)' requirements.txt; then
  /opt/aquacast-edge/venv/bin/pip install -q -r requirements.txt
fi

# training tools for `sudo aquacast-edge train` (forecasting itself needs none of them)
if [ -f requirements-train.txt ]; then
  cp requirements-train.txt /opt/aquacast-edge/
  echo "   training tools (xgboost, numpy) - can take a few minutes the first time ..."
  /opt/aquacast-edge/venv/bin/pip install -q -r requirements-train.txt \
    || echo "   NOTE: could not install the training tools now. Forecasting still works; run install.sh again later to retrain."
fi

chmod -R a+rX /opt/aquacast-edge  # again, for packages pip just installed

echo "5/6 settings and data folder"
install -d -m 750 -o root -g aquacast /etc/aquacast
if [ ! -f /etc/aquacast/edge.env ]; then
  install -m 640 -o root -g aquacast edge.env.example /etc/aquacast/edge.env
  NEW_SETTINGS=1
fi
chmod 640 /etc/aquacast/edge.env; chown root:aquacast /etc/aquacast/edge.env
install -d -m 750 -o aquacast -g aquacast /var/lib/aquacast

# short command for the team:  sudo aquacast-edge check | status | retry-rejected | relay-test --yes | train
cat > /usr/local/bin/aquacast-edge <<'WRAP'
#!/bin/sh
cd /opt/aquacast-edge || exit 1
if [ "$(id -u)" -ne 0 ]; then echo "use: sudo aquacast-edge $*"; exit 1; fi
if [ "$1" = "train" ]; then
  # low priority, so the 10-minute readings keep their timing while it trains
  nice -n 10 runuser -u aquacast -- /opt/aquacast-edge/venv/bin/python -m aquacast_edge "$@"
  rc=$?
  if [ "$rc" -eq 10 ]; then
    systemctl restart aquacast-edge && echo "Service restarted with the new model. Check: journalctl -u aquacast-edge -n 20"
    exit 0
  fi
  exit "$rc"
fi
exec runuser -u aquacast -- /opt/aquacast-edge/venv/bin/python -m aquacast_edge "$@"
WRAP
chmod 755 /usr/local/bin/aquacast-edge

echo "6/6 systemd service"
cp aquacast-edge.service /etc/systemd/system/aquacast-edge.service
systemctl daemon-reload
systemctl enable aquacast-edge >/dev/null 2>&1

if grep -qE '^AQUACAST_EDGE_KEY=.{32,}' /etc/aquacast/edge.env; then
  systemctl restart aquacast-edge
  echo
  echo "Installed and (re)started. Follow the log with:  journalctl -u aquacast-edge -f"
  echo "Quick test:  sudo aquacast-edge check      Upload queue:  sudo aquacast-edge status"
else
  echo
  echo "Installed. Next:"
  echo "  1. sudo nano /etc/aquacast/edge.env   -> paste the edge key after AQUACAST_EDGE_KEY="
  echo "     (and set AQUACAST_RELAY_PIN / AQUACAST_SENSOR_MODE)"
  echo "  2. sudo aquacast-edge check"
  echo "  3. sudo systemctl start aquacast-edge && journalctl -u aquacast-edge -f"
fi
[ "${NEW_SETTINGS:-0}" = 1 ] && echo "(A new settings file was created at /etc/aquacast/edge.env.)" || true
