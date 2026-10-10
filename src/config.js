'use strict';
// Central configuration. Every secret comes from environment variables
// (Vercel/Render dashboard -> Environment Variables). Nothing here is ever sent to the browser.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const isProduction = process.env.NODE_ENV === 'production';

const config = {
  isProduction,
  port: num('PORT', 3000),

  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  // The anon key is used only server-side here (login, sign-up, user-scoped queries).
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  // Privileged key: bypasses RLS. Server-only. Never log it, never return it.
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // Public URL of this deployment (used for password-reset and invite email links)
  // On Vercel it falls back to the production domain Vercel exposes at runtime.
  publicSiteUrl: (process.env.PUBLIC_SITE_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
    || `http://localhost:${num('PORT', 3000)}`).replace(/\/+$/, ''),
  isVercel: !!process.env.VERCEL,

  cookieSecure: bool('COOKIE_SECURE', isProduction),
  rememberMeDays: num('REMEMBER_ME_DAYS', 30),
  trustProxy: num('TRUST_PROXY', 1),

  // Data-freshness thresholds for the 10-minute AquaCast cycle
  syncDelayedAfterMinutes: num('SYNC_DELAYED_AFTER_MINUTES', 25),
  edgeOfflineAfterMinutes: num('EDGE_OFFLINE_AFTER_MINUTES', 60),
  aeratorReportStaleMinutes: num('AERATOR_REPORT_STALE_MINUTES', 20),
  aeratorCommandTtlSeconds: num('AERATOR_COMMAND_TTL_SECONDS', 120),

  // Web Push (instant phone alerts). Generate keys with: npx web-push generate-vapid-keys
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@aquacast.local',
    hookSecret: process.env.PUSH_HOOK_SECRET || '',
    criticalReminderMinutes: num('PUSH_CRITICAL_REMINDER_MINUTES', 30),
  },

  // Mock edge device (simulates the Raspberry Pi pushing data and acknowledging commands)
  mockEdge: {
    enabled: bool('MOCK_EDGE_ENABLED', false),
    tickSeconds: num('MOCK_EDGE_TICK_SECONDS', 30),
    backfillHours: num('MOCK_EDGE_BACKFILL_HOURS', 24),
    ackDelaySeconds: num('MOCK_EDGE_ACK_DELAY_SECONDS', 15),
    startOffline: bool('MOCK_EDGE_START_OFFLINE', false),
    // 'background' = timer inside a long-running server (Render / local).
    // 'on-request' = no timers; a throttled catch-up tick runs on signed-in API requests (Vercel / serverless).
    mode: process.env.MOCK_EDGE_MODE || (process.env.VERCEL ? 'on-request' : 'background'),
    minIntervalSeconds: num('MOCK_EDGE_MIN_INTERVAL_SECONDS', 20),
  },
};

// Risk-rule reference values. These are NOT stored in the LS-1.0 schema
// (risk_assessments only stores rule_version), so they are kept here as a
// read-only registry for chart lines and explanations. The official risk
// state always comes from risk_assessments.current_risk_state.
config.riskRules = {
  'RISK-RULE-1.0': {
    critical_do_mg_l: 3.0,
    watch_boundary_do_mg_l: 5.0,
    description: [
      'NORMAL: current DO >= 5.0 mg/L and all forecasts >= 5.0 mg/L',
      'WATCH: current DO >= 5.0 mg/L and at least one forecast > 3.0 but < 5.0 mg/L',
      'WARNING: current DO > 3.0 but < 5.0 mg/L, or any forecast <= 3.0 mg/L',
      'CRITICAL: current observed DO <= 3.0 mg/L',
      'DATA_UNAVAILABLE: current DO or required forecasts unavailable',
    ],
  },
};
config.defaultRuleVersion = 'RISK-RULE-1.0';

config.validate = function validate() {
  const missing = ['supabaseUrl', 'supabaseAnonKey', 'supabaseServiceRoleKey'].filter((k) => !config[k]);
  if (missing.length) {
    const names = { supabaseUrl: 'SUPABASE_URL', supabaseAnonKey: 'SUPABASE_ANON_KEY', supabaseServiceRoleKey: 'SUPABASE_SERVICE_ROLE_KEY' };
    throw new Error(`Missing required environment variables: ${missing.map((k) => names[k]).join(', ')}`);
  }
};

module.exports = config;
