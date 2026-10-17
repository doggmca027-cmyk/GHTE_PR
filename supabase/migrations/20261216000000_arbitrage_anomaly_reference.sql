-- =============================================================================
-- Smart Arbitrage: the 80% line is drawn from the card's own cost
--
-- 20261214000000 measured "more than 80% cheaper" against the cheapest OTHER offer of a card. Where two cheap donors served one card
-- (links of the old matcher), each passed against the other: 123 links stayed although they were more than 80% under the card's own
-- source (its primary provider service). Now both the re-check of the links and the new pairs compare with that cost; the saving
-- threshold (at least 15%) still counts from the cheapest offer.
-- =============================================================================

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
             case when coalesce(src.rate_per_1000, other.best) is not null and d.rate_per_1000 < coalesce(src.rate_per_1000, other.best) * (1 - c_max_saving) then 'price_anomaly' end
           ], null) why
      from arbitrage_candidates c
      join services s on s.id = c.service_id
      join provider_services d on d.id = c.provider_service_id
      cross join lateral (select service_fingerprint(s.name) f) fp
      left join provider_services src on src.id = s.primary_provider_service_id and src.id <> d.id
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
    select x.id, x.mn, x.mx, x.srefill, x.f, x.k, x.best, coalesce(x.own, x.best) own,
           arbitrage_num_tags(x.f ->> 'tags') num, arbitrage_required_tags(x.f ->> 'tags') req, string_to_array(coalesce(x.f ->> 'tags', ''), ',') alltags
      from (select s.id, s.min_quantity mn, s.max_quantity mx, s.refill_supported srefill, service_fingerprint(s.name) f, service_package_kind(s.name) k,
                   (select min(o.cost_per_1000) from provider_service_offers o where o.service_id = s.id and o.is_active) best,
                   (select ps.rate_per_1000 from provider_services ps where ps.id = s.primary_provider_service_id and ps.rate_per_1000 > 0) own
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
  select s.id service_id, d.id ps_id, d.provider_id, s.best, s.own, d.rate_per_1000 cost
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
   where cost < own * (1 - c_max_saving)
  on conflict (service_id, provider_service_id) do update
    set status = 'rejected', mismatches = '{price_anomaly}', current_cost = excluded.current_cost, donor_cost = excluded.donor_cost,
        saving = excluded.saving, decided_at = now(), updated_at = now()
    where arbitrage_candidates.status = 'pending';
  get diagnostics v_anomalies = row_count;

  -- d. the same product, 15% to 80% cheaper: linked now (the cheapest per service and donor provider)
  for r in
    select distinct on (a.service_id, a.provider_id) a.*, ps.min_quantity, ps.max_quantity, ps.refill_supported, ps.cancel_supported
      from arb_pairs a join provider_services ps on ps.id = a.ps_id
     where a.cost >= a.own * (1 - c_max_saving)
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

update public.arbitrage_state set requested_at = now() where id = 1;
