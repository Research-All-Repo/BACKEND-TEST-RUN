-- =====================================================================
-- 011: CSV export with exactly the table's own structure
-- The dashboard's CSV downloads (System Settings -> Data Export, History -> Export CSV) are made by
-- the database itself: every column of the table, in the table's order, with the column names as
-- the header and each value written the way PostgreSQL writes it (times in UTC as
-- "2026-10-19 12:40:00+00"), the same as Supabase -> Table Editor -> Export -> CSV.
-- Only the server (service role) may call it, and only for the tables listed below.
-- Run once in Supabase -> SQL Editor. Safe to re-run.
-- =====================================================================

create or replace function public.csv_field(v text)
returns text language sql immutable as $$
  select case
    when v is null then ''
    when v ~ '[",\r\n]' or v ~ '^\s' or v ~ '\s$' then '"' || replace(v, '"', '""') || '"'
    else v
  end
$$;

create or replace function public.export_table_csv(p_table text, p_time_column text, p_from timestamptz, p_to timestamptz)
returns setof text
language plpgsql stable
set search_path = public
set timezone = 'UTC'
as $$
declare
  header text;
  fields text;
  sql text;
begin
  if p_table not in ('raw_observations', 'system_health', 'forecasts', 'risk_assessments', 'risk_alerts',
                     'management_events', 'aerator_commands', 'alert_dispatches', 'alert_deliveries',
                     'dashboard_audit_log', 'forecast_models', 'sensor_registry', 'sensor_calibrations') then
    raise exception 'table % cannot be exported', p_table using errcode = '22023';
  end if;

  select string_agg(public.csv_field(c.column_name::text), ',' order by c.ordinal_position),
         string_agg(format('public.csv_field(%I::text)', c.column_name), ' || '','' || ' order by c.ordinal_position)
    into header, fields
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = p_table;

  return next header;

  if p_time_column is null then
    sql := format('select %s from public.%I order by 1', fields, p_table);
    return query execute sql;
  else
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = p_table and column_name = p_time_column) then
      raise exception 'column %.% does not exist', p_table, p_time_column using errcode = '22023';
    end if;
    sql := format('select %s from public.%I where %I >= $1 and %I < $2 order by %I, 1',
                  fields, p_table, p_time_column, p_time_column, p_time_column);
    return query execute sql using p_from, p_to;
  end if;
end
$$;

revoke all on function public.csv_field(text) from public, anon, authenticated;
revoke all on function public.export_table_csv(text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.csv_field(text) to service_role;
grant execute on function public.export_table_csv(text, text, timestamptz, timestamptz) to service_role;
