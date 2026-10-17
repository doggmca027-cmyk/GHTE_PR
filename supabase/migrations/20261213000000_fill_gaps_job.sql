-- =============================================================================
-- Filling the gaps runs as its own job
--
-- Inside the catalogue sync the fill step pushed RootPanel's run (35,000 services, an 11 MB catalogue) over the edge worker's resources.
-- sync-catalog { fillGaps: true } now does it apart: it reads the donor's services from the database (the panel is not asked), fills,
-- prices the new cards and rebuilds the variant groups. One donor per run, the one that waited longest (claim_gap_fill_provider); the
-- job runs every 15 minutes, two minutes after the catalogue sync's slots, so the two never meet (they share the sync-catalog lease).
-- =============================================================================

alter table public.providers
  add column if not exists gaps_filled_at timestamptz;

comment on column public.providers.gaps_filled_at is 'Last time a fill_gaps run of this donor started (claim_gap_fill_provider).';

-- RootPanel was switched off by hand while its catalogue sync could not carry the fill step; the separate job can.
update public.providers set fill_gaps = true where name in ('JAP', 'SMMFollows', 'SMMProvider', 'RootPanel') and not fill_gaps;

create or replace function public.claim_gap_fill_provider(p_due_minutes integer default 50)
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
   where is_active and routing_enabled and fill_gaps and catalog_mode = 'linked_only'
     and (gaps_filled_at is null or gaps_filled_at < now() - make_interval(mins => p_due_minutes))
   order by gaps_filled_at nulls first, priority desc, id
   limit 1
   for update skip locked;
  if v_id is not null then
    update providers set gaps_filled_at = now() where id = v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.claim_gap_fill_provider(integer) from public, anon, authenticated;
grant execute on function public.claim_gap_fill_provider(integer) to service_role;

-- The job: the catalogue sync's own call (its URL and secret come from that job), with { "fillGaps": true }.
do $$
declare
  v_command text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;
  select command into v_command from cron.job where jobname = 'sync-catalog';
  if v_command is null or position('body := ''{}''::jsonb' in v_command) = 0 then
    raise warning 'fill-storefront-gaps job not scheduled: the sync-catalog job is missing or has an unexpected body';
    return;
  end if;
  execute 'select cron.schedule($1, $2, $3)'
    using 'fill-storefront-gaps', '2-59/15 * * * *', replace(v_command, 'body := ''{}''::jsonb', 'body := ''{"fillGaps":true}''::jsonb');
exception when others then
  raise warning 'fill-storefront-gaps job not scheduled: %', sqlerrm;
end;
$$;
