-- =============================================================================
-- The retired providers leave no tail
--
-- 20261226000000 switched SMM Center, SMMStone, SMMPWR and SMMProvider off. The audit after it found what that left behind:
--   1. place_order checked that the OFFER was active, never its provider. The router (routing.ts rankOffers) leaves a provider that is off out of
--      every choice, but nothing at the database refused an order on an offer of one. Now no order can be created on, or moved to, an offer whose
--      provider is switched off (providers.is_active, the master switch: routing_needs_active keeps routing_enabled behind it): the last door,
--      whatever the caller does. Routing alone is not checked here: place_order has always accepted a provider that is active but not routed
--      (tests/provider-manager.test.ts), and the router and quote_order_price already keep such a provider out of every choice.
--   2. their API keys are destroyed. With no key nothing can be sent to them (place-order, the funded-orders stage and the status sync all
--      refuse a provider without one). To bring one back an admin saves a new key, which switching routing on requires anyway.
--   3. their pending top-up proposals ($100 each, written by the health monitor before they were switched off) are rejected: approving one
--      would pay a panel nobody sells through.
--   4. their arbitrage links are dropped (the offers stay, switched off, so the orders that point at them keep their history).
--
-- Left as it is, on purpose: the cards whose PRIMARY provider service still belongs to a retired provider (1101 of them at the audit). Nothing
-- sells through that link (their offers are off); it only says where the card came from, and storefront_reference_services counts it as a
-- reference card of a publishing provider. Pointing it at a donor would make those places look empty to the gap filler, which would publish
-- donor services next to cards that are already there.
-- =============================================================================

create or replace function public.guard_order_provider()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.provider_offer_id is not null and not exists (
       select 1 from provider_service_offers o
         join providers p on p.id = o.provider_id
        where o.id = new.provider_offer_id and p.is_active) then
    raise exception 'provider offer not found, inactive or not valid for this service: its provider is switched off' using errcode = 'no_data_found';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_order_provider() from public, anon, authenticated;

create trigger trg_orders_provider_guard_insert before insert on public.orders
  for each row when (new.provider_offer_id is not null)
  execute function public.guard_order_provider();

-- the hub moves a waiting order to another provider's offer by updating this column; it checks the provider itself, this is the same rule again
create trigger trg_orders_provider_guard_update before update of provider_offer_id on public.orders
  for each row when (new.provider_offer_id is not null and new.provider_offer_id is distinct from old.provider_offer_id)
  execute function public.guard_order_provider();

update public.providers
   set api_key_encrypted = null
 where name in ('SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider') and api_key_encrypted is not null;

update public.topup_proposals t
   set status = 'rejected', decided_at = now()
  from public.providers p
 where p.id = t.provider_id and t.status = 'pending'
   and p.name in ('SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider');

delete from public.arbitrage_candidates c
 using public.providers p
 where p.id = c.provider_id
   and p.name in ('SMM Center', 'SMMStone', 'SMMPWR', 'SMMProvider');
