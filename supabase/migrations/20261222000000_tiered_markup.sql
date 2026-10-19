-- =============================================================================
-- Tiered markup, a minimum order charge, a floor under the volume steps; the flight-test card leaves the storefront
--
-- A 10-view order of a $0.006 service cost the customer $0.0003 (owner, 2026-10-19). The owner's new price grid per 1000, on the cost:
--     cost < 0.05          max(cost x 5,   cost + 0.10, 0.12)
--     0.05 <= cost < 0.50  max(cost x 3,   cost + 0.12)
--     0.50 <= cost < 5.00  max(cost x 2,   cost + 0.30)
--     cost >= 5.00         cost x 1.6
-- is four tier rules (price_rules, entered on production by the owner's request); a rule may now carry two minimums the engine applies
-- (price-engine.ts): min_markup (at least cost + this) and min_price (at least this).
--
--   1. price_rules.min_markup / min_price
--   2. platform_settings.min_order_charge (0.01): no order costs less than one cent; the quote and the charge are lifted to it, the
--      discounts never take an order under it
--   3. platform_settings.volume_floor_multiplier / volume_floor_markup (1.35 / 0.05): a volume step never goes under cost x 1.35 nor
--      under cost + 0.05 per 1000 (never above the retail rate itself); calculate_order_price and price_ladder apply it
--   4. the "flight test" cards of the live provider test (docs/LIVE_TEST_RUNBOOK.md) are switched off
-- =============================================================================

-- 1. ---------------------------------------------------------------------------------------------------------------------------------------
alter table public.price_rules
  add column if not exists min_markup numeric(14,4) check (min_markup is null or min_markup >= 0),
  add column if not exists min_price  numeric(14,4) check (min_price is null or min_price >= 0);
comment on column public.price_rules.min_markup is 'The rule''s price per 1000 is at least cost + this (null: no minimum).';
comment on column public.price_rules.min_price is 'The rule''s price per 1000 is at least this, whatever the cost (null: no minimum).';

-- 2. / 3. --------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings
  add column if not exists min_order_charge        numeric(14,4) not null default 0.01 check (min_order_charge >= 0),
  add column if not exists volume_floor_multiplier numeric(6,4)  not null default 1.35 check (volume_floor_multiplier >= 1),
  add column if not exists volume_floor_markup     numeric(14,4) not null default 0.05 check (volume_floor_markup >= 0);
comment on column public.platform_settings.min_order_charge is 'No order costs the customer less than this (USD).';
comment on column public.platform_settings.volume_floor_multiplier is 'A volume step never charges less than cost x this per 1000.';
comment on column public.platform_settings.volume_floor_markup is 'A volume step never charges less than cost + this per 1000.';

-- The rate per 1000 a volume step charges at most down to: cost x multiplier and cost + markup, rounded up, never above the retail rate.
create or replace function public.volume_floor_rate(p_base numeric, p_basis numeric, p_multiplier numeric, p_markup numeric)
returns numeric
language sql
immutable
as $$
  select case when p_basis is null or p_basis <= 0 then null
              else least(p_base, greatest(ceil(p_basis * coalesce(p_multiplier, 1) * 10000) / 10000, p_basis + coalesce(p_markup, 0))) end
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
  -- no order costs less than the minimum charge (one cent): 10 views of a $0.12 service are $0.01, not $0.0012
  if v_list < coalesce(v_set.min_order_charge, 0) then
    v_list := v_set.min_order_charge;
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

create or replace function public.price_ladder(p_segments jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_set platform_settings%rowtype;
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' then
    raise exception 'invalid_parameter_value: segments must be an array' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_set from platform_settings where id = 1;
  return coalesce((
    with seg as (
      select (s->>'from')::integer f, (s->>'to')::integer t, (s->>'rate_per_1000')::numeric r, (s->>'basis_per_1000')::numeric b
        from jsonb_array_elements(p_segments) s
    ), pts as (
      select f as q, r, b from seg
      union all
      select (x->>'min')::integer, r, b
        from seg, jsonb_array_elements(coalesce(v_set.volume_margin_tiers, '[]'::jsonb)) x
       where (x->>'min')::integer > f and (x->>'min')::integer <= t
    )
    select jsonb_agg(jsonb_build_object(
             'min_quantity', q,
             'rate_per_1000', greatest(
                volume_rate(r, q, v_set.volume_margin_tiers, b),
                case when v_set.volume_margin_tiers is null then 0 else coalesce(volume_floor_rate(r, b, v_set.volume_floor_multiplier, v_set.volume_floor_markup), 0) end,
                ceil((b + coalesce(v_set.discount_min_margin_per_1000, 0)) * 10000) / 10000))
           order by q)
      from pts
     where r > 0 and b >= 0), '[]'::jsonb);
end;
$$;

-- 4. ---------------------------------------------------------------------------------------------------------------------------------------
do $$
declare
  v_cats uuid[];
begin
  with off as (
    update public.services set is_active = false where is_active and name ilike '%flight test%' returning category_id
  )
  select array_agg(distinct category_id) into v_cats from off;
  if v_cats is not null then
    perform public.recount_categories(v_cats);
  end if;
end;
$$;
