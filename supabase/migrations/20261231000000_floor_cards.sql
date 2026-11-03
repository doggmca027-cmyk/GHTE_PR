-- =============================================================================
-- Floor cards: a card kept at the bottom price takes no offer of a premium panel
--
-- RootPanel #73486 and #89336 are the owner's absolute price floor for mass orders (accounts networks). The matcher had linked Secsers #684 and
-- MoreThanPanel #5839 to both (a premium panel's offer goes first on a card that promises a refill, even when it costs more) and the retail rate
-- followed the premium cost: $1.82 instead of $0.98 and $1.08.
--
--   * services.no_premium_offers: the matcher links no premium panel's offer to such a card. A column of services is private unless it is granted
--     (column-level grants), and this one is not.
--   * the two cards are marked, the pairs are rejected for good, the premium offers they have are removed (switched off when an order went through
--     one) and the retail rates go back to what the price rules give on the RootPanel cost: 0.3276 x3 = 0.9828 and 0.36 x3 = 1.08. The next
--     catalogue sync of RootPanel computes the same numbers, so nothing moves again.
--   * the matcher below is 20261225000000 with two changes (marked "floor cards").
-- =============================================================================

alter table public.services add column if not exists no_premium_offers boolean not null default false;
comment on column public.services.no_premium_offers is 'Floor card: the matcher links no offer of a premium panel to it (the owner keeps it at the bottom price). Private.';

create or replace function public.refresh_arbitrage_candidates(p_min_saving numeric default 0.15, p_max_links integer default 2000, p_min_interval_minutes integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_saving  constant numeric := 0.80;
  c_max_premium constant numeric := 50;
  v_linked      integer := 0;
  v_anomalies   integer := 0;
  v_unlinked    integer := 0;
  v_dropped     integer := 0;
  r             record;
  v_offer       uuid;
  v_result      jsonb;
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
    select x.id, x.mn, x.mx, x.srefill, x.f, x.k, x.best, x.quality, x.nopremium, /* floor cards */ coalesce(x.own, x.best) own,
           arbitrage_num_tags(x.f ->> 'tags') num, arbitrage_required_tags(x.f ->> 'tags') req, string_to_array(coalesce(x.f ->> 'tags', ''), ',') alltags
      from (select s.id, s.min_quantity mn, s.max_quantity mx, s.refill_supported srefill, service_fingerprint(s.name) f, service_package_kind(s.name) k,
                   service_name_is_quality(s.name) quality, s.no_premium_offers nopremium, /* floor cards */
                   (select min(o.cost_per_1000) from provider_service_offers o where o.service_id = s.id and o.is_active) best,
                   (select ps.rate_per_1000 from provider_services ps where ps.id = s.primary_provider_service_id and ps.rate_per_1000 > 0) own
              from services s
             where s.is_active) x
     where x.best is not null and x.f ->> 'base' <> ''
  ),
  dn as materialized (
    select d.id, d.provider_id, d.fp_base, coalesce(d.fp_kind, 'single') k, d.fp_refill, d.rate_per_1000, d.min_quantity, d.max_quantity,
           d.refill_supported, p.is_premium, arbitrage_num_tags(d.fp_tags) num, string_to_array(coalesce(d.fp_tags, ''), ',') alltags, arbitrage_strict_tags(d.fp_tags) strict
      from provider_services d
      join providers p on p.id = d.provider_id and p.is_active and p.routing_enabled
     where d.is_active and d.rate_per_1000 > 0 and d.fp_base in (select f ->> 'base' from svc)
       and service_takes_link_and_quantity(d.service_type, d.name)
  )
  select s.id service_id, d.id ps_id, d.provider_id, s.best, s.own, d.rate_per_1000 cost
    from svc s
    join dn d on d.fp_base = s.f ->> 'base' and d.k = s.k
   where (d.rate_per_1000 <= s.best * (1 - p_min_saving) or (d.is_premium and s.quality and d.rate_per_1000 <= s.best * c_max_premium))
     and not (s.nopremium and d.is_premium) -- floor cards
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

  -- d. the same product, 15% to 80% cheaper, or a premium panel's on a quality card: linked now (the cheapest per service and donor provider)
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

-- -----------------------------------------------------------------------------
-- The two cards
-- -----------------------------------------------------------------------------
update public.services s
   set no_premium_offers = true
  from public.provider_services ps, public.providers p
 where ps.id = s.primary_provider_service_id and p.id = ps.provider_id
   and p.name = 'RootPanel' and ps.external_service_id in ('73486', '89336') and not s.no_premium_offers;

-- the pairs are decided against for good (the matcher never proposes a rejected pair again)
update public.arbitrage_candidates c
   set status = 'rejected', offer_id = null, mismatches = '{}', decided_at = now(), updated_at = now()
  from public.services s, public.providers p
 where s.id = c.service_id and s.no_premium_offers and p.id = c.provider_id and p.is_premium;

-- the offers: removed; one an order went through stays (orders keep pointing at it), switched off
delete from public.provider_service_offers o
 using public.services s, public.providers p
 where s.id = o.service_id and s.no_premium_offers and p.id = o.provider_id and p.is_premium
   and not exists (select 1 from public.orders x where x.provider_offer_id = o.id);

update public.provider_service_offers o
   set is_active = false
  from public.services s, public.providers p
 where s.id = o.service_id and s.no_premium_offers and p.id = o.provider_id and p.is_premium and o.is_active;

-- the retail rates: the cost of the RootPanel offer through the tier of its band (0.05 - 0.50: max(x3, +0.12))
update public.services s
   set customer_rate_per_1000 = case ps.external_service_id when '73486' then 1.0800 else 0.9828 end
  from public.provider_services ps, public.providers p
 where ps.id = s.primary_provider_service_id and p.id = ps.provider_id
   and p.name = 'RootPanel' and ps.external_service_id in ('73486', '89336') and s.no_premium_offers
   and s.customer_rate_per_1000 is distinct from case ps.external_service_id when '73486' then 1.0800 else 0.9828 end;
