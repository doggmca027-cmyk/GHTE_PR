-- =============================================================================
-- An order is priced on the offer that serves its quantity: the quote and the charge are the same to the cent
--
-- A card's retail rate (services.customer_rate_per_1000) is built on its cheapest offer. Some cards have offers with different limits (a
-- retail panel takes 10..1000, a cheaper wholesale one 1000..1M): a quantity only a dearer offer can take was refused, because that offer
-- cost more than the card's rate. Now the price of an order follows the offer that takes it:
--
--   * quote-order and place-order pick the offer with the same router (routing.ts rankOffers: the cheapest working offer whose limits take
--     this quantity) and compute its retail rate with the same price rules as the storefront (order-pricing.ts: x1.8, x1.5 from $5, floor
--     cost + $0.02; the cheapest offer of the card simply gets the card's own rate). They pass the offer and the rate here.
--   * calculate_order_price(..., p_rate_per_1000, p_basis_per_1000): that rate, with the volume step scaled on that offer's cost.
--   * quote_order_price(..., p_offer_id, p_rate_per_1000) and place_order(..., p_priced_offer_id, p_rate_per_1000) price on that offer,
--     so the price shown is the price charged.
--   * when place-order has to fall over to another offer before sending (no API key, the order hub is full), the customer still pays
--     the quoted price; an offer that would not leave the minimum margin at that price is refused before anything is charged
--     ('offer_below_price', treated as a refusal before sending: the next offer is tried).
--
-- Without the new arguments the three functions behave as before.
-- =============================================================================

-- 1. calculate_order_price: an explicit rate and cost basis -----------------------------------------------------------------------------
drop function public.calculate_order_price(uuid, uuid, integer, numeric, text);

create function public.calculate_order_price(
  p_user_id         uuid,
  p_service_id      uuid,
  p_quantity        integer,
  p_cost            numeric,
  p_promo_code      text default null,
  p_rate_per_1000   numeric default null,
  p_basis_per_1000  numeric default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate        numeric(14,4);
  v_base        numeric(14,4);
  v_basis       numeric(14,4);
  v_tiers       jsonb;
  v_volume      jsonb := '[]'::jsonb;
  v_list        numeric(14,4);
  v_cost        numeric(14,4) := round(p_cost, 4);
  v_tier_id     uuid;
  v_tier_slug   text;
  v_tier_pct    numeric(5,2) := 0;
  v_tier        numeric(14,4);
  v_after_tier  numeric(14,4);
  v_promo       promo_codes%rowtype;
  v_promo_disc  numeric(14,4) := 0;
  v_margin      numeric(14,4);
  v_floor       numeric(14,4);
  v_room        numeric(14,4);
  v_wanted      numeric(14,4);
  v_capped      boolean := false;
  v_final       numeric(14,4);
  v_code        text := upper(nullif(btrim(p_promo_code), ''));
begin
  select customer_rate_per_1000, cost_basis_per_1000 into v_rate, v_basis from services where id = p_service_id;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_cost is null or p_cost < 0 then
    raise exception 'invalid_parameter_value: quantity and cost must be positive' using errcode = 'invalid_parameter_value';
  end if;
  -- the order is priced on the offer that serves it (the caller computed that offer's retail rate with the storefront's price rules)
  if p_rate_per_1000 is not null then
    if p_rate_per_1000 <= 0 then
      raise exception 'invalid_parameter_value: the rate must be positive' using errcode = 'invalid_parameter_value';
    end if;
    v_rate := round(p_rate_per_1000, 4);
    v_basis := p_basis_per_1000;
  end if;

  -- volume pricing: the rate per 1000 of the quantity's step (see volume_rate); off while volume_margin_tiers is null
  v_base := v_rate;
  select volume_margin_tiers into v_tiers from platform_settings where id = 1;
  if v_tiers is not null then
    v_rate := volume_rate(v_base, p_quantity, v_tiers, v_basis);
    select coalesce(jsonb_agg(jsonb_build_object('min_quantity', (t->>'min')::integer, 'rate_per_1000', volume_rate(v_base, (t->>'min')::integer, v_tiers, v_basis))
                    order by (t->>'min')::integer), '[]'::jsonb)
      into v_volume from jsonb_array_elements(v_tiers) t;
  end if;
  v_list := round(v_rate * p_quantity / 1000, 4);
  select discount_min_margin_per_1000 into v_margin from platform_settings where id = 1;
  if v_tiers is not null and v_list < v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4) then
    -- a step never sells under the provider cost plus the minimum margin
    v_list := v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4);
    v_rate := ceil(v_list * 1000 / p_quantity * 10000) / 10000;
  end if;

  select t.id, t.slug, t.discount_percentage into v_tier_id, v_tier_slug, v_tier_pct
    from users u join user_tiers t on t.id = u.tier_id and t.is_active
   where u.id = p_user_id;
  v_tier_pct := coalesce(v_tier_pct, 0);
  v_tier := round(v_list * v_tier_pct / 100, 4);
  v_after_tier := v_list - v_tier;

  if v_code is not null then
    select * into v_promo from promo_codes where code = v_code;
    if not found then
      raise exception 'promo_not_found: this promo code does not exist' using errcode = 'no_data_found';
    end if;
    if not v_promo.is_active then
      raise exception 'promo_inactive: this promo code is not active' using errcode = 'check_violation';
    end if;
    if v_promo.expires_at is not null and v_promo.expires_at <= now() then
      raise exception 'promo_expired: this promo code has expired' using errcode = 'check_violation';
    end if;
    if v_promo.max_uses is not null and v_promo.current_uses >= v_promo.max_uses then
      raise exception 'promo_exhausted: this promo code has been used up' using errcode = 'check_violation';
    end if;
    if exists (select 1 from promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then
      raise exception 'promo_already_used: you have already used this promo code' using errcode = 'unique_violation';
    end if;
    v_promo_disc := case v_promo.discount_type
      when 'percentage' then round(v_after_tier * v_promo.discount_value / 100, 4)
      else least(round(v_promo.discount_value, 4), v_after_tier) end;
  end if;

  v_floor := v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4);
  v_room := greatest(v_list - v_floor, 0);
  v_wanted := v_tier + v_promo_disc;
  if v_wanted > v_room then
    v_capped := true;
    v_tier := least(v_tier, v_room);                 -- the earned tier discount is served first
    v_promo_disc := least(v_promo_disc, v_room - v_tier);
  end if;

  v_final := v_list - v_tier - v_promo_disc;
  if v_final < v_cost then
    raise exception 'below_cost: the price % would be under the provider cost %', v_final, v_cost using errcode = 'check_violation';
  end if;
  if v_code is not null and v_promo_disc <= 0 then
    raise exception 'promo_not_applicable: this order has no room for a promo discount' using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'list_price', v_list, 'tier_id', v_tier_id, 'tier_slug', v_tier_slug, 'tier_percentage', v_tier_pct, 'tier_discount', v_tier,
    'promo_code_id', case when v_code is null then null else v_promo.id end, 'promo_discount', v_promo_disc,
    'final_price', v_final, 'floor_price', v_floor, 'provider_cost', v_cost, 'discount_requested', v_wanted,
    'capped', v_capped, 'rate_per_1000', v_rate, 'base_rate_per_1000', v_base, 'volume_rates', v_volume);
end;
$$;

revoke all on function public.calculate_order_price(uuid, uuid, integer, numeric, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.calculate_order_price(uuid, uuid, integer, numeric, text, numeric, numeric) to service_role;

-- 2. quote_order_price: the offer that will serve the order ------------------------------------------------------------------------------
drop function public.quote_order_price(uuid, uuid, integer, text, integer);

create function public.quote_order_price(
  p_user_id        uuid,
  p_service_id     uuid,
  p_quantity       integer,
  p_promo_code     text default null,
  p_runs           integer default 1,
  p_offer_id       uuid default null,
  p_rate_per_1000  numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost  numeric(14,4);
  v_offer numeric(14,4);
  v_runs  integer := coalesce(p_runs, 1);
begin
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  if v_runs < 1 then
    raise exception 'invalid_parameter_value: runs must be at least 1' using errcode = 'invalid_parameter_value';
  end if;
  if p_quantity % v_runs <> 0 then
    raise exception 'invalid_parameter_value: quantity must split evenly into runs' using errcode = 'invalid_parameter_value';
  end if;

  if p_offer_id is not null then
    -- the offer quote-order routed this quantity to (the same router as place-order): it must be able to take the order
    select o.cost_per_1000 into v_offer
      from provider_service_offers o
      join providers p on p.id = o.provider_id
      join provider_services ps on ps.id = o.provider_service_id
     where o.id = p_offer_id and o.service_id = p_service_id and o.is_active and ps.is_active and p.is_active and p.routing_enabled
       and p_quantity / v_runs between o.min_quantity and o.max_quantity
       and (v_runs = 1 or ps.is_dripfeed_enabled);
    if v_offer is null then
      raise exception 'service_unavailable: no provider can take this order' using errcode = 'no_data_found';
    end if;
    if p_rate_per_1000 is null or p_rate_per_1000 < v_offer then
      raise exception 'below_cost: the rate is under the cost of the offer' using errcode = 'check_violation';
    end if;
    return calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_offer * p_quantity / 1000, 4), p_promo_code, p_rate_per_1000, v_offer);
  end if;

  -- Without an offer (the old call): the most expensive offer that can take the order and still be sold at the card's rate, so the
  -- customer is never shown less than they pay. A drip-feed order is taken run by run, so an offer must take one run, and must be
  -- drip-feed capable.
  select max(o.cost_per_1000) into v_cost
    from provider_service_offers o
    join providers p on p.id = o.provider_id
    join provider_services ps on ps.id = o.provider_service_id
    join services s on s.id = o.service_id
   where o.service_id = p_service_id and o.is_active and ps.is_active and p.is_active and p.routing_enabled
     and p_quantity / v_runs between o.min_quantity and o.max_quantity
     and (v_runs = 1 or ps.is_dripfeed_enabled)
     and o.cost_per_1000 <= s.customer_rate_per_1000;
  if v_cost is null then
    raise exception 'service_unavailable: no provider can take this order' using errcode = 'no_data_found';
  end if;
  -- the price is for the TOTAL quantity
  return calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_cost * p_quantity / 1000, 4), p_promo_code);
end;
$$;

revoke all on function public.quote_order_price(uuid, uuid, integer, text, integer, uuid, numeric) from public, anon, authenticated;
grant execute on function public.quote_order_price(uuid, uuid, integer, text, integer, uuid, numeric) to service_role;

-- 3. place_order: priced on the quoted offer ----------------------------------------------------------------------------------------------
drop function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer);

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
  p_interval            integer default 0,
  p_priced_offer_id     uuid default null,
  p_rate_per_1000       numeric default null
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
  v_pcost    numeric(14,4);
  v_margin   numeric(14,4);
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
  if p_rate_per_1000 is not null then
    -- priced on the offer the quote showed (the one routing picked for this quantity); the offer that serves the order is either that one
    -- or, after a refusal before sending, the next one, which pays the same price
    if p_priced_offer_id is null or p_priced_offer_id = v_offer.id then
      v_pcost := v_offer.cost_per_1000;
    else
      select cost_per_1000 into v_pcost from provider_service_offers where id = p_priced_offer_id and service_id = p_service_id;
      if not found then
        raise exception 'provider offer not found, inactive or not valid for this service' using errcode = 'no_data_found';
      end if;
    end if;
    if p_rate_per_1000 < v_pcost then
      raise exception 'below_cost: the rate is under the cost of the offer' using errcode = 'check_violation';
    end if;
    v_price := calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_pcost * p_quantity / 1000, 4), v_code, p_rate_per_1000, v_pcost);
  else
    v_price := calculate_order_price(p_user_id, p_service_id, p_quantity, v_cost, v_code);
  end if;
  v_charge := (v_price->>'final_price')::numeric;
  if v_charge <= 0 then
    raise exception 'order total is too small' using errcode = 'check_violation';
  end if;
  if p_rate_per_1000 is not null and p_priced_offer_id is not null and p_priced_offer_id <> v_offer.id then
    -- another offer than the quoted one serves the order: only while the quoted price still leaves it the minimum margin (refused before
    -- anything is charged, so place-order tries the next offer)
    select discount_min_margin_per_1000 into v_margin from platform_settings where id = 1;
    if v_charge < v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4) then
      raise exception 'offer_below_price: the price % does not cover the cost % of this offer', v_charge, v_cost using errcode = 'check_violation';
    end if;
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

revoke all on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer, uuid, numeric) from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean, integer, integer, uuid, numeric) to service_role;
