'use strict';
/**
 * Seed Supabase with simulated AquaCast data (service-role key, run locally).
 *   npm run seed -- --days 7
 * Idempotent: deterministic IDs, existing rows are left untouched.
 */
require('./_env');
const config = require('../src/config');
config.validate();
const { getAdminClient } = require('../src/lib/supabase');
const G = require('../src/mock/generator');
const { ensureReference, pushCycles, insertBatches } = require('../src/mock/edge-simulator');

async function main() {
  const arg = process.argv.indexOf('--days');
  const days = Math.min(60, Math.max(1, Number(arg > -1 ? process.argv[arg + 1] : 7) || 7));
  const db = getAdminClient();
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400_000);
  console.log(`Seeding ${days} day(s) of mock data into ${config.supabaseUrl} ...`);

  const { study, models } = await ensureReference(db, { deploymentStart: from });
  const depStart = new Date(study.deployment_start_utc);
  const start = depStart > from ? depStart : from;

  let total = 0;
  for (let t = start.getTime(); t < now.getTime() - 60_000; t += 86400_000) {
    const chunkEnd = new Date(Math.min(t + 86400_000 - G.CYCLE_MS, now.getTime() - 60_000));
    total += await pushCycles(db, { from: new Date(t), to: chunkEnd, study, models });
    process.stdout.write(`\r  cycles: ${total}`);
  }
  console.log();

  const events = G.historicalEvents(start, new Date(now.getTime() - 30 * 60_000));
  await insertBatches(db, 'management_events', events, 'event_id');
  console.log(`  management events: ${events.length}`);

  // one sample-based biomass estimate per week of history
  const volume = G.POND.length * G.POND.width * G.POND.depth;
  const bio = [];
  for (let w = 1; w * 7 <= days; w += 1) {
    const at = new Date(start.getTime() + w * 7 * 86400_000);
    const weight = 85 + w * 21;
    const kg = Math.round(156 * weight) / 1000;
    bio.push({ biomass_record_id: G.uuidFromName(`biomass:sample:${w}`), measured_at_utc: at.toISOString(), estimated_fish_count: 156,
      mean_fish_weight_g: weight, total_biomass_kg: kg, biomass_density_kg_m3: Math.round((kg / volume) * 10000) / 10000,
      estimation_method: 'SAMPLE_BASED_ESTIMATE', sample_size: 20, notes: `Weekly weight sampling, week ${w} (mock).`,
      recorded_at_utc: new Date(at.getTime() + 3600_000).toISOString(), sync_status: 'SYNCED' });
  }
  if (bio.length) await insertBatches(db, 'biomass_records', bio, 'biomass_record_id');

  const counts = {};
  for (const tname of ['raw_observations', 'forecasts', 'risk_assessments', 'management_events']) {
    const { count } = await db.from(tname).select('*', { count: 'exact', head: true });
    counts[tname] = count;
  }
  console.log('Done.', counts);
}

main().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
