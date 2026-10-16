-- =============================================================================
-- Smart Arbitrage: automatic matching of cheaper donor services
--
-- For every storefront service the database looks for the SAME service at the donors (routing-enabled providers other than the ones
-- already serving it) that costs at least 25% less than the cheapest offer the service has now.
--
-- "The same service" is decided on a fingerprint of the names (service_fingerprint): the storefront's English name (written by the
-- catalogue translator) against the donor panel's own name.
--   base    what is delivered: the words outside the brackets ("telegram members", "spotify playlist plays")
--   tags    every other bracketed fact (quality, country, audience, reaction emoji...), sorted; delivery parameters are left out
--           (max, min, start time, speed, server, drip-feed): they say how fast, not what
--   refill  the guarantee in days ("0" = none, "life" = lifetime), "unstated" when the name says nothing, "unknown" when it is unclear
--
-- A pair is linked AUTOMATICALLY only when nothing is in doubt: same base, same tags, the same STATED guarantee, the donor accepts the
-- whole quantity range the storefront sells (its min <= ours, its max >= ours) and it is at least 25% cheaper. One offer per donor
-- provider and service (the cheapest such pair); a service with a refill button needs a donor panel that does refills. For every other
-- service, the closest cheaper pair with the same base (fewest doubts, then cheapest) goes to arbitrage_candidates as `pending` with
-- the reasons (details / refill / limits) for an admin to approve or reject: never linked by itself. A pair an admin rejected, or an
-- automatic link an admin removed, is never proposed again.
--
-- The storefront price is not touched: the price is built on the most expensive usable offer (service-cost.ts), so a cheaper offer only
-- widens the margin; routing takes the cheapest offer that can take the order (and fails over when a donor has no balance).
-- =============================================================================

create or replace function public.service_fingerprint(p_name text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v       text := lower(coalesce(p_name, ''));
  v_base  text;
  v_tags  text[] := '{}';
  v_raw   text;
  v_tag   text;
  v_refill text := 'unstated';
  v_num   integer;
  m       text[];
begin
  v := translate(v, '(){}', '[][]');
  -- decoration: country flags (the country is also written out) and the markers panels sprinkle on names
  v := regexp_replace(v, '[\U0001F1E6-\U0001F1FF️‍💧⛔♻🔥🟢🔵🔴🟡🟣🟠🟤⚫⚪⚡⏳⌛💎❌✅✔➜➡→⭐🌟✨🆕🚀🏆💯🎁📊🤖]', ' ', 'g');
  -- punctuation that is not a value separator
  v := regexp_replace(v, '[!"#$&''*;<=>?@\\^_`~]', ' ', 'g');
  for m in select regexp_matches(v, '\[([^\]]*)\]', 'g') loop
    -- one bracket can hold several facts: "[ cheap | 10-20k/day | refill : lifetime ]"
    foreach v_raw in array string_to_array(m[1], '|') loop
      v_tag := btrim(regexp_replace(v_raw, '\s+', ' ', 'g'));
      continue when v_tag = '';
      -- how and how fast it is delivered, not what is delivered
      continue when v_tag ~ '^(max|min|start|starts|start time|speed|time|delivery|drip|drip-feed|server|day speed|per day|\d[\d.,k+ -]*/\s*(d|day|days|h|hr|hour|hours))\M';
      if v_tag ~ '(refill|guarantee|guaranteed|garanty|warranty)' or v_tag ~ '^r\d+$' then
        if v_tag ~ 'no ?drop|low ?drop|non ?drop' then
          v_refill := 'unknown';
        elsif v_tag ~ '(\mno\M|\mnon\M|without|\m0 ?(d|days?)\M)' then
          v_refill := '0';
        elsif v_tag ~ '(lifetime|life time|forever|permanent)' then
          v_refill := 'life';
        elsif v_tag ~ '\d' then
          v_num := substring(v_tag from '(\d+)')::integer;
          v_refill := case
            when v_tag ~ '\d+ ?(y|yr|year|years)\M' then (v_num * 365)::text
            when v_tag ~ '\d+ ?(m|mo|month|months)\M' then (v_num * 30)::text
            else v_num::text end;
        else
          v_refill := 'unknown';
        end if;
        continue;
      end if;
      v_tags := v_tags || v_tag;
    end loop;
  end loop;
  -- the base: words only (any emoji outside the brackets is decoration)
  v_base := regexp_replace(v, '\[[^\]]*\]', ' ', 'g');
  v_base := btrim(regexp_replace(regexp_replace(v_base, '[^[:alnum:][:space:]+/.-]', ' ', 'g'), '\s+', ' ', 'g'));
  return jsonb_build_object(
    'base', v_base,
    'tags', coalesce((select string_agg(t, ',' order by t) from unnest(v_tags) t), ''),
    'refill', v_refill);
end;
$$;

revoke all on function public.service_fingerprint(text) from public, anon, authenticated;
grant execute on function public.service_fingerprint(text) to service_role;

-- The donor side is stored (67,000 names: computing it inside the matcher would take tens of seconds), kept by a trigger when a name changes.
alter table public.provider_services
  add column if not exists fp_base text,
  add column if not exists fp_tags text,
  add column if not exists fp_refill text;

create or replace function public.set_provider_service_fingerprint()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  f jsonb := service_fingerprint(new.name);
begin
  new.fp_base := f ->> 'base';
  new.fp_tags := f ->> 'tags';
  new.fp_refill := f ->> 'refill';
  return new;
end;
$fn$;
revoke all on function public.set_provider_service_fingerprint() from public, anon, authenticated;

drop trigger if exists trg_provider_services_fingerprint on public.provider_services;
create trigger trg_provider_services_fingerprint before insert or update of name on public.provider_services
  for each row execute function public.set_provider_service_fingerprint();

update public.provider_services ps
   set fp_base = f ->> 'base', fp_tags = f ->> 'tags', fp_refill = f ->> 'refill'
  from (select id, public.service_fingerprint(name) f from public.provider_services) x
 where x.id = ps.id;

create index if not exists idx_provider_services_fp_base on public.provider_services (fp_base) where is_active;

-- When the matcher last ran (the sync calls it at most hourly; an admin can run it at any time).
create table if not exists public.arbitrage_state (
  id           integer primary key default 1 check (id = 1),
  refreshed_at timestamptz,
  last_result  jsonb
);
insert into public.arbitrage_state (id) values (1) on conflict do nothing;
alter table public.arbitrage_state enable row level security;
revoke all on table public.arbitrage_state from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Candidates
-- -----------------------------------------------------------------------------
create table if not exists public.arbitrage_candidates (
  id                  uuid primary key default gen_random_uuid(),
  service_id          uuid not null references public.services(id) on delete cascade,
  provider_service_id uuid not null references public.provider_services(id) on delete cascade,
  provider_id         uuid not null references public.providers(id) on delete cascade,
  current_cost        numeric(14,4) not null,
  donor_cost          numeric(14,4) not null,
  saving              numeric(6,4) not null,
  mismatches          text[] not null default '{}',
  status              text not null default 'pending' check (status in ('pending', 'auto_linked', 'approved', 'rejected')),
  offer_id            uuid references public.provider_service_offers(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  decided_at          timestamptz,
  decided_by          uuid references public.users(id) on delete set null,
  unique (service_id, provider_service_id)
);
create index if not exists idx_arbitrage_candidates_status on public.arbitrage_candidates (status, saving desc);

alter table public.arbitrage_candidates enable row level security;
revoke all on table public.arbitrage_candidates from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The matcher (service role: run after every catalogue sync)
-- -----------------------------------------------------------------------------
create or replace function public.refresh_arbitrage_candidates(p_min_saving numeric default 0.25, p_max_links integer default 500, p_min_interval_minutes integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_linked  integer := 0;
  v_removed integer;
  r         record;
  v_offer   uuid;
  v_result  jsonb;
begin
  -- one matcher at a time, and not more often than asked (the sync passes 55 minutes)
  if not exists (
       select 1 from arbitrage_state
        where id = 1 and (refreshed_at is null or refreshed_at < now() - make_interval(mins => greatest(coalesce(p_min_interval_minutes, 0), 0)))
        for update skip locked) then
    return jsonb_build_object('skipped', true);
  end if;

  drop table if exists pg_temp.arb_pairs;
  create temp table arb_pairs on commit drop as
  with svc as materialized (
    select s.id, s.min_quantity mn, s.max_quantity mx, s.refill_supported srefill, service_fingerprint(s.name) f,
           (select min(o.cost_per_1000) from provider_service_offers o where o.service_id = s.id and o.is_active) best
      from services s
     where s.is_active
  ),
  pairs as (
    select s.id service_id, d.id ps_id, d.provider_id, s.best, d.rate_per_1000 cost, s.f sf, d.fp_tags dtags, d.fp_refill drefill,
           d.min_quantity dmn, d.max_quantity dmx, s.mn, s.mx, s.srefill, d.refill_supported dsupports
      from svc s
      join provider_services d on d.fp_base = s.f ->> 'base' and d.is_active
      join providers p on p.id = d.provider_id and p.is_active and p.routing_enabled
     where s.best is not null and s.f ->> 'base' <> ''
       and d.rate_per_1000 > 0 and d.rate_per_1000 <= s.best * (1 - p_min_saving)
       -- one offer per provider and service: never a second one from a provider that already serves it
       and not exists (select 1 from provider_service_offers x where x.service_id = s.id and x.provider_id = d.provider_id)
  )
  select service_id, ps_id, provider_id, best, cost,
         array_remove(array[
           case when dtags is distinct from sf ->> 'tags' then 'details' end,
           -- the guarantee must be the same as written, and a service that offers a refill button needs a panel that does refills
           case when drefill is distinct from sf ->> 'refill' or sf ->> 'refill' in ('unstated', 'unknown') or (srefill and not dsupports) then 'refill' end,
           case when dmn > mn or dmx < mx then 'limits' end
         ], null) mismatches
    from pairs;

  -- what an admin already decided against stays out
  delete from arb_pairs a using arbitrage_candidates c
   where c.service_id = a.service_id and c.provider_service_id = a.ps_id
     and (c.status = 'rejected' or (c.status in ('auto_linked', 'approved') and c.offer_id is null));

  -- 1. exact pairs: linked now (the cheapest per service and donor provider)
  for r in
    select distinct on (a.service_id, a.provider_id) a.*, ps.min_quantity, ps.max_quantity, ps.refill_supported, ps.cancel_supported
      from arb_pairs a join provider_services ps on ps.id = a.ps_id
     where cardinality(a.mismatches) = 0
     order by a.service_id, a.provider_id, a.cost, a.ps_id
     limit p_max_links
  loop
    insert into provider_service_offers
      (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported,
       supports_partial, is_active, routing_score)
    values (r.service_id, r.provider_id, r.ps_id, r.cost, r.min_quantity, r.max_quantity, r.refill_supported, r.cancel_supported,
            false, true, 0)
    returning id into v_offer;
    insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status, offer_id, decided_at)
    values (r.service_id, r.ps_id, r.provider_id, r.best, r.cost, round(1 - r.cost / r.best, 4), '{}', 'auto_linked', v_offer, now())
    on conflict (service_id, provider_service_id) do update
      set status = 'auto_linked', offer_id = excluded.offer_id, current_cost = excluded.current_cost, donor_cost = excluded.donor_cost,
          saving = excluded.saving, mismatches = '{}', decided_at = now(), updated_at = now();
    v_linked := v_linked + 1;
  end loop;

  -- 2. everything in doubt: for an admin, the closest pair per service (fewest doubts, then the cheapest)
  insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status)
  select service_id, ps_id, provider_id, best, cost, round(1 - cost / best, 4), mismatches, 'pending'
    from (select a.*, row_number() over (partition by a.service_id order by cardinality(a.mismatches), a.cost, a.ps_id) n
            from arb_pairs a
           where cardinality(a.mismatches) > 0
             and not exists (select 1 from provider_service_offers x where x.service_id = a.service_id and x.provider_id = a.provider_id)) t
   where n = 1
  on conflict (service_id, provider_service_id) do update
    set current_cost = excluded.current_cost, donor_cost = excluded.donor_cost, saving = excluded.saving,
        mismatches = excluded.mismatches, updated_at = now()
    where arbitrage_candidates.status = 'pending';

  -- 3. pending pairs that are no longer cheaper (or whose donor left) disappear
  delete from arbitrage_candidates c
   where c.status = 'pending'
     and not exists (select 1 from arb_pairs a where a.service_id = c.service_id and a.ps_id = c.provider_service_id and cardinality(a.mismatches) > 0)
     ;
  get diagnostics v_removed = row_count;

  v_result := jsonb_build_object('auto_linked', v_linked, 'removed', v_removed,
                                 'pending', (select count(*) from arbitrage_candidates where status = 'pending'));
  update arbitrage_state set refreshed_at = now(), last_result = v_result where id = 1;
  return v_result;
end;
$$;

revoke all on function public.refresh_arbitrage_candidates(numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.refresh_arbitrage_candidates(numeric, integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- Admin: the list and the decision (through the admin-providers function, like the other arbitrage actions)
-- -----------------------------------------------------------------------------
create or replace function public.admin_arbitrage_candidates(p_actor uuid, p_status text default 'pending', p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform assert_catalog_admin(p_actor);
  if p_status not in ('pending', 'auto_linked', 'approved', 'rejected') then
    raise exception 'invalid_parameter_value: unknown status %', p_status using errcode = 'invalid_parameter_value';
  end if;
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(x order by jsonb_array_length(x->'mismatches'), (x->>'saving')::numeric desc, x->>'id')
        from (select jsonb_build_object(
                'id', c.id, 'status', c.status, 'saving', c.saving, 'mismatches', to_jsonb(c.mismatches),
                'current_cost', c.current_cost, 'donor_cost', c.donor_cost,
                'service_id', s.id, 'service_name', s.name, 'service_min', s.min_quantity, 'service_max', s.max_quantity,
                'donor_name', ps.name, 'donor_external_id', ps.external_service_id, 'donor_min', ps.min_quantity, 'donor_max', ps.max_quantity,
                'provider_name', p.name, 'updated_at', c.updated_at) x
                from arbitrage_candidates c
                join services s on s.id = c.service_id
                join provider_services ps on ps.id = c.provider_service_id
                join providers p on p.id = c.provider_id
               where c.status = p_status
               order by cardinality(c.mismatches), c.saving desc, c.id
               limit v_limit offset v_offset) q), '[]'::jsonb),
    'counts', (select jsonb_object_agg(status, n) from (select status, count(*) n from arbitrage_candidates group by status) t),
    'refreshed_at', (select refreshed_at from arbitrage_state where id = 1),
    'limit', v_limit, 'offset', v_offset);
end;
$$;

create or replace function public.admin_decide_arbitrage_candidate(p_actor uuid, p_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c       arbitrage_candidates%rowtype;
  v_ps    provider_services%rowtype;
  v_offer uuid;
begin
  perform assert_catalog_admin(p_actor);
  select * into c from arbitrage_candidates where id = p_id for update;
  if not found then
    raise exception 'candidate_not_found: %', p_id using errcode = 'no_data_found';
  end if;

  if not p_approve then
    -- a rejected automatic (or approved) link is switched off too: the admin said this is not the same service
    if c.offer_id is not null then
      delete from provider_service_offers where id = c.offer_id;
    end if;
    update arbitrage_candidates set status = 'rejected', offer_id = null, decided_at = now(), decided_by = p_actor, updated_at = now() where id = p_id;
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'arbitrage_reject', p_id::text, jsonb_build_object('service_id', c.service_id, 'provider_service_id', c.provider_service_id, 'was', c.status));
    return jsonb_build_object('id', p_id, 'status', 'rejected');
  end if;

  if c.status <> 'pending' then
    raise exception 'candidate_not_pending: it is %', c.status using errcode = 'check_violation';
  end if;
  select * into v_ps from provider_services where id = c.provider_service_id;
  if not found or not v_ps.is_active then
    raise exception 'provider_service_inactive: the panel no longer lists this service' using errcode = 'check_violation';
  end if;
  if exists (select 1 from provider_service_offers where service_id = c.service_id and provider_id = c.provider_id) then
    raise exception 'already_linked: this provider already serves this service' using errcode = 'unique_violation';
  end if;
  insert into provider_service_offers
    (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported,
     supports_partial, is_active, routing_score)
  values (c.service_id, v_ps.provider_id, v_ps.id, v_ps.rate_per_1000, v_ps.min_quantity, v_ps.max_quantity, v_ps.refill_supported,
          v_ps.cancel_supported, false, true, 0)
  returning id into v_offer;
  update arbitrage_candidates set status = 'approved', offer_id = v_offer, decided_at = now(), decided_by = p_actor, updated_at = now() where id = p_id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'arbitrage_approve', p_id::text, jsonb_build_object('service_id', c.service_id, 'provider_service_id', c.provider_service_id, 'offer_id', v_offer));
  return jsonb_build_object('id', p_id, 'status', 'approved', 'offer_id', v_offer);
end;
$$;

revoke all on function public.admin_arbitrage_candidates(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_decide_arbitrage_candidate(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_arbitrage_candidates(uuid, text, integer, integer) to service_role;
grant execute on function public.admin_decide_arbitrage_candidate(uuid, uuid, boolean) to service_role;

-- An admin can run the matcher at once (the sync runs it at most hourly).
create or replace function public.admin_refresh_arbitrage(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_catalog_admin(p_actor);
  return refresh_arbitrage_candidates(0.25, 500, 0);
end;
$$;

revoke all on function public.admin_refresh_arbitrage(uuid) from public, anon, authenticated;
grant execute on function public.admin_refresh_arbitrage(uuid) to service_role;
