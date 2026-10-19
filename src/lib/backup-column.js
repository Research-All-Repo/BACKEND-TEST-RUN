'use strict';
/**
 * Whether raw_observations already has the filled_from_backup column (migration 010). Selects add it
 * only when it exists, so the dashboard keeps working if the migration has not been run yet.
 * Checked at most every 5 minutes per server instance.
 */
const { getAdminClient } = require('./supabase');

let known = null;
let checkedAt = 0;

async function hasBackupColumn() {
  if (known === true) return true;
  if (known === false && Date.now() - checkedAt < 5 * 60_000) return false;
  const { error } = await getAdminClient().from('raw_observations').select('filled_from_backup').limit(1);
  known = !error;
  checkedAt = Date.now();
  return known;
}

/** ", filled_from_backup" or "" to append to a column list */
async function backupColumn() {
  try { return (await hasBackupColumn()) ? ', filled_from_backup' : ''; } catch { return ''; }
}

module.exports = { hasBackupColumn, backupColumn };
