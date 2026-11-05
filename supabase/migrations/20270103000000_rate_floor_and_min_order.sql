-- =============================================================================
-- An absolute floor under every price per 1000, and a minimum order amount that refuses instead of lifting
--
-- 1. THE BUG. A volume step (1,000 and 10,000 units) never went under cost x 1.35 and cost + 0.05 per 1000: a floor built on the COST. A service
--    that costs $0.017 per 1000 is sold at $0.12 from the first unit (rule min_price), but its steps came out at $0.067: below the rule's own price
--    floor, with next to no margin. Now no price per 1000 of any step is under platform_settings.min_rate_per_1000 ($0.12), whatever the cost
--    and the discount (never above the retail rate of the card itself, so a card sold lower on purpose is not lifted by its own steps).
--    volume_floor_rate() reads the setting itself, so calculate_order_price and price_ladder (both call it) need no change for this.
--    The catalogue sync holds the same floor for the retail price (price-engine.ts DEFAULT_MIN_RATE, 0.12): tests/rate-floor.test.ts keeps both honest.
--
-- 2. THE MINIMUM ORDER. platform_settings.min_order_charge was a cent and LIFTED a small order to it. It is now $0.10 and REFUSES: an order whose
--    price is under it fails with 'min_order_amount' (place_order passes the error through; quote-order and place-order answer 400 min_order_amount;
--    the order form blocks the button: "Minimum order amount: $0.10"). Discounts never take an order under it (that part is unchanged).
--
-- The function below is calculate_order_price of 20261224000000_personal_promo.sql with that one block changed.
-- =============================================================================

alter table public.platform_settings
  add column if not exists min_rate_per_1000 numeric(14,4) not null default 0.12 check (min_rate_per_1000 >= 0);
comment on column public.platform_settings.min_rate_per_1000 is 'No price per 1000 (retail or volume step) is lower than this (USD), except that a step never exceeds its card''s retail rate.';

alter table public.platform_settings alter column min_order_charge set default 0.10;
comment on column public.platform_settings.min_order_charge is 'The minimum order amount (USD): a smaller order is refused (min_order_amount); discounts never take an order under it.';
update public.platform_settings set min_order_charge = 0.10 where min_order_charge < 0.10;

-- The rate per 1000 a volume step charges at most down to: cost x multiplier and cost + markup (when the cost is known) and the absolute floor,
-- rounded up, never above the retail rate.
create or replace function public.volume_floor_rate(p_base numeric, p_basis numeric, p_multiplier numeric, p_markup numeric)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select least(
    p_base,
    greatest(
      case when p_basis is null or p_basis <= 0 then 0
           else greatest(ceil(p_basis * coalesce(p_multiplier, 1) * 10000) / 10000, p_basis + coalesce(p_markup, 0)) end,
      coalesce((select min_rate_per_1000 from public.platform_settings where id = 1), 0)))
$$;
revoke all on function public.volume_floor_rate(numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.volume_floor_rate(numeric, numeric, numeric, numeric) to service_role;

create or replace function public.calculate_order_price(
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
  v_set         platform_settings%rowtype;
  v_step_floor  numeric(14,4);
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
  select * into v_set from platform_settings where id = 1;

  -- volume pricing: the rate per 1000 of the quantity's step (see volume_rate), never under the step floor; off while volume_margin_tiers is null
  v_base := v_rate;
  v_tiers := v_set.volume_margin_tiers;
  if v_tiers is not null then
    v_step_floor := volume_floor_rate(v_base, v_basis, v_set.volume_floor_multiplier, v_set.volume_floor_markup);
    v_rate := greatest(volume_rate(v_base, p_quantity, v_tiers, v_basis), coalesce(v_step_floor, 0));
    select coalesce(jsonb_agg(jsonb_build_object('min_quantity', (t->>'min')::integer,
                      'rate_per_1000', greatest(volume_rate(v_base, (t->>'min')::integer, v_tiers, v_basis), coalesce(v_step_floor, 0)))
                    order by (t->>'min')::integer), '[]'::jsonb)
      into v_volume from jsonb_array_elements(v_tiers) t;
  end if;
  v_list := round(v_rate * p_quantity / 1000, 4);
  v_margin := v_set.discount_min_margin_per_1000;
  if v_tiers is not null and v_list < v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4) then
    -- a step never sells under the provider cost plus the minimum margin
    v_list := v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4);
    v_rate := ceil(v_list * 1000 / p_quantity * 10000) / 10000;
  end if;
  -- no order costs less than the minimum amount ($0.10): it is refused, not raised. The app blocks the button with the same words; this is the
  -- guard for every other way in (place-order, a stale form, a script). The discounts below never take an order under it either.
  if v_list < coalesce(v_set.min_order_charge, 0) then
    raise exception 'min_order_amount: the minimum order amount is %', v_set.min_order_charge using errcode = 'check_violation';
  end if;

  select t.id, t.slug, t.discount_percentage into v_tier_id, v_tier_slug, v_tier_pct
    from users u join user_tiers t on t.id = u.tier_id and t.is_active
   where u.id = p_user_id;
  v_tier_pct := coalesce(v_tier_pct, 0);
  v_tier := round(v_list * v_tier_pct / 100, 4);
  v_after_tier := v_list - v_tier;

  if v_code is not null then
    select * into v_promo from promo_codes where code = v_code;
    -- a personal code does not exist for anybody but its owner
    if not found or (v_promo.owner_user_id is not null and v_promo.owner_user_id is distinct from p_user_id) then
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
    -- a shared code is once per customer; a personal code is used up to max_uses times by its owner
    if v_promo.owner_user_id is null and exists (select 1 from promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then
      raise exception 'promo_already_used: you have already used this promo code' using errcode = 'unique_violation';
    end if;
    v_promo_disc := case
      when v_promo.of_markup then round(greatest(v_after_tier - v_cost, 0) * v_promo.discount_value / 100, 4)
      when v_promo.discount_type = 'percentage' then round(v_after_tier * v_promo.discount_value / 100, 4)
      else least(round(v_promo.discount_value, 4), v_after_tier) end;
  end if;

  v_floor := v_cost + round(coalesce(v_margin, 0) * p_quantity / 1000, 4);
  -- the discounts never take the price under cost + the minimum margin, nor under the minimum charge
  v_room := greatest(least(v_list - v_floor, v_list - coalesce(v_set.min_order_charge, 0)), 0);
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
