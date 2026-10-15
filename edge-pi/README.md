# Connecting the Raspberry Pi to the AquaCast dashboard

This folder is the program that runs on the Pi at the pond. It **replaces `aquacast_logger.py`**:
it reads the sensors with the group's own driver (`aquacast_hardware_pd1.py`) and the same rules
as the logger, and it also sends the data to the dashboard. Every 10 minutes it:

1. reads the 5 sensors (SHT20, BMP280, light, pH, DO) exactly like `aquacast_logger.py`
2. computes the DO forecasts for +30/60/90/120 min (`aquacast_edge/forecast.py`, placeholder until the trained model is added)
3. decides the risk level (RISK-RULE-1.0)
4. saves everything on the SD card **first** (`/var/lib/aquacast`, SQLite)
5. uploads it to the dashboard. Without internet the readings wait on the SD card and are sent
   oldest-first when the connection returns. Nothing is lost, and nothing is stored twice.

Every 15 seconds it also picks up aerator ON/OFF requests and mode changes from the dashboard,
switches the relay and reports back. In AUTOMATIC mode it switches the aerator by itself, even without
internet: ON at WARNING / CRITICAL, OFF at NORMAL (after at least 20 min ON).

```
sensors → Pi: read → forecast → risk → SD card ──(internet)──► Vercel /api/edge ─► Supabase ─► dashboard + phone alerts
relay   ◄─ Pi ◄──────────── dashboard ON/OFF requests and mode (every 15 s) ◄───────────┘
```

The Pi only holds the **edge key**, never the Supabase keys. If the Pi is lost, change `EDGE_API_KEY` in
Vercel and the old key stops working.

---

## Part A: on your laptop (once)

**A1. Deploy this update.** Copy the zip into your `aquacast-backend` folder (Replace), then
`git add -A`, `git commit -m "Raspberry Pi connection"` and `git push`. Wait until Vercel shows the
deployment as Ready (`/sw.js` shows the new version).

**A2. Make the edge key.** In the `aquacast-backend` folder (PowerShell or VS Code terminal):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep the printed line somewhere private (you need it again in B5). **Never paste it in chat, screenshots or GitHub.**

**A3. Give the key to Vercel.** Vercel → project → Settings → Environment Variables → Add
`EDGE_API_KEY` = the key, environment **Production** → Save. Then Deployments → the latest one →
⋯ → **Redeploy**. Leave `MOCK_EDGE_ENABLED` alone for now; that comes in Part C.

---

## Part B: on the Raspberry Pi

Open a terminal on the Pi (keyboard + screen, or `ssh pi@<pi-address>` from the laptop).

**B1. Copy this folder to the Pi.** Easiest from the laptop's PowerShell, in the `aquacast-backend` folder:

```bash
scp -r edge-pi pi@<pi-address>:~/
```

(Use your Pi user name instead of `pi` if it is different. A USB stick works too: copy `edge-pi` into the home folder.)

**B2. Add the group's sensor driver.** `aquacast_logger.py` uses `aquacast_hardware_pd1.py` from its
own folder. Copy that file (and any other `.py` file it imports from the same folder) into `edge-pi/hardware/`:

```bash
cp ~/<folder-with-aquacast_logger>/aquacast_hardware_pd1.py ~/edge-pi/hardware/
```

**B3. Stop the old logger.** It uses the same USB/RS485 port and I2C sensors, and two programs
cannot read them at the same time. Depending on how it was started:

```bash
systemctl list-units --type=service | grep -i -E "aqua|logger"   # started as a service?
sudo systemctl disable --now <that-service-name>                    # stop it and keep it off after reboots
crontab -l                                                          # started from cron? then: crontab -e and delete that line
```

If it runs in an open terminal, press Ctrl+C there. **Keep its database** (`data/aquacast.sqlite`).
Its readings can be sent to the dashboard in C4.

**B4. Install.**

```bash
cd ~/edge-pi
sudo bash install.sh
```

This installs Python packages (minimalmodbus, pyserial, smbus2), creates the `aquacast` service user
(with serial, I2C and GPIO access), copies the program to `/opt/aquacast-edge` and sets up auto-start.
It does not start the program yet.

**B5. Settings.**

```bash
sudo nano /etc/aquacast/edge.env
```

| Setting | What to put |
|---|---|
| `AQUACAST_EDGE_KEY` | the key from A2 |
| `AQUACAST_SERIAL_PORT` | `/dev/ttyUSB0` (same as the logger's `--port`) |
| `AQUACAST_LIGHT_ADDRESS` / `AQUACAST_DO_ADDRESS` | `1` / `2` (same as the logger) |
| `AQUACAST_PH_ENABLED` | `1`, or `0` while the pH board is disconnected |
| `AQUACAST_RELAY_PIN` | BCM GPIO number of the relay input, e.g. `17`. Leave empty until the relay is wired (switching is then only logged). Not 2 or 3: those are the I2C pins |
| `AQUACAST_RELAY_ACTIVE_HIGH` | `false` for most relay boards (they switch on a LOW signal) |

Save with Ctrl+O, Enter, then Ctrl+X.

**B6. Test.**

```bash
sudo aquacast-edge check
```

You should see `[ok]` for the clock and the server, then one reading per sensor. Each sensor should
say `VALID`, or show the error message from the driver.

| Problem shown | Fix |
|---|---|
| `server refused: 401 EDGE_KEY_INVALID` | the key in `edge.env` ≠ `EDGE_API_KEY` in Vercel (or Vercel was not redeployed) |
| `the dashboard simulator is still ON` | expected until Part C, step C1 |
| all sensors `MISSING ... aquacast_hardware_pd1.py not found` | B2, then `sudo bash install.sh` again |
| `needs the Python package 'X'` | add `X` to `requirements.txt`, then `sudo bash install.sh` again |
| `COMMUNICATION_ERROR ... ttyUSB0` | USB-RS485 adapter unplugged, wrong port (`ls /dev/ttyUSB*`), or the old logger still running (B3) |
| I2C sensor errors | `sudo i2cdetect -y 1` should list the sensors; I2C enabled in `sudo raspi-config` → Interface Options |

---

## Part C: switch the dashboard from simulated to real data

Do these in order.

**C1.** Dashboard → System Settings → **Calibration Mode ON** (pauses phone alerts while you switch).
Vercel → Environment Variables → `MOCK_EDGE_ENABLED` = `false` → Save → **Redeploy**. After the
redeploy, System Settings → Phone Alert Diagnostics → *Data source* says **Simulator is OFF**.

**C2.** Supabase → SQL Editor → paste and run `supabase/cutover/clear_simulated_data.sql` (from the
`aquacast-backend` folder). It removes the simulated readings and keeps accounts, phones and the audit
log. The four counts at the end must be **0**.

**C3. Start the Pi program.**

```bash
sudo systemctl start aquacast-edge
journalctl -u aquacast-edge -f
```

Within a minute you should see `forecast model ... REGISTERED`. After the 60-second warm-up, at the
next 10-minute mark (e.g. 14:20), you should see `reading ... DO=... risk=...`. Ctrl+C leaves the log;
the program keeps running.

**C4. (Optional) Send the readings the old logger already collected.**

```bash
sudo cp ~/<folder-with-aquacast_logger>/data/aquacast.sqlite /var/lib/aquacast/logger-import.sqlite
sudo chown aquacast /var/lib/aquacast/logger-import.sqlite
sudo aquacast-edge import-logger /var/lib/aquacast/logger-import.sqlite
```

Those readings upload within a minute. They have readings only: forecasts and risk levels cannot be
created afterwards, because a forecast must be made before the time it predicts. Old readings never
trigger phone alerts. Then make the study start at the first imported reading (Supabase SQL Editor):

```sql
update public.study_metadata set deployment_start_utc = (select min(timestamp_utc) from public.raw_observations);
```

**C5. Check the dashboard.**
- Live Status shows the new reading.
- System Settings → Phone Alert Diagnostics → **Raspberry Pi connection** is green.
- Sensors & Device shows the Pi health (CPU temperature, Wi-Fi, RS485/I2C).

**C6.** When the readings look right, turn **Calibration Mode OFF**.

---

## Part D: test before relying on it

| Test | How | Expected |
|---|---|---|
| Manual aerator | Aerator mode MANUAL; press ON, then OFF | relay switches within ~15 s; the request shows APPLIED; an Aeration activity opens and closes |
| Automatic | Admin switches the mode to AUTOMATIC | log `mode is now AUTOMATIC`; the aerator follows the risk level |
| Internet outage | Switch the Wi-Fi router off for 30+ min, then on | log `offline ... kept on the SD card`, later `uploaded N reading(s)`; the History chart has no gap |
| Power cut | Unplug the Pi, plug back in | the program starts by itself; the relay goes back to its last state; the time is right (RTC) |
| Phone alert | When DO is genuinely low, or the Phone test in the bell menu | phones receive it with AquaCast closed |

---

## Everyday commands (on the Pi)

```bash
journalctl -u aquacast-edge -f          # live log (Ctrl+C to leave)
sudo aquacast-edge status               # readings waiting to upload, mode, relay, refused readings
sudo systemctl stop aquacast-edge && sudo aquacast-edge check && sudo systemctl start aquacast-edge   # sensor test
sudo systemctl restart aquacast-edge    # after changing /etc/aquacast/edge.env
cd ~/edge-pi && sudo bash install.sh    # after changing the code (keeps settings and data)
sudo aquacast-edge retry-rejected       # send refused readings again after fixing the cause
sudo systemctl stop aquacast-edge && sudo aquacast-edge relay-test --yes && sudo systemctl start aquacast-edge
```

`check` skips the sensor part while the service is running, because only one program may use the sensors.

## Wiring the aerator

> ⚠ The aerator runs on mains voltage. Have a licensed electrician wire it. The Pi's relay module
> should switch a contactor rated for the motor, not the motor directly.

- **NO contact:** the aerator runs only while the Pi energizes the relay. Set `AQUACAST_RELAY_ON_WHEN_ENERGIZED=true`.
- **NC contact (fail-safe):** if the Pi crashes or loses power, the aerator **runs**. Set
  `AQUACAST_RELAY_ON_WHEN_ENERGIZED=false`. This is safer for the fish.

The dashboard shows the relay state the **Pi reports**. That is not proof that the motor turns,
because no motor-current sensor is part of the design.

## Real-time clock (DS3231), recommended

Without internet at start-up the Pi does not know the time. The program refuses to take readings when
the year is clearly wrong. A DS3231 module shares the I2C bus with the sensors (address 0x68, no clash):

1. Wire it to 3.3V, GND, SDA (GPIO2) and SCL (GPIO3).
2. `sudo nano /boot/firmware/config.txt` (older systems: `/boot/config.txt`), add the line `dtoverlay=i2c-rtc,ds3231`.
3. `sudo apt remove -y fake-hwclock && sudo reboot`
4. Once online: `sudo hwclock -w`. Check with `sudo hwclock -r`.

## Troubleshooting

| Log message | Meaning | Fix |
|---|---|---|
| `EDGE_KEY_INVALID` | the key on the Pi ≠ `EDGE_API_KEY` in Vercel | same key in both, redeploy Vercel, `sudo systemctl restart aquacast-edge` |
| `EDGE_NOT_CONFIGURED` | `EDGE_API_KEY` missing in Vercel | A3 |
| `SIMULATOR_ENABLED` | `MOCK_EDGE_ENABLED` still true | C1. The readings wait on the SD card meanwhile |
| `another reading is already stored for ...` | simulated data not cleared | C2, then `sudo aquacast-edge retry-rejected` |
| `clock looks wrong` / `clock differs ... s` | Pi time not set | internet time or the RTC |
| `offline ... kept on the SD card` | no internet | nothing to do; it uploads by itself later |
| `Another AquaCast edge program is already running` | started twice | use only the service (`systemctl`) |
| relay does not switch | wrong pin / active-low board | `AQUACAST_RELAY_PIN` (BCM number), `AQUACAST_RELAY_ACTIVE_HIGH=false` |

## How this matches `aquacast_logger.py`

| Logger | Here |
|---|---|
| `Hardware(port, light_address, do_address, baud)`; order sht20 → bmp280 → light → ph → do, 0.3 s apart | same (`aquacast_edge/sensors.py`) |
| error classes (CRC_ERROR, COMMUNICATION_ERROR, SENSOR_ERROR; pH never CRC), RS485 closed after a light/DO failure | same |
| ranges, pressure kPa × 10 → hPa (valid 300–1100), pH 0–3 V check, ADC range, NaN → SENSOR_ERROR | same |
| `AQUACAST_PH_ENABLED=0`, 60 s warm-up, 10-minute slots, no invented backfill, clock-backwards guard | same |
| local SQLite `raw_observations` + `cycles` archive (calibration labels, per-sensor times, errors) | local SQLite `readings` (+ `raw_payload` archive) and the upload outbox |
| timestamps written as +08:00 | sent as UTC (`Z`). Same moment; the dashboard shows Philippine time |

One small difference: a negative pH voltage is stored as empty, because the cloud database only
accepts voltages ≥ 0. The pH status still follows the logger's rule (OUT_OF_RANGE).

## Files

| File | What it is |
|---|---|
| `hardware/aquacast_hardware_pd1.py` | **the group's sensor driver** (you copy it here, B2) |
| `aquacast_edge/sensors.py` | the logger's reading rules, connected to the driver |
| `aquacast_edge/forecast.py` | **the trained model goes here** (`load_model`, `predict`) |
| `aquacast_edge/risk.py` | risk rule RISK-RULE-1.0 (same as the dashboard) |
| `aquacast_edge/runner.py` | the reading / upload / aerator loops |
| `aquacast_edge/store.py` | SD-card storage and outbox |
| `aquacast_edge/relay.py`, `api.py`, `health.py`, `config.py` | relay + buzzer, dashboard connection, Pi health, settings |
| `edge.env.example` | every setting, explained |
| `install.sh`, `aquacast-edge.service` | installer and auto-start service |
| `tests/` | `python3 -m unittest discover -s tests` (no hardware needed) |
