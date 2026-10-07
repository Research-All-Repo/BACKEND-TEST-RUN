'use strict';
const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const baseOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' },
  global: { headers: { 'x-application-name': 'aquacast-backend' } },
};

let adminClient = null;

/**
 * Privileged client (service-role key). Bypasses RLS.
 * Used ONLY for: Supabase Auth admin actions (ban/unban/invite/sign-out),
 * reading auth metadata for the User Directory, and the mock edge simulator.
 */
function getAdminClient() {
  if (!adminClient) {
    adminClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, baseOptions);
  }
  return adminClient;
}

/** Fresh anon client for auth calls (sign-in, sign-up, refresh). One per call: no shared session state. */
function createAuthClient() {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, baseOptions);
}

/**
 * Client that acts AS the signed-in user: PostgREST receives the user's JWT,
 * so Row Level Security and the RPC permission checks apply to every query.
 */
function createUserClient(accessToken) {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    ...baseOptions,
    global: { headers: { ...baseOptions.global.headers, Authorization: `Bearer ${accessToken}` } },
  });
}

module.exports = { getAdminClient, createAuthClient, createUserClient };
