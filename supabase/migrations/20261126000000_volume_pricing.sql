-- =============================================================================
-- Volume (tiered) pricing: the rate per 1000 depends on the quantity ordered.
--
-- platform_settings.volume_margin_tiers: [{ "min": 0, "margin": 0.80 }, { "min": 1000, "margin": 0.40 }, ...] - the markup on the
-- provider cost for orders of at least "min" units. Null (the default) = off: every quantity pays services.customer_rate_per_1000.
--
-- services.customer_rate_per_1000 stays the RETAIL rate (the first step, what the storefront shows); it is built by the price rules
-- on the cost basis (sync-catalog), so with a global rule equal to the first step's margin it is cost x (1 + margin0). A larger
-- order pays retail x (1 + margin_n) / (1 + margin0) = cost x (1 + margin_n), rounded UP to 4 decimals, and never less than the
-- provider cost plus the minimum margin (discount_min_margin_per_1000). The quote and the charge both come from
-- calculate_order_price, so they always agree; the quote also returns the rate and every step's rate for the app.
-- =============================================================================

create function public.valid_volume_tiers(p jsonb)
returns boolean
language sql
immutable
as $fn$
  select p is null or (
    jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 10
    and (p->0->>'min')::numeric = 0
    and not exists (
      select 1 from jsonb_array_elements(p) with ordinality e(t, i)
       where jsonb_typeof(t) <> 'object'
          or jsonb_typeof(t->'min') <> 'number' or jsonb_typeof(t->'margin') <> 'number'
          or (t->>'min')::numeric < 0 or (t->>'min')::numeric <> trunc((t->>'min')::numeric)
          or (t->>'margin')::numeric < 0 or (t->>'margin')::numeric > 10
          or (i > 1 and (t->>'min')::numeric <= (p->(i::int - 2)->>'min')::numeric))
  )
$fn$;

alter table public.platform_settings
  add column volume_margin_tiers jsonb default null
  constraint platform_settings_volume_margin_tiers_check check (public.valid_volume_tiers(volume_margin_tiers));

-- The rate per 1000 for a quantity, from the retail rate (the first step's).
create function public.volume_rate(p_rate numeric, p_quantity integer, p_tiers jsonb)
returns numeric
language plpgsql
immutable
as $fn$
declare
  v_m0 numeric;
  v_m  numeric;
begin
  if p_tiers is null or p_rate is null then return p_rate; end if;
  v_m0 := (p_tiers->0->>'margin')::numeric;
  select (t->>'margin')::numeric into v_m
    from jsonb_array_elements(p_tiers) t
   where (t->>'min')::integer <= p_quantity
   order by (t->>'min')::integer desc limit 1;
  if v_m is null or v_m = v_m0 then return p_rate; end if;
  return ceil(p_rate * (1 + v_m) / (1 + v_m0) * 10000) / 10000;
end;
$fn$;

create or replace function public.calculate_order_price(
  p_user_id    uuid,
  p_service_id uuid,
  p_quantity   integer,
  p_cost       numeric,
  p_promo_code text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate        numeric(14,4);
  v_base        numeric(14,4);
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
  select customer_rate_per_1000 into v_rate from services where id = p_service_id;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_cost is null or p_cost < 0 then
    raise exception 'invalid_parameter_value: quantity and cost must be positive' using errcode = 'invalid_parameter_value';
  end if;

  -- volume pricing: the rate per 1000 of the quantity's step (see volume_rate); off while volume_margin_tiers is null
  v_base := v_rate;
  select volume_margin_tiers into v_tiers from platform_settings where id = 1;
  if v_tiers is not null then
    v_rate := volume_rate(v_base, p_quantity, v_tiers);
    select coalesce(jsonb_agg(jsonb_build_object('min_quantity', (t->>'min')::integer, 'rate_per_1000', volume_rate(v_base, (t->>'min')::integer, v_tiers))
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

revoke all on function public.volume_rate(numeric, integer, jsonb) from public, anon, authenticated;
revoke all on function public.valid_volume_tiers(jsonb) from public, anon, authenticated;
grant execute on function public.volume_rate(numeric, integer, jsonb) to service_role;
grant execute on function public.valid_volume_tiers(jsonb) to service_role;
revoke all on function public.calculate_order_price(uuid, uuid, integer, numeric, text) from public, anon, authenticated;
