-- =============================================================================
-- Provider rotation: SMM Center, SMMStone, SMMPWR and SMMProvider leave the pool
--
-- Their offers are switched off, not deleted: orders and arbitrage history point at them, and trg_services_sync_offers would create a card's
-- primary offer again the next time the sync writes the card. An inactive provider is not synced, gets no health checks and is not matched, so
-- nothing switches them back on. Its orders that are still moving are polled as before (sync-order-status does not filter on is_active), and a
-- refill of an old order still reaches it.
--
-- A card that loses its last working offer first looks for the same product at the providers that stay (the matcher's rules: same base, kind,
-- package numbers and guarantee, no worse quality, orderable with a link and a quantity). The matcher itself only ever links what is cheaper, so
-- these were never offers of the card; here a dearer one is taken too, up to 50 times the card's old cost. Only a card with no such offer leaves
-- the storefront, and is listed in provider_rotation_hidden: the compaction (20261207000000) hid thousands of other cards, which must not come
-- back with these. To undo the rotation:
--   update providers set is_active = true, routing_enabled = true, health_status = 'healthy' where name in (...the four...);
--   update provider_service_offers set is_active = true where provider_id in (...the four...);
--   update services set is_active = true where id in (select service_id from provider_rotation_hidden);
--
-- The places the hidden cards leave empty count as gaps again (storefront_reference_services only lists active cards), so the fill_gaps providers
-- fill them run by run. The cards that stay are re-priced from the offers they now have by the next catalogue sync of each remaining provider;
-- until then an order is priced on the offer that serves it (order-pricing.ts).
-- =============================================================================

create table if not exists public.provider_rotation_hidden (
  service_id uuid primary key references public.services(id) on delete cascade,
  hidden_at  timestamptz not null default now()
);
alter table public.provider_rotation_hidden enable row level security;
revoke all on table public.provider_rotation_hidden from anon, authenticated;

do $$
declare
  c_retiring   constant text[]  := array['SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider'];
  c_max_saving constant numeric := 0.80;
  c_max_markup constant numeric := 50;
  r       record;
  v_offer uuid;
begin
  update public.providers
     set is_active = false, routing_enabled = false, health_status = 'disabled'
   where name = any (c_retiring);

  update public.provider_service_offers o
     set is_active = false
    from public.providers p
   where p.id = o.provider_id and o.is_active and p.name = any (c_retiring);

  -- the cards this leaves with no offer that can take an order
  create temp table rotation_cards on commit drop as
  select x.id, x.mn, x.mx, x.srefill, x.f, x.k, x.own,
         public.arbitrage_num_tags(x.f ->> 'tags') num, public.arbitrage_required_tags(x.f ->> 'tags') req, string_to_array(coalesce(x.f ->> 'tags', ''), ',') alltags
    from (select s.id, s.min_quantity mn, s.max_quantity mx, s.refill_supported srefill, public.service_fingerprint(s.name) f, public.service_package_kind(s.name) k,
                 coalesce((select ps.rate_per_1000 from public.provider_services ps where ps.id = s.primary_provider_service_id and ps.rate_per_1000 > 0),
                          (select min(o.cost_per_1000) from public.provider_service_offers o where o.service_id = s.id)) own
            from public.services s
           where s.is_active
             and exists (select 1 from public.provider_service_offers o join public.providers p on p.id = o.provider_id
                          where o.service_id = s.id and p.name = any (c_retiring))
             and not exists (select 1 from public.provider_service_offers o
                               join public.provider_services ps on ps.id = o.provider_service_id and ps.is_active
                               join public.providers p on p.id = o.provider_id and p.is_active and p.routing_enabled
                              where o.service_id = s.id and o.is_active)) x;

  -- the same product at a provider that stays: the cheapest per card and provider
  for r in
    with dn as materialized (
      select d.id, d.provider_id, d.fp_base, coalesce(d.fp_kind, 'single') k, d.fp_refill, d.rate_per_1000, d.min_quantity, d.max_quantity, d.refill_supported, d.cancel_supported,
             public.arbitrage_num_tags(d.fp_tags) num, string_to_array(coalesce(d.fp_tags, ''), ',') alltags, public.arbitrage_strict_tags(d.fp_tags) strict
        from public.provider_services d
        join public.providers p on p.id = d.provider_id and p.is_active and p.routing_enabled
       where d.is_active and d.rate_per_1000 > 0
         and d.fp_base in (select f ->> 'base' from rotation_cards)
         and public.service_takes_link_and_quantity(d.service_type, d.name)
    )
    select distinct on (s.id, d.provider_id) s.id service_id, s.own, d.id ps_id, d.provider_id, d.rate_per_1000 cost, d.min_quantity, d.max_quantity, d.refill_supported, d.cancel_supported
      from rotation_cards s
      join dn d on d.fp_base = s.f ->> 'base' and d.k = s.k
     where s.f ->> 'base' <> '' and s.own is not null
       and d.rate_per_1000 between s.own * (1 - c_max_saving) and s.own * c_max_markup
       and d.min_quantity <= s.mx and d.max_quantity >= s.mn
       and d.num = s.num and s.req <@ d.alltags and d.strict <@ s.alltags
       and public.arbitrage_refill_fits(s.f ->> 'refill', d.fp_refill) and not (s.srefill and not d.refill_supported)
       and not exists (select 1 from public.provider_service_offers x where x.service_id = s.id and x.provider_id = d.provider_id)
       and not exists (select 1 from public.arbitrage_candidates c where c.service_id = s.id and c.provider_service_id = d.id and c.status = 'rejected')
     order by s.id, d.provider_id, d.rate_per_1000, d.id
  loop
    insert into public.provider_service_offers
      (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported, supports_partial, is_active, routing_score)
    values (r.service_id, r.provider_id, r.ps_id, r.cost, r.min_quantity, r.max_quantity, r.refill_supported, r.cancel_supported, false, true, 0)
    returning id into v_offer;
    insert into public.arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status, offer_id, decided_at)
    values (r.service_id, r.ps_id, r.provider_id, r.own, r.cost, round(1 - r.cost / r.own, 4), '{}', 'auto_linked', v_offer, now())
    on conflict (service_id, provider_service_id) do update
      set status = 'auto_linked', offer_id = excluded.offer_id, current_cost = excluded.current_cost, donor_cost = excluded.donor_cost,
          saving = excluded.saving, mismatches = '{}', decided_at = now(), updated_at = now();
  end loop;

  -- what still has nothing leaves the storefront
  insert into public.provider_rotation_hidden (service_id)
  select s.id
    from rotation_cards s
   where not exists (select 1 from public.provider_service_offers o
                       join public.provider_services ps on ps.id = o.provider_service_id and ps.is_active
                       join public.providers p on p.id = o.provider_id and p.is_active and p.routing_enabled
                      where o.service_id = s.id and o.is_active)
  on conflict (service_id) do nothing;

  update public.services s
     set is_active = false
    from public.provider_rotation_hidden h
   where h.service_id = s.id and s.is_active;
end;
$$;

select public.regroup_service_variants();
select public.refresh_service_dripfeed();
select public.recount_categories(coalesce((select array_agg(id) from public.categories), '{}'));

-- the matcher runs within 5 minutes
update public.arbitrage_state set requested_at = now() where id = 1;
