-- =============================================================================
-- Personal promo codes, and a discount that is a share of the markup
--
-- The owner gives a customer their own code (2026-10-23): only that customer can apply it, up to max_uses times, on every service, and it
-- takes 70% off the markup (the customer pays the provider cost + 30% of the markup).
--
--   1. promo_codes.owner_user_id: set, the code is that user's alone (anybody else gets promo_not_found) and promo_one_use_per_user no
--      longer applies to it: max_uses counts that user's uses. A shared code (null) stays once per customer, now held by a trigger
--   2. promo_codes.of_markup: a percentage code takes its percent of (price after the tier discount - provider cost) instead of the price
--   3. calculate_order_price: both of the above; the floors and caps are unchanged
-- =============================================================================

-- 1. / 2. --------------------------------------------------------------------------------------------------------------------------------
alter table public.promo_codes
  add column if not exists owner_user_id uuid references public.users(id) on delete cascade,
  add column if not exists of_markup boolean not null default false;
alter table public.promo_codes drop constraint if exists promo_markup_is_percentage;
alter table public.promo_codes add constraint promo_markup_is_percentage check (not of_markup or discount_type = 'percentage');
comment on column public.promo_codes.owner_user_id is 'Set: a personal code, only this user can apply it (max_uses times). Null: anybody, once each.';
comment on column public.promo_codes.of_markup is 'The percentage is taken off the markup (price - provider cost), not off the price.';

alter table public.promo_code_redemptions drop constraint if exists promo_one_use_per_user;
create index if not exists promo_code_redemptions_code_user_idx on public.promo_code_redemptions (promo_code_id, user_id);

-- place_order locks the promo_codes row before it writes the redemption, so two orders of one customer cannot both pass this check
create or replace function public.promo_redemption_once_per_user()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from promo_codes c where c.id = new.promo_code_id and c.owner_user_id is null)
     and exists (select 1 from promo_code_redemptions r where r.promo_code_id = new.promo_code_id and r.user_id = new.user_id) then
    raise exception 'promo_already_used: you have already used this promo code' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.promo_redemption_once_per_user() from public, anon, authenticated;
drop trigger if exists promo_redemption_once_per_user on public.promo_code_redemptions;
create trigger promo_redemption_once_per_user before insert on public.promo_code_redemptions
  for each row execute function public.promo_redemption_once_per_user();

-- 3. -------------------------------------------------------------------------------------------------------------------------------------
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
