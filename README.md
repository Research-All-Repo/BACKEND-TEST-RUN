# AquaCast Backend (Render test deployment)

Node/Express backend for the AquaCast dashboard. It provides real sign-in with
**Supabase Auth**, role/status checks from **`user_access_profiles`**, the API
for all dashboard pages, secured aerator **requests** (never direct control), and
a **mock edge device** that fills Supabase with simulated data until the
Raspberry Pi is connected.

```
Browser (placeholder or your groupmate's frontend)
   │  same-origin fetch, httpOnly session cookies, no Supabase keys in the browser
   ▼
Render web service (this repo)  ── Express API /api/*
   │  user's own JWT  -> PostgREST (Row Level Security + RPC checks apply)
   │  service-role key -> Auth admin only (ban/unban, invite, sign-out) + mock edge
   ▼
Supabase: Auth  +  Postgres (12 PD-1.0 tables + 2 access tables)
   ▲
Raspberry Pi edge sync (later)  /  mock edge simulator (now)
```

## Contents

| Path | What it is |
|---|---|
| `supabase/000_preflight_check.sql` | Read-only check of what is already in your Supabase project |
| `supabase/migrations/001_pd10_core_schema.sql` | The 12 PD-1.0 tables (144 attributes, 8 FKs, triggers, `forecast_details`) |
| `supabase/migrations/002_dashboard_access.sql` | `user_access_profiles`, audit log, RLS, RPCs, views |
| `src/` | Express app (`app.js`), routes, auth middleware, mock edge |
| `public/` | Placeholder frontend wired to every endpoint |
| `scripts/` | `seed-mock-data`, `create-admin`, `run-edge-simulator` |
| `tests/` | Integration tests (19) + unit tests (4) |
| `docs/API.md` | Endpoint reference and page-by-page field map for the frontend |
| `render.yaml` | Render Blueprint |

---

## 1. Set up Supabase

1. Open **SQL Editor** and run `supabase/000_preflight_check.sql`.
   - All **NOT PRESENT** → fresh project: run `001`, then `002`.
   - All **OK** → PD-1.0 is already installed: run `002` only.
   - Any **CONFLICT** / **OTHER TABLE** → the older (September) AquaCast schema is still there.
     Use a **new Supabase project** (simplest), or back up and drop the old tables first.
2. Run `supabase/migrations/001_pd10_core_schema.sql`, then `002_dashboard_access.sql`. Both are safe to re-run.
3. **Authentication → Sign In / Providers → Email**: keep **Confirm email** ON. That is what makes "verified account" work.
4. **Authentication → URL Configuration**
   - Site URL: your Render URL, e.g. `https://aquacast-backend.onrender.com`
   - Redirect URLs: add `https://aquacast-backend.onrender.com/set-password.html` and `https://aquacast-backend.onrender.com/?verified=1`
     (add the `http://localhost:3000/...` versions too for local testing).
5. **Project Settings → API**: copy the Project URL, the **anon/publishable** key and the **service_role/secret** key.
   The secret key only ever goes into Render environment variables or your local `.env`.
6. Supabase's built-in email sender is rate-limited to a few emails per hour. For real use (sign-up
   verification, invites, password resets) set up custom SMTP under **Authentication → Emails**.

## 2. Run locally

```bash
cp .env.example .env          # fill in the three SUPABASE_* values
npm ci
npm run seed -- --days 7      # 7 days of simulated cycles, forecasts, risk, activities
npm run create-admin -- --email you@example.com --name "Your Name" --password "a-long-password"
npm run dev                   # http://localhost:3000
```

With `MOCK_EDGE_ENABLED=true` the server also acts as the Raspberry Pi: a new 10-minute cycle appears on
schedule and aerator requests are acknowledged after `MOCK_EDGE_ACK_DELAY_SECONDS`.

## 3. Deploy to Render

1. Push this folder to a GitHub repository (`.env` is git-ignored).
2. Render → **New + → Blueprint** → select the repo (uses `render.yaml`), or **New Web Service** with
   build `npm ci --omit=dev`, start `npm start`, health check `/healthz`.
3. Set the environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `PUBLIC_SITE_URL` (the Render URL). Keep `MOCK_EDGE_ENABLED=true` until the Pi syncs.
4. Seed once from your own machine (`npm run seed`) and create the first admin (`npm run create-admin`).
   Render's free plan has no shell, so these run locally against the same Supabase project.

Free-plan note: Render sleeps the service after ~15 minutes without traffic, so the mock edge pauses too.
On wake it backfills up to `MOCK_EDGE_BACKFILL_HOURS`. A longer gap shows as **OFFLINE** on the
dashboard, which is the correct behaviour for a missing edge device.

## 4. Accounts: ADMIN/ACTIVE, BFAR_STAFF/ACTIVE, BFAR_STAFF/PENDING

Credentials live in **Supabase Auth**. Role and status live in **`user_access_profiles`**:
`role ∈ {ADMIN, BFAR_STAFF}`, `status ∈ {PENDING, ACTIVE, SUSPENDED, REVOKED}`.

| Account | How to create it for testing |
|---|---|
| ADMIN / ACTIVE | `npm run create-admin -- --email ... --password ...` (bootstrap; there is no admin to approve the first one) |
| BFAR_STAFF / PENDING | Use **Request Access** on the sign-in page. A database trigger creates the profile as BFAR_STAFF/PENDING. |
| BFAR_STAFF / ACTIVE | Request access, verify the email, then an admin clicks **Approve** in User Directory (or **Invite Authorized User**). |

Sign-in succeeds only when all three hold: correct password, **email confirmed**, and profile **ACTIVE**.
Otherwise the session Supabase just created is revoked and the API answers `INVALID_CREDENTIALS`,
`EMAIL_NOT_VERIFIED`, `ACCOUNT_PENDING`, `ACCOUNT_SUSPENDED` or `ACCOUNT_REVOKED`.
Status is re-checked on every request, so a suspension takes effect immediately; suspend/revoke also
bans the user in Supabase Auth so tokens cannot be refreshed.

Admin guardrails (enforced in the database): an admin cannot change their own role/status, the last
active admin cannot be removed, and suspend/revoke/reject require a reason. Every change is written to
`dashboard_audit_log` and shows in the Activity Log.

## 5. Security model

- **No keys in the browser.** The frontend only calls `/api/*` on the same origin. Supabase URL/keys exist only in server env vars.
- **Sessions** are Supabase access/refresh tokens in `httpOnly`, `Secure`, `SameSite=Lax` cookies. "Remember me" makes them persistent; otherwise they end with the browser session. Expired access tokens are refreshed automatically.
- **CSRF:** every non-GET request must send `X-AquaCast-Client: dashboard`, and a cross-site `Origin` is rejected.
- **Least privilege:** normal queries run as the signed-in user (RLS applies). The service-role key is used only for Auth admin actions and the mock edge.
- **RLS:** ACTIVE users can read the 12 research tables. Nobody can insert/update/delete from the dashboard side except through the RPCs, which re-check the caller's status and role inside the database.
- **Rate limits** on login, sign-up, password reset.

## 6. Aerator: request ≠ running

`POST /api/aerator/commands` calls the `request_aerator_command` RPC, which inserts a **PENDING**
`MANUAL_DASHBOARD` command with an expiry (default 120 s). It is refused if the controller has not
acknowledged MANUAL mode or another request is still pending. The dashboard never touches
`controller_output_state`.

The Raspberry Pi (now: mock edge) then validates and writes the outcome:
`APPLIED` (sets `applied_at_utc`, reports `controller_output_state`, opens/closes the AERATION event),
`REJECTED`, `FAILED`, `EXPIRED`, or `CANCELLED` (made obsolete by a newer mode revision).

The API reports three things separately: what was **requested**, what the **controller acknowledged**
(with report age / stale flag), and **physical motor state = not measured**. If a request passes its
expiry without an acknowledgement, the API shows `EXPIRED_NOT_ACKNOWLEDGED` without rewriting the
edge-owned status.

Mode changes (`MANUAL` ↔ `AUTOMATIC`, admin only) bump `settings_revision`; the controller confirms by
setting `applied_mode` / `applied_revision`.

## 7. Error, loading and offline states

| Situation | What the API returns | Placeholder UI behaviour |
|---|---|---|
| No data yet | `meta.freshness.state = NO_DATA`, `observation: null` | Empty-state message |
| Edge offline | `freshness.state = OFFLINE` (no new cycle for ≥ 60 min) | Red banner, last values kept |
| Sync delayed | `freshness.state = SYNC_DELAYED` (≥ 25 min, or Pi reports no internet) | Amber banner |
| Stale controller report | `aerator.controller.stale = true` | "STALE" in the aerator panel |
| Session expired / invalid | `401 SESSION_EXPIRED` / `SESSION_MISSING` | Back to sign-in with the reason |
| Unauthorized user | `403 FORBIDDEN` (role), `403 ACCOUNT_*` (status) | Message; admin pages hidden for staff |
| Supabase unreachable | `503 SUPABASE_UNAVAILABLE` | Error box + banner, retries every 60 s |
| Supabase request failed | `502 SUPABASE_REQUEST_FAILED` | Error box |
| Browser offline | (no request) | Grey banner, uses last loaded data |

Thresholds are configurable with `SYNC_DELAYED_AFTER_MINUTES`, `EDGE_OFFLINE_AFTER_MINUTES`, `AERATOR_REPORT_STALE_MINUTES`.

## 8. When the real Raspberry Pi is ready

Set `MOCK_EDGE_ENABLED=false`. The Pi's sync service (service-role or a dedicated key, never in the
browser) must do what `src/mock/edge-simulator.js` does: insert cycles in FK order
(observations → health → forecasts → risk), poll PENDING `MANUAL_DASHBOARD` commands, check expiry and
applied mode, write the outcome, acknowledge mode revisions, and update `output_reported_at_utc` as a
heartbeat. The database triggers will reject anything that breaks PD-1.0 rules.

## 9. Moving to Vercel later

`api/index.js` exports the same Express app and `vercel.json` routes `/api/*` to it; `public/` is
served statically. Set the same env vars in Vercel. Run the mock edge separately (`npm run simulate`)
because serverless functions cannot keep a background timer.

## 10. Decisions to review (not specified in LS-1.0 / PD-1.0)

- Two access-layer tables were added **outside** the 12 research relations: `user_access_profiles` and `dashboard_audit_log`. The LS-1.0 counts (12 / 144 / 8) are unchanged.
- **Alerts** are derived from `risk_assessments` (the cycle where the risk state changes into WATCH/WARNING/CRITICAL). Acknowledgements are stored in `dashboard_audit_log`, because LS-1.0 has no alert table.
- **Risk thresholds** (3.0 / 5.0 mg/L) are not stored in LS-1.0; the backend keeps a read-only registry keyed by `rule_version` for chart lines and explanations. The official state always comes from `risk_assessments`.
- `management_events` has no "recorded by" column, so the dashboard author is kept in the audit log.
- Frontend activity types without an LS-1.0 value (liming, probiotics, biomass sampling) are saved as `OTHER` with notes. A manually logged `AERATION` needs an end time, so it cannot collide with the controller's open session.
- There is no "cancel command" button: the edge owns command lifecycle fields (PD-1.0 §8). To undo an ON request, send OFF.
- Model Evaluation shows **operational** metrics from stored forecasts vs observations. With mock data these are not thesis results; the page says so.

## Tests

```bash
npm test     # needs the server running with MOCK_EDGE_ENABLED=true against a TEST project
```
Covers: wrong password, cookies, missing/invalid session, CSRF, pending/unverified accounts, approval,
role limits, every page endpoint, activity save + idempotency, direct-write blocking through RLS,
aerator request → acknowledgement, mode change, suspension, admin guardrails, alert acknowledgement,
logout revocation, freshness states, risk rules, Supabase-unreachable mapping.
