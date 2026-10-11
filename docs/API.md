# AquaCast API reference

Base: same origin as the dashboard (`/api/...`). All responses are JSON:

- success: `{ "data": ..., "meta": { ... } }`
- error: `{ "error": { "code": "SESSION_EXPIRED", "message": "...", "details": { } } }` → switch on `code`.

Rules for the frontend:
- `fetch(url, { credentials: 'same-origin' })`. Never handle tokens or Supabase keys.
- Every POST/PATCH must send header `X-AquaCast-Client: dashboard`.
- Send `Idempotency-Key: <uuid>` on aerator commands and activity creation so retries are safe.
- Timestamps are UTC ISO 8601; display them in `station.timezone` (Asia/Manila).
- Ranges: `?range=24h|7d|30d` or `?from=<ISO>&to=<ISO>`. Pagination: `?page=1&page_size=25`.

## Auth (no session needed)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | `{ email, password, remember }` | 200 → `{ user, profile }` + cookies. Errors: `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `ACCOUNT_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_REVOKED`, `RATE_LIMITED` |
| POST | `/api/auth/logout` | – | Revokes the Supabase session, clears cookies |
| GET | `/api/auth/session` | – | Restore a remembered session on page load |
| POST | `/api/auth/request-access` | `{ full_name, email, password, organization, position? }` | 202. Creates BFAR_STAFF/PENDING; verification email sent |
| POST | `/api/auth/forgot-password` | `{ email }` | Always 200 (no account enumeration) |
| POST | `/api/auth/set-password` | `{ access_token, password }` | Used by `set-password.html` for reset and invite links |

## Pages

### Live Status – `GET /api/live`
```
data.observation.timestamp_utc, record_status
data.observation.readings.{do_mg_l, do_saturation_pct, water_temp_c, ph_value, light_lux,
                           air_temp_c, relative_humidity_pct, atmospheric_pressure_hpa}
    → { label, value, unit, quality_status, usable }      (show "--" + quality_status when !usable)
data.risk.current_risk_state | forecast_outlook | expected_threshold_crossing_utc | rule_version
data.forecasts[4] → { horizon_minutes, predicted_do_mg_l, forecast_status, target_timestamp_utc, model }
data.critical_outlook, data.trend.{label, slope_mg_l_per_hr}
data.system_health (Pi CPU, RAM, storage, Wi-Fi, internet, buses, battery, last_cloud_sync_at_utc)
data.aerator (see Aerator), data.active_alerts, data.rule_reference, data.station
meta.freshness.{state: LIVE|SYNC_DELAYED|OFFLINE|NO_DATA, message, age_minutes}
```
Recent activity card: `GET /api/activities?range=7d&page_size=4`.

### Forecast & Risk
- `GET /api/forecast/latest[?observation_id=]` → `origin`, `horizons[4]` (+`change_from_origin_mg_l`, `threshold_status`), `summary`, `risk`, `rule_reference`
- `GET /api/forecast/history?horizon=60&range=24h` → forecast vs observed DO at each target time

### History & Trends
- `GET /api/history/summary?range=` → records, avg/min/max DO, net change, elevated/critical record counts, `risk_counts` per recorded risk state
- `GET /api/history/series?range=&bucket_minutes=` → bucketed averages of all 7 variables + worst risk (auto bucket ≈ 300 points)
- `GET /api/history/observations?range=&page=&page_size=&order=desc` → table rows + `recorded_risk_state` + `aeration_recorded`
- `GET /api/history/export.csv?range=` → CSV download (max 31 days)

### Alerts
- `GET /api/alerts?status=active|acknowledged|all&range=` → risk-state changes into WATCH/WARNING/CRITICAL, with DO evidence, min forecast, guidance, acknowledgement
- `POST /api/alerts/:riskId/acknowledge` `{ note? }` → `409 ALERT_ALREADY_ACKNOWLEDGED` if repeated

### Activity Log
- `GET /api/activities/types` → allowed `event_type` values + labels
- `GET /api/activities?category=&q=&range=&page=` → unified feed (`category`: POND_ACTIVITY, AERATION, MAINTENANCE, AERATOR_COMMAND, SYSTEM_WARNING, ALERT, USER_MANAGEMENT, SETTINGS)
- `GET /api/activities/summary?range=` → counts per category
- `POST /api/activities` `{ event_type, event_start_utc?, event_end_utc?, notes?, reason?, related_risk_id? }` → saved to Supabase `management_events` (BFAR_STAFF + ADMIN)
- `POST /api/activities/:eventId/close` `{ event_end_utc? }`

### Sensors & Device
- `GET /api/sensors` → registry rows + `monitored_variables`, `latest_readings`, `data_status` (OK/DEGRADED/FAULT), `bus`, `latest_calibration`; plus `system_health`
- `GET /api/sensors/:sensorId/calibrations`
- `GET /api/sensors/health?range=24h` → Pi health history

### Aerator (BFAR_STAFF + ADMIN)
- `GET /api/aerator` →
  - `mode.{requested_mode, applied_mode, settings_revision, applied_revision, acknowledged, status_text}`
  - `controller.{output_state, output_reported_at_utc, report_age_minutes, stale}` (acknowledgement, not motor proof)
  - `physical_feedback.available = false`
  - `pending_command`, `last_applied_command`, `recent_commands[]` (each with `effective_status`, `status_text`)
  - `can_request_manual_command`, `manual_command_blocked_reason`
- `POST /api/aerator/commands` `{ requested_state: "ON"|"OFF" }` → **202** PENDING. Errors: `AERATOR_NOT_IN_MANUAL_MODE`, `AERATOR_COMMAND_ALREADY_PENDING`, `AERATOR_NOT_INITIALIZED`
- `GET /api/aerator/commands/:commandId` → poll every 2–3 s until `effective_status` ≠ PENDING
- `POST /api/aerator/mode` `{ mode, automatic_rule_version? }` (ADMIN)

### Admin only (403 `FORBIDDEN` for BFAR_STAFF)
- **Model Evaluation:** `GET /api/evaluation`, `GET /api/evaluation/series?horizon=`
- **User Directory:** `GET /api/users?status=&q=`; `POST /api/users/:id/approve {role?}`, `/reject {reason}`, `/suspend {reason}`, `/reactivate {role?}`, `/revoke {reason}`, `/role {role}`; `PATCH /api/users/:id {full_name?, organization?, position?}`; `POST /api/users/invite {email, full_name, organization, role}`
- **System Settings:** `GET /api/settings` (study_metadata, aerator settings, locked study parameters); `PATCH /api/settings/study` (only: site_description, culture_species, culture_stage, culture_system, timezone, notes, pond_length_m, pond_width_m, pond_depth_m, probe_depth_m, deployment_end_utc)
- **Mock edge (dev only, when MOCK_EDGE_ENABLED):** `GET /api/dev/mock-edge`, `POST /api/dev/mock-edge {offline: bool}` or `{tick: true}`

## Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad input (see `message`, `details`) |
| 401 | `SESSION_MISSING`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` | Sign in again |
| 403 | `EMAIL_NOT_VERIFIED`, `ACCOUNT_PENDING`, `ACCOUNT_SUSPENDED`, `ACCOUNT_REVOKED`, `ACCOUNT_NOT_AUTHORIZED`, `FORBIDDEN`, `CANNOT_MODIFY_SELF`, `CSRF_REJECTED` | Not allowed |
| 404 | `NOT_FOUND` | |
| 409 | `AERATOR_*`, `ALERT_ALREADY_ACKNOWLEDGED`, `INVALID_TRANSITION`, `LAST_ACTIVE_ADMIN`, `DUPLICATE`, `EMAIL_ALREADY_REGISTERED` | State conflict |
| 429 | `RATE_LIMITED` | `details.retry_after_seconds` |
| 502 | `SUPABASE_REQUEST_FAILED` | Database rejected/failed the request |
| 503 | `SUPABASE_UNAVAILABLE` | Database unreachable |
