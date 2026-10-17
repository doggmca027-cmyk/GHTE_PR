-- =============================================================================
-- Smart Arbitrage on full autopilot, without swapping the product
--
-- The matcher linked only exact twins and left everything else to an admin: 6,082 candidates waited, nobody went through them. And the
-- fingerprint did not know a package from a single service: "Telegram Auto Post Views [100 posts/day] [30 days]" ($164.39) was a
-- candidate for "Telegram Auto Post Views | 1 Post" ($0.008, "-100%").
--
--   1. the package kind is its own part of the fingerprint (service_package_kind): "1 Post" / "Single" is a single service; "Auto",
--      "Subscription", "N posts", "posts/day" a package. Different kinds are never compared at all.
--   2. a pair is linked by itself when the base and the kind match, the numbers of the package are the same ("1 Hour" is not "5 Hours",
--      "30 days" is not "90 days"), every fact of our service other than quality words is stated by the donor too, and the donor adds
--      nothing but quality / speed words ("SuperFast", "Instant", "Drop: No", "Real & Active"; a country, a reaction emoji or "Bots" of
--      its own make it another product), the donor's guarantee is at
--      least ours, its limits take our orders, and it is 15% to 80% cheaper
--   3. more than 80% cheaper is not a bargain, it is another package: rejected at once (mismatch "price_anomaly"), never linked
--   4. there is no queue any more: what does not fit is simply not a candidate. Pending candidates are dropped.
--   5. every run also checks the links it made earlier against these rules: a link that no longer fits is switched off and rejected
--      (192 links of more than 80% were made before this rule existed).
-- Admin decisions stay as they are: an approved link stays, a rejected pair stays out.
-- =============================================================================

-- 1. the package kind ---------------------------------------------------------------------------------------------------------------------
create or replace function public.service_package_kind(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    -- one post, said in so many words, wins over "Auto" ("Telegram Auto Post Views | 1 Post")
    when v ~ '(^|[^0-9])1 ?posts?\M' or v ~ '\msingle( post)?\M' or v ~ '\mone post\M' then 'single'
    when v ~ '\mauto\M' or v ~ 'subscription' or v ~ '\m([2-9]|[1-9][0-9]+) ?(last |future |new )?posts\M' or v ~ 'posts? ?/ ?(day|d)\M' then 'multi'
    else 'single'
  end
  from (select replace(lower(coalesce(p_name, '')), '&amp;', '&') v) x;
$$;
revoke all on function public.service_package_kind(text) from public, anon, authenticated;
grant execute on function public.service_package_kind(text) to service_role;

alter table public.provider_services add column if not exists fp_kind text;

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
  new.fp_kind := service_package_kind(new.name);
  return new;
end;
$fn$;
revoke all on function public.set_provider_service_fingerprint() from public, anon, authenticated;

update public.provider_services set fp_kind = public.service_package_kind(name) where fp_kind is distinct from public.service_package_kind(name);

-- 2. what "the same product" means ------------------------------------------------------------------------------------------------------
-- The numbers of a package ("1 hour", "30 days", "100 posts/day"): they must be the same on both sides.
create or replace function public.arbitrage_num_tags(p_tags text)
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array(select t from unnest(string_to_array(coalesce(p_tags, ''), ',')) t where t ~ '[0-9]' order by t), '{}');
$$;

-- Our facts a donor must state too: everything but numbers and words about quality or speed (a donor need not repeat "fast", "HQ").
create or replace function public.arbitrage_required_tags(p_tags text)
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array(select t from unnest(string_to_array(coalesce(p_tags, ''), ',')) t
                         where t <> '' and t !~ '[0-9]'
                           and t !~ '^(fast|super ?fast|ultra ?fast|very fast|instant|instantly|cheap|cheapest|best|stable|super|hq|high quality|good quality|premium|real|real active|active|real accounts|no drop|non drop|low drop|recommended|new|hot|top|vip|power|quality|world ?wide|global|mix|mixed)$'), '{}');
$$;

-- What a donor states beyond quality and speed words (a country, a reaction emoji, "vlog", "mobile plays", "bots"...): every one of these
-- must be ours too, or it is another product. "SuperFast", "Instant", "Drop: No", "Real & Active", "HQ" a donor may add freely.
create or replace function public.arbitrage_strict_tags(p_tags text)
returns text[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array(select t from unnest(string_to_array(coalesce(p_tags, ''), ',')) t
                         where t <> '' and t !~ '[0-9]'
                           and t !~ '^(fast|super ?fast|ultra ?fast|very fast|instant|instantly|stable|hq|high quality|good quality|premium|real|real active|active|real accounts|no drop|non drop|low drop|drop:? ?no|recommended|best|top|vip|power|world ?wide|global|works on all channels)$'), '{}');
$$;

create or replace function public.arbitrage_tags_fit(p_ours text, p_donor text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select arbitrage_num_tags(p_ours) = arbitrage_num_tags(p_donor)
     and arbitrage_required_tags(p_ours) <@ string_to_array(coalesce(p_donor, ''), ',')
     and arbitrage_strict_tags(p_donor) <@ string_to_array(coalesce(p_ours, ''), ',');
$$;

-- The donor's guarantee is at least ours: lifetime > any number of days > none; a guarantee it does not state cannot be ours.
create or replace function public.arbitrage_refill_fits(p_ours text, p_donor text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select (case when p_ours = 'life' then 100000 when p_ours ~ '^[0-9]+$' then p_ours::integer else 0 end) = 0
      or coalesce(case when p_donor = 'life' then 100000 when p_donor ~ '^[0-9]+$' then p_donor::integer end, -1)
         >= (case when p_ours = 'life' then 100000 when p_ours ~ '^[0-9]+$' then p_ours::integer else 0 end);
$$;

revoke all on function public.arbitrage_num_tags(text), public.arbitrage_required_tags(text), public.arbitrage_strict_tags(text),
  public.arbitrage_tags_fit(text, text), public.arbitrage_refill_fits(text, text) from public, anon, authenticated;
grant execute on function public.arbitrage_num_tags(text), public.arbitrage_required_tags(text), public.arbitrage_strict_tags(text),
  public.arbitrage_tags_fit(text, text), public.arbitrage_refill_fits(text, text) to service_role;

-- 3. the matcher -------------------------------------------------------------------------------------------------------------------------
create or replace function public.refresh_arbitrage_candidates(p_min_saving numeric default 0.15, p_max_links integer default 2000, p_min_interval_minutes integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_saving constant numeric := 0.80;
  v_linked     integer := 0;
  v_anomalies  integer := 0;
  v_unlinked   integer := 0;
  v_dropped    integer := 0;
  r            record;
  v_offer      uuid;
  v_result     jsonb;
begin
  -- one matcher at a time, and not more often than asked
  if not exists (
       select 1 from arbitrage_state
        where id = 1 and (refreshed_at is null or refreshed_at < now() - make_interval(mins => greatest(coalesce(p_min_interval_minutes, 0), 0)))
        for update skip locked) then
    return jsonb_build_object('skipped', true);
  end if;

  -- a. the links made by the autopilot earlier, checked again: one that no longer fits is switched off and rejected
  for r in
    select c.id, c.offer_id,
           array_remove(array[
             case when service_package_kind(s.name) is distinct from coalesce(d.fp_kind, service_package_kind(d.name)) then 'package' end,
             case when not arbitrage_tags_fit(f ->> 'tags', d.fp_tags) then 'details' end,
             case when not arbitrage_refill_fits(f ->> 'refill', d.fp_refill) then 'refill' end,
             case when other.best is not null and d.rate_per_1000 < other.best * (1 - c_max_saving) then 'price_anomaly' end
           ], null) why
      from arbitrage_candidates c
      join services s on s.id = c.service_id
      join provider_services d on d.id = c.provider_service_id
      cross join lateral (select service_fingerprint(s.name) f) fp
      left join lateral (select min(o.cost_per_1000) best from provider_service_offers o
                          where o.service_id = c.service_id and o.is_active and o.id is distinct from c.offer_id) other on true
     where c.status = 'auto_linked'
  loop
    continue when cardinality(r.why) = 0;
    if r.offer_id is not null then
      -- an offer an order went through stays (orders keep pointing at it), switched off; any other is removed
      if exists (select 1 from orders o where o.provider_offer_id = r.offer_id) then
        update provider_service_offers set is_active = false where id = r.offer_id;
      else
        delete from provider_service_offers where id = r.offer_id;
      end if;
    end if;
    update arbitrage_candidates set status = 'rejected', offer_id = null, mismatches = r.why, decided_at = now(), updated_at = now() where id = r.id;
    v_unlinked := v_unlinked + 1;
  end loop;

  -- b. the same product: same base and kind, the same package numbers, our facts stated by the donor and no worse quality, its guarantee
  --    at least ours, its limits taking our orders. The tag sets are computed once per service and per donor service.
  drop table if exists pg_temp.arb_pairs;
  create temp table arb_pairs on commit drop as
  with svc as materialized (
    select x.id, x.mn, x.mx, x.srefill, x.f, x.k, x.best,
           arbitrage_num_tags(x.f ->> 'tags') num, arbitrage_required_tags(x.f ->> 'tags') req, string_to_array(coalesce(x.f ->> 'tags', ''), ',') alltags
      from (select s.id, s.min_quantity mn, s.max_quantity mx, s.refill_supported srefill, service_fingerprint(s.name) f, service_package_kind(s.name) k,
                   (select min(o.cost_per_1000) from provider_service_offers o where o.service_id = s.id and o.is_active) best
              from services s
             where s.is_active) x
     where x.best is not null and x.f ->> 'base' <> ''
  ),
  dn as materialized (
    select d.id, d.provider_id, d.fp_base, coalesce(d.fp_kind, 'single') k, d.fp_refill, d.rate_per_1000, d.min_quantity, d.max_quantity,
           d.refill_supported, arbitrage_num_tags(d.fp_tags) num, string_to_array(coalesce(d.fp_tags, ''), ',') alltags, arbitrage_strict_tags(d.fp_tags) strict
      from provider_services d
      join providers p on p.id = d.provider_id and p.is_active and p.routing_enabled
     where d.is_active and d.rate_per_1000 > 0 and d.fp_base in (select f ->> 'base' from svc)
  )
  select s.id service_id, d.id ps_id, d.provider_id, s.best, d.rate_per_1000 cost
    from svc s
    join dn d on d.fp_base = s.f ->> 'base' and d.k = s.k
   where d.rate_per_1000 <= s.best * (1 - p_min_saving)
     and d.min_quantity <= s.mn and d.max_quantity >= s.mx
     and d.num = s.num and s.req <@ d.alltags and d.strict <@ s.alltags
     and arbitrage_refill_fits(s.f ->> 'refill', d.fp_refill) and not (s.srefill and not d.refill_supported)
     -- one offer per provider and service
     and not exists (select 1 from provider_service_offers x where x.service_id = s.id and x.provider_id = d.provider_id);

  -- what an admin (or this autopilot) already decided against stays out
  delete from arb_pairs a using arbitrage_candidates c
   where c.service_id = a.service_id and c.provider_service_id = a.ps_id
     and (c.status = 'rejected' or (c.status in ('auto_linked', 'approved') and c.offer_id is null));

  -- c. the same product but more than 80% cheaper: another package, rejected at once
  insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status, decided_at)
  select service_id, ps_id, provider_id, best, cost, round(1 - cost / best, 4), '{price_anomaly}', 'rejected', now()
    from arb_pairs
   where cost < best * (1 - c_max_saving)
  on conflict (service_id, provider_service_id) do update
    set status = 'rejected', mismatches = '{price_anomaly}', current_cost = excluded.current_cost, donor_cost = excluded.donor_cost,
        saving = excluded.saving, decided_at = now(), updated_at = now()
    where arbitrage_candidates.status = 'pending';
  get diagnostics v_anomalies = row_count;

  -- d. the same product, 15% to 80% cheaper: linked now (the cheapest per service and donor provider)
  for r in
    select distinct on (a.service_id, a.provider_id) a.*, ps.min_quantity, ps.max_quantity, ps.refill_supported, ps.cancel_supported
      from arb_pairs a join provider_services ps on ps.id = a.ps_id
     where a.cost >= a.best * (1 - c_max_saving)
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

  -- e. no manual queue: whatever is still pending is dropped (it is either linked above or not the same product)
  delete from arbitrage_candidates where status = 'pending';
  get diagnostics v_dropped = row_count;

  v_result := jsonb_build_object('auto_linked', v_linked, 'price_anomalies', v_anomalies, 'unlinked', v_unlinked, 'dropped', v_dropped,
                                 'pending', 0);
  update arbitrage_state set refreshed_at = now(), last_result = v_result where id = 1;
  return v_result;
end;
$$;

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
    return refresh_arbitrage_candidates(0.15, 2000, 0);
  end if;
  return jsonb_build_object('skipped', true);
end;
$$;

-- 4. the queue nobody went through is gone; the autopilot runs with the new rules at its next tick (pg_cron, within 5 minutes)
delete from public.arbitrage_candidates where status = 'pending';
update public.arbitrage_state set requested_at = now() where id = 1;
