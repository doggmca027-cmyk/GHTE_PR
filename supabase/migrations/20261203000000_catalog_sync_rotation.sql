-- =============================================================================
-- Catalogue sync: one provider per run, in rotation
--
-- The hourly run synced every routing-enabled provider in ONE Edge Function invocation. With Smart Arbitrage on, that is 7 catalogues
-- (~67,000 services, RootPanel alone 35,000) and every run since 2026-10-16 07:00 UTC died with 546 WORKER_RESOURCE_LIMIT: no catalogue
-- was refreshed, the storefront kept old prices.
--
-- Now a run takes ONE provider that is due (last good sync older than 50 minutes), the one whose last attempt is the oldest first, and
-- the scheduler calls the function every 5 minutes (12 runs an hour for 7 providers: each is refreshed about hourly). The attempt is
-- stamped BEFORE the work, so a provider whose run is killed goes to the back of the line instead of blocking the others; a run that
-- is still going (attempt younger than 15 minutes) is never handed out twice.
-- =============================================================================

alter table public.providers
  add column if not exists catalog_sync_started_at timestamptz,
  add column if not exists catalog_synced_at timestamptz;

comment on column public.providers.catalog_sync_started_at is 'Last time a catalogue sync of this provider started (claim_catalog_sync_provider).';
comment on column public.providers.catalog_synced_at is 'Last time a catalogue sync of this provider finished (finish_catalog_sync).';

-- What the old all-in-one run last achieved, so the rotation starts with the providers that waited longest.
update public.providers p
   set catalog_synced_at = s.last_sync
  from (select provider_id, max(last_synced_at) last_sync from public.provider_services group by provider_id) s
 where s.provider_id = p.id and p.catalog_synced_at is null;

create or replace function public.claim_catalog_sync_provider(p_due_minutes integer default 50)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from providers
   where is_active and routing_enabled
     and (catalog_synced_at is null or catalog_synced_at < now() - make_interval(mins => p_due_minutes))
     and (catalog_sync_started_at is null or catalog_sync_started_at < now() - interval '15 minutes')
   order by catalog_sync_started_at nulls first, catalog_synced_at nulls first, priority desc, id
   limit 1
   for update skip locked;
  if v_id is not null then
    update providers set catalog_sync_started_at = now() where id = v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.finish_catalog_sync(p_provider_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update providers set catalog_synced_at = now() where id = p_provider_id;
$$;

revoke all on function public.claim_catalog_sync_provider(integer) from public, anon, authenticated;
revoke all on function public.finish_catalog_sync(uuid) from public, anon, authenticated;
grant execute on function public.claim_catalog_sync_provider(integer) to service_role;
grant execute on function public.finish_catalog_sync(uuid) to service_role;

-- The scheduler: every 5 minutes instead of hourly (only where pg_cron is installed and the job exists; it was created by hand).
do $$
declare
  v_job bigint;
begin
  if to_regclass('cron.job') is not null then
    execute 'select jobid from cron.job where jobname = $1' into v_job using 'sync-catalog';
    if v_job is not null then
      execute 'select cron.alter_job(job_id := $1, schedule := $2)' using v_job, '*/5 * * * *';
    end if;
  end if;
exception when others then
  -- never fail the deploy over the schedule: the owner can change it by hand (cron.alter_job)
  raise warning 'sync-catalog schedule not changed: %', sqlerrm;
end;
$$;
