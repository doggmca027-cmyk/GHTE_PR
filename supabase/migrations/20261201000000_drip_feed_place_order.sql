-- =============================================================================
-- Drip-feed, part 3: place_order takes runs and interval
--
-- quantity stays the order's TOTAL: the price, the provider cost and the wallet debit are all computed on it exactly as before (the customer
-- gets the volume step of the whole order). A drip-feed order is `runs` deliveries of quantity / runs, `interval` minutes apart; a panel checks
-- its min/max against ONE delivery, so the service and offer limits are checked against quantity / runs. Further rules for runs > 1:
--   * the total must split into whole deliveries (quantity % runs = 0), else nothing is charged
--   * the provider service of the chosen offer must be drip-feed capable (provider_services.is_dripfeed_enabled, written by sync-catalog)
-- A plain order (runs = 1) behaves exactly as before; its interval is stored as 0.
-- Everything else (locks, idempotency, promo, reservation, deferred funding, ledger) is unchanged from 20261115000000_deferred_funding.sql.
-- =============================================================================

drop function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean);

create function public.place_order(
  p_user_id             uuid,
  p_service_id          uuid,
  p_target_url          text,
  p_quantity            integer,
  p_provider_offer_id   uuid,
  p_provider_id         uuid,
  p_provider_service_id uuid,
  p_cost_amount         numeric,
  p_idempotency_key     text default null,
  p_promo_code          text default null,
  p_allow_unfunded      boolean default false,
  p_runs                integer default 1,
  p_interval            integer default 0
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_svc      services%rowtype;
  v_offer    provider_service_offers%rowtype;
  v_order    orders%rowtype;
  v_price    jsonb;
  v_charge   numeric(14,4);
  v_cost     numeric(14,4);
  v_reserved numeric(14,4) := 0;
  v_avail    numeric(14,4);
  v_code     text := upper(nullif(btrim(p_promo_code), ''));
  v_promo_id uuid;
  v_unfunded boolean := false;
  v_settings platform_settings%rowtype;
  v_runs     integer := coalesce(p_runs, 1);
  v_interval integer;
  v_per_run  integer;
begin
  -- Drip-feed shape first: nothing is locked or charged for a request that cannot be an order.
  if v_runs < 1 then
    raise exception 'runs must be at least 1' using errcode = 'check_violation';
  end if;
  v_interval := case when v_runs = 1 then 0 else coalesce(p_interval, 0) end;
  if v_interval < 0 then
    raise exception 'interval must not be negative' using errcode = 'check_violation';
  end if;
  if p_quantity % v_runs <> 0 then
    raise exception 'quantity must split evenly into runs' using errcode = 'check_violation';
  end if;
  v_per_run := p_quantity / v_runs;

  -- Serialise all purchases of this user; also makes the idempotency lookup race-free.
  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  if p_idempotency_key is not null then
    select * into v_order from orders where idempotency_key = p_idempotency_key;
    if found then
      if v_order.user_id <> p_user_id or v_order.service_id <> p_service_id
         or v_order.quantity <> p_quantity or v_order.target_url <> p_target_url
         or v_order.runs <> v_runs or v_order.interval <> v_interval then
        raise exception 'idempotency key % was already used with different parameters', p_idempotency_key
          using errcode = 'unique_violation';
      end if;
      return v_order;  -- a replay keeps its original routing snapshot and price (and reserves / redeems nothing again)
    end if;
  end if;

  -- SHARE locks: the price and the cost this order is checked against cannot change before it commits.
  select * into v_svc from services where id = p_service_id and is_active for share;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  -- the limits hold for one delivery (the whole order when runs = 1)
  if v_per_run < v_svc.min_quantity or v_per_run > v_svc.max_quantity then
    if v_runs = 1 then
      raise exception 'quantity must be between % and %', v_svc.min_quantity, v_svc.max_quantity
        using errcode = 'check_violation';
    end if;
    raise exception 'quantity per run must be between % and %', v_svc.min_quantity, v_svc.max_quantity
      using errcode = 'check_violation';
  end if;

  select * into v_offer from provider_service_offers
   where id = p_provider_offer_id and service_id = p_service_id and is_active for share;
  if not found
     or v_offer.provider_id <> p_provider_id
     or v_offer.provider_service_id <> p_provider_service_id then
    raise exception 'provider offer not found, inactive or not valid for this service' using errcode = 'no_data_found';
  end if;
  if v_per_run < v_offer.min_quantity or v_per_run > v_offer.max_quantity then
    raise exception 'quantity is outside the limits of the selected provider offer' using errcode = 'check_violation';
  end if;
  if v_runs > 1 and not exists (
       select 1 from provider_services where id = v_offer.provider_service_id and is_dripfeed_enabled) then
    raise exception 'the selected provider offer does not support drip-feed' using errcode = 'check_violation';
  end if;

  -- the cost and the price are for the TOTAL quantity
  v_cost := round(p_cost_amount, 4);
  if p_cost_amount is null or p_cost_amount < 0
     or abs(v_cost - round(v_offer.cost_per_1000 * p_quantity / 1000, 4)) > 0.0001 then
    raise exception 'cost does not match the selected provider offer' using errcode = 'check_violation';
  end if;

  -- The promo row is locked until commit: concurrent orders queue here, so max_uses can never be exceeded.
  if v_code is not null then
    select id into v_promo_id from promo_codes where code = v_code for update;
  end if;
  v_price := calculate_order_price(p_user_id, p_service_id, p_quantity, v_cost, v_code);
  v_charge := (v_price->>'final_price')::numeric;
  if v_charge <= 0 then
    raise exception 'order total is too small' using errcode = 'check_violation';
  end if;

  -- Reserve the provider cost: one atomic UPDATE, the funds check inside its WHERE. Concurrent orders queue on the
  -- provider row, and the second one re-evaluates the WHERE against the first one's result.
  if v_cost > 0 then
    update providers set provider_balance = provider_balance - v_cost
     where id = v_offer.provider_id and last_balance_sync is not null and provider_balance >= v_cost
    returning provider_balance into v_avail;
    if found then
      v_reserved := v_cost;
    elsif exists (select 1 from providers where id = v_offer.provider_id and last_balance_sync is not null) then
      select provider_balance into v_avail from providers where id = v_offer.provider_id;
      -- Not enough at the provider. With the switch on and room under the cap, the order is accepted and waits for the provider to be funded.
      if p_allow_unfunded then
        select * into v_settings from platform_settings where id = 1 for update;   -- serialises the cap check of concurrent waiting orders
        if v_settings.deferred_orders_enabled
           and (select coalesce(sum(charge_amount), 0) from orders where awaiting_funds_since is not null and status = 'paid') + v_charge
               <= v_settings.deferred_orders_cap then
          v_unfunded := true;
        end if;
      end if;
      if not v_unfunded then
        raise exception 'insufficient_provider_balance: available %, required %', v_avail, v_cost
          using errcode = 'check_violation';
      end if;
    end if;
    -- balance never synced: nothing to reserve against (the health monitor syncs every routing-enabled provider)
  end if;

  insert into orders (user_id, service_id, target_url, quantity, charge_amount, cost_amount, profit_amount,
                      provider_id, provider_offer_id, routing_score_snapshot, idempotency_key, provider_reservation,
                      list_price_amount, tier_discount_amount, promo_discount_amount, promo_code_id, discount_capped,
                      awaiting_funds_since, runs, interval)
  values (p_user_id, p_service_id, p_target_url, p_quantity, v_charge, v_cost, v_charge - v_cost,
          v_offer.provider_id, v_offer.id, v_offer.routing_score, p_idempotency_key, v_reserved,
          (v_price->>'list_price')::numeric, (v_price->>'tier_discount')::numeric, (v_price->>'promo_discount')::numeric,
          v_promo_id, (v_price->>'capped')::boolean,
          case when v_unfunded then now() end, v_runs, v_interval)
  returning * into v_order;

  if v_promo_id is not null then
    update promo_codes set current_uses = current_uses + 1 where id = v_promo_id;   -- locked above; the CHECK holds max_uses
    insert into promo_code_redemptions (promo_code_id, user_id, order_id, discount_amount)
    values (v_promo_id, p_user_id, v_order.id, (v_price->>'promo_discount')::numeric);
  end if;

  update orders set status = 'awaiting_payment' where id = v_order.id;

  perform process_wallet_transaction(
    p_user_id, 'purchase', -v_charge, v_order.id,
    'Order ' || v_order.id, 'purchase:' || v_order.id);

  update orders set status = 'paid' where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer) to service_role;
