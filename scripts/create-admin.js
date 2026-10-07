'use strict';
/**
 * Bootstrap the first Administrator (there is no admin to approve anyone yet).
 *   npm run create-admin -- --email you@example.com --name "Your Name" [--password "..."]
 * Without --password an existing account is promoted (sign up first via Request Access).
 * Uses the service-role key; run it on your own machine, never in the browser.
 */
require('./_env');
const config = require('../src/config');
config.validate();
const { getAdminClient } = require('../src/lib/supabase');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = String(arg('email') || '').trim().toLowerCase();
  const name = arg('name') || 'AquaCast Administrator';
  const password = arg('password');
  if (!email) throw new Error('--email is required');
  const db = getAdminClient();

  let userId;
  if (password) {
    if (password.length < 10) throw new Error('Password must be at least 10 characters');
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true,
      user_metadata: { full_name: name, organization: 'AquaCast Project Administration' } });
    if (error && !/already/i.test(error.message)) throw error;
    userId = data?.user?.id;
  }
  if (!userId) {
    const { data, error } = await db.from('user_access_profiles').select('user_id').ilike('email', email).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`No account found for ${email}. Pass --password to create one.`);
    userId = data.user_id;
    await db.auth.admin.updateUserById(userId, { email_confirm: true });
  }
  const { error } = await db.from('user_access_profiles').update({ role: 'ADMIN', status: 'ACTIVE', full_name: name,
    status_reason: 'Bootstrap administrator', reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) throw error;
  await db.auth.admin.updateUserById(userId, { ban_duration: 'none' });
  console.log(`OK: ${email} is now an ACTIVE ADMIN (user_id ${userId}).`);
}

main().catch((err) => { console.error('create-admin failed:', err.message); process.exit(1); });
