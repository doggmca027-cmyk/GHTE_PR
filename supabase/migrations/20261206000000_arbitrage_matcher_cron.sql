-- =============================================================================
-- The Smart Arbitrage matcher runs inside the database
--
-- Called through the API (the catalogue sync, the admin button) the matcher hit the 8 s statement timeout of API requests on production:
-- it compares every storefront service with ~67,000 donor services. pg_cron calls run_arbitrage_matcher() every 5 minutes instead (no
-- such limit there); it runs the matcher when the last run is older than 55 minutes, or at once when an admin asked for it
-- (admin_refresh_arbitrage only records the request).
-- =============================================================================

alter table public.arbitrage_state add column if not exists requested_at timestamptz;

create or replace function public.run_arbitrage_matcher()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from arbitrage_state
              where id = 1
                and (refreshed_at is null or refreshed_at < now() - interval '55 minutes' or requested_at > refreshed_at)) then
    return refresh_arbitrage_candidates(0.25, 500, 0);
  end if;
  return jsonb_build_object('skipped', true);
end;
$$;

revoke all on function public.run_arbitrage_matcher() from public, anon, authenticated;
grant execute on function public.run_arbitrage_matcher() to service_role;

create or replace function public.admin_refresh_arbitrage(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_catalog_admin(p_actor);
  update arbitrage_state set requested_at = now() where id = 1;
  return jsonb_build_object('queued', true);
end;
$$;

-- every 5 minutes (only where pg_cron is installed; never fails a deploy)
do $$
begin
  if to_regclass('cron.job') is not null then
    execute 'select cron.schedule($1, $2, $3)' using 'arbitrage-matcher', '*/5 * * * *', 'select public.run_arbitrage_matcher()';
  end if;
exception when others then
  raise warning 'arbitrage-matcher job not scheduled: %', sqlerrm;
end;
$$;
