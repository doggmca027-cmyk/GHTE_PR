-- =============================================================================
-- Phase 1C: routing snapshots on orders + place_order driven by a chosen offer
--
-- The Edge Function now picks the provider offer (provider_service_offers) and hands the decision to
-- place_order, which validates it against the offer row, snapshots it on the order and pays atomically.
-- services.primary_provider_service_id / fallback_provider_service_id are no longer read for new orders
-- (the columns stay; they are dropped in a later phase).
-- =============================================================================

alter table public.orders
  add column provider_offer_id      uuid references public.provider_service_offers(id) on delete restrict,
  add column routing_score_snapshot integer not null default 0,
  add column profit_amount          numeric(14,4) not null default 0;
create index idx_orders_offer on public.orders (provider_offer_id) where provider_offer_id is not null;

-- -----------------------------------------------------------------------------
-- Backfill history. profit = charge - cost for every existing order; the offer is linked only where it is
-- unambiguous (exactly one offer for that service + provider). updated_at is left alone.
-- -----------------------------------------------------------------------------
alter table public.orders disable trigger trg_orders_updated_at;

update public.orders set profit_amount = charge_amount - cost_amount;

update public.orders o
   set provider_offer_id      = m.offer_id,
       routing_score_snapshot = m.routing_score
  from (select o2.id as order_id, (array_agg(po.id))[1] as offer_id, (array_agg(po.routing_score))[1] as routing_score
          from public.orders o2
          join public.provider_service_offers po on po.service_id = o2.service_id and po.provider_id = o2.provider_id
         group by o2.id
        having count(*) = 1) m
 where o.id = m.order_id;

alter table public.orders enable trigger trg_orders_updated_at;

-- -----------------------------------------------------------------------------
-- The routing snapshot is frozen together with the other commercial terms once the order leaves draft.
-- (Same function as before plus three columns.)
-- -----------------------------------------------------------------------------
create or replace function public.guard_order_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'orders must be created in draft status (got %)', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     and not public.is_valid_order_transition(old.status, new.status) then
    raise exception 'illegal order status transition: % -> % (order %)',
      old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  -- Commercial terms and the routing snapshot are frozen once the order leaves draft.
  if old.status <> 'draft'
     and (new.user_id <> old.user_id
          or new.service_id <> old.service_id
          or new.target_url <> old.target_url
          or new.quantity <> old.quantity
          or new.charge_amount <> old.charge_amount
          or new.provider_offer_id is distinct from old.provider_offer_id
          or new.routing_score_snapshot <> old.routing_score_snapshot
          or new.profit_amount <> old.profit_amount) then
    raise exception 'order % commercial terms are immutable after draft', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- place_order: the old 5-argument version read services.primary_provider_service_id. Replace it with one that
-- takes the routing decision. The offer is re-validated here (the Edge Function is trusted, but a wrong
-- argument must never turn into a wrong snapshot or a wrong debit):
--   * the offer exists, is active and belongs to this service, provider and provider service
--   * the quantity fits the offer's own limits
--   * p_cost_amount equals the offer's cost for this quantity (within 0.0001)
-- The wallet row stays locked FOR UPDATE for the whole transaction.
-- -----------------------------------------------------------------------------
drop function public.place_order(uuid, uuid, text, integer, text);

create function public.place_order(
  p_user_id             uuid,
  p_service_id          uuid,
  p_target_url          text,
  p_quantity            integer,
  p_provider_offer_id   uuid,
  p_provider_id         uuid,
  p_provider_service_id uuid,
  p_cost_amount         numeric,
  p_idempotency_key     text default null
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_svc    services%rowtype;
  v_offer  provider_service_offers%rowtype;
  v_order  orders%rowtype;
  v_charge numeric(14,4);
  v_cost   numeric(14,4);
begin
  -- Serialise all purchases of this user; also makes the idempotency lookup race-free.
  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  if p_idempotency_key is not null then
    select * into v_order from orders where idempotency_key = p_idempotency_key;
    if found then
      if v_order.user_id <> p_user_id or v_order.service_id <> p_service_id
         or v_order.quantity <> p_quantity or v_order.target_url <> p_target_url then
        raise exception 'idempotency key % was already used with different parameters', p_idempotency_key
          using errcode = 'unique_violation';
      end if;
      return v_order;  -- a replay keeps its original routing snapshot, whatever the arguments now say
    end if;
  end if;

  select * into v_svc from services where id = p_service_id and is_active;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  if p_quantity < v_svc.min_quantity or p_quantity > v_svc.max_quantity then
    raise exception 'quantity must be between % and %', v_svc.min_quantity, v_svc.max_quantity
      using errcode = 'check_violation';
  end if;

  select * into v_offer from provider_service_offers
   where id = p_provider_offer_id and service_id = p_service_id and is_active;
  if not found
     or v_offer.provider_id <> p_provider_id
     or v_offer.provider_service_id <> p_provider_service_id then
    raise exception 'provider offer not found, inactive or not valid for this service' using errcode = 'no_data_found';
  end if;
  if p_quantity < v_offer.min_quantity or p_quantity > v_offer.max_quantity then
    raise exception 'quantity is outside the limits of the selected provider offer' using errcode = 'check_violation';
  end if;

  v_cost := round(p_cost_amount, 4);
  if p_cost_amount is null or p_cost_amount < 0
     or abs(v_cost - round(v_offer.cost_per_1000 * p_quantity / 1000, 4)) > 0.0001 then
    raise exception 'cost does not match the selected provider offer' using errcode = 'check_violation';
  end if;

  v_charge := round(v_svc.customer_rate_per_1000 * p_quantity / 1000, 4);
  if v_charge <= 0 then
    raise exception 'order total is too small' using errcode = 'check_violation';
  end if;

  insert into orders (user_id, service_id, target_url, quantity, charge_amount, cost_amount, profit_amount,
                      provider_id, provider_offer_id, routing_score_snapshot, idempotency_key)
  values (p_user_id, p_service_id, p_target_url, p_quantity, v_charge, v_cost, v_charge - v_cost,
          v_offer.provider_id, v_offer.id, v_offer.routing_score, p_idempotency_key)
  returning * into v_order;

  update orders set status = 'awaiting_payment' where id = v_order.id;

  perform process_wallet_transaction(
    p_user_id, 'purchase', -v_charge, v_order.id,
    'Order ' || v_order.id, 'purchase:' || v_order.id);

  update orders set status = 'paid' where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- Bridge until services.primary/fallback_provider_service_id are dropped: the catalogue sync still creates
-- services through those columns and refreshes provider_services prices, and orders now route only through
-- offers. Without these two triggers a newly synced service would have no offer (not orderable) and an
-- offer's cost would drift from the provider's real price.
--   1. a service gaining a primary/fallback provider service gets an offer for it (never touches existing offers)
--   2. a provider service whose price, limits or flags change updates the offers built on it
--      (offers' is_active / routing_score are operator decisions and are never changed here)
-- -----------------------------------------------------------------------------
create function public.sync_offers_from_service()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.provider_service_offers
    (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity,
     refill_supported, cancel_supported, is_active, routing_score)
  select new.id, ps.provider_id, ps.id, ps.rate_per_1000, ps.min_quantity, ps.max_quantity,
         ps.refill_supported, ps.cancel_supported, true, o.score
    from (values (new.primary_provider_service_id, 100),
                 (new.fallback_provider_service_id, 0)) as o(ps_id, score)
    join public.provider_services ps on ps.id = o.ps_id
  on conflict (service_id, provider_id, provider_service_id) do nothing;
  return new;
end;
$$;
create trigger trg_services_sync_offers
  after insert or update of primary_provider_service_id, fallback_provider_service_id on public.services
  for each row execute function public.sync_offers_from_service();

create function public.sync_offers_from_provider_service()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.provider_service_offers
     set cost_per_1000    = new.rate_per_1000,
         min_quantity     = new.min_quantity,
         max_quantity     = new.max_quantity,
         refill_supported = new.refill_supported,
         cancel_supported = new.cancel_supported
   where provider_service_id = new.id;
  return new;
end;
$$;
create trigger trg_provider_services_sync_offers
  after update of rate_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported on public.provider_services
  for each row
  when (old.rate_per_1000 is distinct from new.rate_per_1000
     or old.min_quantity is distinct from new.min_quantity
     or old.max_quantity is distinct from new.max_quantity
     or old.refill_supported is distinct from new.refill_supported
     or old.cancel_supported is distinct from new.cancel_supported)
  execute function public.sync_offers_from_provider_service();

revoke all on function public.sync_offers_from_service(), public.sync_offers_from_provider_service()
  from public, anon, authenticated;
