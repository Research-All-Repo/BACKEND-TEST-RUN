'use strict';
/**
 * CSV of one database table, made by the database itself (migration 011, export_table_csv):
 * every column in the table's own order, the column names as the header, and each value as
 * PostgreSQL writes it (times in UTC, e.g. "2026-10-19 12:40:00+00"). Same structure as
 * Supabase -> Table Editor -> Export -> CSV, so files from both places can be combined.
 */
const { ApiError, fromSupabase } = require('./errors');
const { getAdminClient } = require('./supabase');

const PAGE = 1000;

async function tableCsv(table, timeColumn, from, to) {
  const lines = [];
  for (let offset = 0; offset < 300_000; offset += PAGE) {
    const { data, error } = await getAdminClient()
      .rpc('export_table_csv', { p_table: table, p_time_column: timeColumn || null, p_from: from || null, p_to: to || null })
      .range(offset, offset + PAGE - 1);
    if (error) {
      if (/export_table_csv|csv_field/.test(error.message || '') && /PGRST202|42883/.test(error.code || '')) {
        throw new ApiError(503, 'MIGRATION_MISSING', 'CSV export needs one database update: run supabase/migrations/011_csv_export.sql in Supabase -> SQL Editor.');
      }
      throw fromSupabase(error);
    }
    lines.push(...data);
    if (data.length < PAGE) break;
  }
  return lines.join('\r\n');
}

/** Send a CSV download. */
function sendCsv(res, filename, csv) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.set('Cache-Control', 'no-store');
  res.send(csv);
}

module.exports = { tableCsv, sendCsv };
