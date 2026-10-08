-- =============================================================================
-- Phase 13: wholesale tiers and promo codes (the discount engine)
--
--   user_tiers / users.tier_id        volume tiers: a % off the list price, earned by the last 30 days of spend
--   promo_codes / promo_code_redemptions   percentage or fixed codes; one use per user, max_uses, expiry (append-only redemptions)
--   calculate_order_price()           THE price maths, used by place_order and by quote_order_price (what the customer is shown)
--   place_order()                     charges the final price; the discounts can never push it under cost + minimum margin
--   recalculate_user_tiers()          upgrades / downgrades everyone from their last 30 days (pg_cron, hourly)
--
-- Order of operations (every amount numeric(14,4), rounded half away from zero at 1e-4):
--   list     = round(rate_per_1000 x quantity / 1000, 4)
--   tier     = round(list x tier% / 100, 4)
--   promo    = percentage: round((list - tier) x value / 100, 4)      fixed: least(value, list - tier)
--   floor    = provider cost + round(minimum margin per 1000 x quantity / 1000, 4)
--   room     = greatest(list - floor, 0)                              the most discount this order can carry
--   if tier + promo > room the discounts are CAPPED, never the price raised above the list: tier is served first, the promo
--   gets what is left. final = list - tier - promo.
--   A list price that is itself below cost is refused (below_cost); a promo that would give nothing is refused (promo_not_applicable).
--
-- Locking: place_order holds the user's wallet row (as before), SHARE locks on the service and offer rows it priced from (a
-- repricing or cost change cannot slip in between the check and the charge) and the promo row FOR UPDATE (max_uses cannot be
-- exceeded by concurrent orders). A CHECK on orders (charge >= cost for every order priced by this engine) is the last line.
-- Service role only: the Edge Functions are the callers.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column discount_min_margin_per_1000 numeric(14,4) not null default 0.01 check (discount_min_margin_per_1000 >= 0);

create table public.user_tiers (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9_-]{2,30}$'),
  name               text not null,
  discount_percentage numeric(5,2) not null default 0 check (discount_percentage between 0 and 50),
  min_monthly_spend  numeric(14,4) not null default 0 check (min_monthly_spend >= 0),
  sort_order         integer not null default 0,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);
create unique index uq_user_tiers_threshold on public.user_tiers (min_monthly_spend) where is_active;

insert into public.user_tiers (slug, name, discount_percentage, min_monthly_spend, sort_order) values
  ('bronze', 'Bronze', 0,   0,    1),
  ('silver', 'Silver', 2,   100,  2),
  ('gold',   'Gold',   4,   500,  3),
  ('vip',    'VIP',    6,   2000, 4);

alter table public.users add column tier_id uuid references public.user_tiers(id) on delete restrict;
update public.users set tier_id = (select id from public.user_tiers where slug = 'bronze');

-- everyone who signs up later starts at the lowest tier too
create function public.users_default_tier()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.tier_id is null then
    new.tier_id := (select id from user_tiers where is_active order by min_monthly_spend asc limit 1);
  end if;
  return new;
end;
$$;
create trigger trg_users_default_tier before insert on public.users
  for each row execute function public.users_default_tier();

create type public.promo_discount_type as enum ('percentage', 'fixed');

create table public.promo_codes (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
  discount_type  public.promo_discount_type not null,
  discount_value numeric(14,4) not null check (discount_value > 0),
  max_uses       integer check (max_uses is null or max_uses > 0),
  current_uses   integer not null default 0 check (current_uses >= 0),
  expires_at     timestamptz,
  is_active      boolean not null default true,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint promo_percentage_range check (discount_type <> 'percentage' or discount_value <= 90),
  constraint promo_uses_within_max check (max_uses is null or current_uses <= max_uses)
);

create table public.promo_code_redemptions (
  id              uuid primary key default gen_random_uuid(),
  promo_code_id   uuid not null references public.promo_codes(id) on delete restrict,
  user_id         uuid not null references public.users(id) on delete restrict,
  order_id        uuid not null unique references public.orders(id) on delete restrict,
  discount_amount numeric(14,4) not null check (discount_amount > 0),
  created_at      timestamptz not null default now(),
  constraint promo_one_use_per_user unique (promo_code_id, user_id)
);
create trigger trg_promo_redemptions_no_update before update on public.promo_code_redemptions
  for each row execute function public.forbid_mutation();
create trigger trg_promo_redemptions_no_delete before delete on public.promo_code_redemptions
  for each row execute function public.forbid_mutation();
create trigger trg_promo_redemptions_no_truncate before truncate on public.promo_code_redemptions
  for each statement execute function public.forbid_mutation();

alter table public.user_tiers enable row level security;
alter table public.promo_codes enable row level security;
alter table public.promo_code_redemptions enable row level security;
revoke all on table public.user_tiers, public.promo_codes, public.promo_code_redemptions from anon, authenticated;

-- What each order was priced at (NULL for orders from before this engine).
alter table public.orders
  add column list_price_amount     numeric(14,4),
  add column tier_discount_amount  numeric(14,4) not null default 0 check (tier_discount_amount >= 0),
  add column promo_discount_amount numeric(14,4) not null default 0 check (promo_discount_amount >= 0),
  add column promo_code_id         uuid references public.promo_codes(id) on delete restrict,
  add column discount_capped       boolean not null default false,
  -- the last line of defence: nothing priced by this engine is ever sold under its provider cost
  add constraint orders_not_below_cost check (list_price_amount is null or charge_amount >= cost_amount);

-- Pricing terms are frozen with the rest of the commercial terms once the order leaves draft.
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

  if old.status <> 'draft'
     and (new.user_id <> old.user_id
          or new.service_id <> old.service_id
          or new.target_url <> old.target_url
          or new.quantity <> old.quantity
          or new.charge_amount <> old.charge_amount
          or new.provider_offer_id is distinct from old.provider_offer_id
          or new.routing_score_snapshot <> old.routing_score_snapshot
          or new.profit_amount <> old.profit_amount
          or new.list_price_amount is distinct from old.list_price_amount
          or new.tier_discount_amount <> old.tier_discount_amount
          or new.promo_discount_amount <> old.promo_discount_amount
          or new.promo_code_id is distinct from old.promo_code_id) then
    raise exception 'order % commercial terms are immutable after draft', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. The price maths (one place)
-- -----------------------------------------------------------------------------
create function public.calculate_order_price(
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

  v_list := round(v_rate * p_quantity / 1000, 4);

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

  select discount_min_margin_per_1000 into v_margin from platform_settings where id = 1;
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
    'capped', v_capped);
end;
$$;

-- What the customer is shown before ordering. The cost is the cheapest offer that can receive the order: the router may pick a
-- dearer one for reliability, in which case the margin floor can only reduce the discount at placement, never the other way.
create function public.quote_order_price(p_user_id uuid, p_service_id uuid, p_quantity integer, p_promo_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost numeric(14,4);
begin
  select min(o.cost_per_1000) into v_cost
    from provider_service_offers o
    join providers p on p.id = o.provider_id
    join provider_services ps on ps.id = o.provider_service_id
   where o.service_id = p_service_id and o.is_active and ps.is_active and p.is_active and p.routing_enabled
     and p_quantity between o.min_quantity and o.max_quantity;
  if v_cost is null then
    raise exception 'service_unavailable: no provider can take this order' using errcode = 'no_data_found';
  end if;
  return calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_cost * p_quantity / 1000, 4), p_promo_code);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. place_order: the same atomic order, now priced by the engine
-- -----------------------------------------------------------------------------
drop function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text);

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
  p_promo_code          text default null
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
      return v_order;  -- a replay keeps its original routing snapshot and price (and reserves / redeems nothing again)
    end if;
  end if;

  -- SHARE locks: the price and the cost this order is checked against cannot change before it commits.
  select * into v_svc from services where id = p_service_id and is_active for share;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  if p_quantity < v_svc.min_quantity or p_quantity > v_svc.max_quantity then
    raise exception 'quantity must be between % and %', v_svc.min_quantity, v_svc.max_quantity
      using errcode = 'check_violation';
  end if;

  select * into v_offer from provider_service_offers
   where id = p_provider_offer_id and service_id = p_service_id and is_active for share;
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
      raise exception 'insufficient_provider_balance: available %, required %', v_avail, v_cost
        using errcode = 'check_violation';
    end if;
    -- balance never synced: nothing to reserve against (the health monitor syncs every routing-enabled provider)
  end if;

  insert into orders (user_id, service_id, target_url, quantity, charge_amount, cost_amount, profit_amount,
                      provider_id, provider_offer_id, routing_score_snapshot, idempotency_key, provider_reservation,
                      list_price_amount, tier_discount_amount, promo_discount_amount, promo_code_id, discount_capped)
  values (p_user_id, p_service_id, p_target_url, p_quantity, v_charge, v_cost, v_charge - v_cost,
          v_offer.provider_id, v_offer.id, v_offer.routing_score, p_idempotency_key, v_reserved,
          (v_price->>'list_price')::numeric, (v_price->>'tier_discount')::numeric, (v_price->>'promo_discount')::numeric,
          v_promo_id, (v_price->>'capped')::boolean)
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

-- -----------------------------------------------------------------------------
-- 4. Tiers follow the last 30 days of spend
-- -----------------------------------------------------------------------------
-- Net spend = charge - partial refund of the user's completed / partial orders created in the window (refunded and canceled
-- orders do not count). The highest active tier whose threshold the spend reaches wins; everyone is placed, so spend that
-- falls away downgrades. Idempotent; only rows that change are written.
create function public.recalculate_user_tiers()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  with spend as (
    select o.user_id, sum(o.charge_amount - o.partial_refund_amount) as total
      from orders o
     where o.status in ('completed', 'partial') and o.created_at >= now() - interval '30 days'
     group by o.user_id
  ), target as (
    select u.id, u.tier_id as old_tier,
           (select t.id from user_tiers t where t.is_active and t.min_monthly_spend <= coalesce(s.total, 0)
             order by t.min_monthly_spend desc limit 1) as new_tier
      from users u left join spend s on s.user_id = u.id
  ), changed as (
    update users u set tier_id = t.new_tier
      from target t
     where u.id = t.id and t.new_tier is not null and u.tier_id is distinct from t.new_tier
    returning u.id, t.old_tier, t.new_tier
  )
  select jsonb_build_object(
    'changed', count(*),
    'upgraded', count(*) filter (where coalesce((select discount_percentage from user_tiers where id = c.new_tier), 0)
                                      > coalesce((select discount_percentage from user_tiers where id = c.old_tier), 0)),
    'downgraded', count(*) filter (where coalesce((select discount_percentage from user_tiers where id = c.new_tier), 0)
                                        < coalesce((select discount_percentage from user_tiers where id = c.old_tier), 0)))
    into v_result from changed c;
  return v_result;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('recalculate-user-tiers', '7 * * * *', 'select public.recalculate_user_tiers()');
    exception when others then
      raise warning 'recalculate-user-tiers was not scheduled: %', sqlerrm;
    end;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Promo codes: the admin write path (audited)
-- -----------------------------------------------------------------------------
create function public.admin_upsert_promo_code(
  p_actor          uuid,
  p_code           text,
  p_discount_type  public.promo_discount_type,
  p_discount_value numeric,
  p_max_uses       integer default null,
  p_expires_at     timestamptz default null,
  p_is_active      boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_row  promo_codes%rowtype;
begin
  perform assert_catalog_admin(p_actor);
  if v_code !~ '^[A-Z0-9_-]{3,32}$' then
    raise exception 'invalid_parameter_value: the code must be 3 to 32 letters, digits, "-" or "_"' using errcode = 'invalid_parameter_value';
  end if;
  if p_discount_value is null or p_discount_value <= 0 or (p_discount_type = 'percentage' and p_discount_value > 90) then
    raise exception 'invalid_parameter_value: a percentage must be in (0, 90], a fixed amount greater than zero' using errcode = 'invalid_parameter_value';
  end if;
  if p_max_uses is not null and p_max_uses <= 0 then
    raise exception 'invalid_parameter_value: max uses must be positive' using errcode = 'invalid_parameter_value';
  end if;

  insert into promo_codes (code, discount_type, discount_value, max_uses, expires_at, is_active, created_by)
  values (v_code, p_discount_type, round(p_discount_value, 4), p_max_uses, p_expires_at, coalesce(p_is_active, true), p_actor)
  on conflict (code) do update
     set discount_type = excluded.discount_type, discount_value = excluded.discount_value, max_uses = excluded.max_uses,
         expires_at = excluded.expires_at, is_active = excluded.is_active
  returning * into v_row;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'upsert_promo_code', v_row.id::text, jsonb_build_object('code', v_row.code, 'type', v_row.discount_type,
          'value', v_row.discount_value, 'max_uses', v_row.max_uses, 'expires_at', v_row.expires_at, 'is_active', v_row.is_active));
  return jsonb_build_object('id', v_row.id, 'code', v_row.code, 'discount_type', v_row.discount_type, 'discount_value', v_row.discount_value,
                            'max_uses', v_row.max_uses, 'current_uses', v_row.current_uses, 'expires_at', v_row.expires_at, 'is_active', v_row.is_active);
exception when check_violation then
  raise exception 'invalid_parameter_value: %', sqlerrm using errcode = 'invalid_parameter_value';
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. The admin grid shows how much discount each service can carry
-- -----------------------------------------------------------------------------
create or replace function public.get_admin_pricing_view()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_margin numeric(14,4);
begin
  perform require_admin();
  select discount_min_margin_per_1000 into v_margin from platform_settings where id = 1;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'service_id', s.id,
      'name', s.name,
      'category_id', c.id,
      'category', c.name,
      'platform', pl.slug,
      'customer_rate_per_1000', s.customer_rate_per_1000,
      'best_offer_cost', b.cost_per_1000,
      'best_offer_effective_cost', b.effective_cost,
      'base_offer_cost', base.cost_per_1000,
      'margin_absolute', case when b.cost_per_1000 is null then null
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end,
      -- the most any combination of tier and promo discount can take off the list price before cost + minimum margin
      'max_discount_percent', case when base.cost_per_1000 is null or s.customer_rate_per_1000 <= 0 then null
                                   else round(greatest(s.customer_rate_per_1000 - base.cost_per_1000 - v_margin, 0) / s.customer_rate_per_1000 * 100, 2) end
    ) order by pl.sort_order, pl.slug, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    join platforms pl on pl.id = c.platform_id
    left join lateral (
      select o.cost_per_1000,
             round(o.cost_per_1000 * p.reliability_penalty_multiplier * (1 - least(greatest(o.routing_score, 0), 1000) * 0.0001), 4) as effective_cost
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active
         and ps.is_active
         and p.is_active and p.routing_enabled and p.health_status = 'healthy'
       order by o.cost_per_1000 * p.reliability_penalty_multiplier * (1 - least(greatest(o.routing_score, 0), 1000) * 0.0001) asc,
                o.routing_score desc, o.id asc
       limit 1
    ) b on true
    left join lateral (
      select min(o.cost_per_1000) as cost_per_1000
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active and ps.is_active and p.is_active and p.routing_enabled
    ) base on true
    where s.is_active), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Access
-- -----------------------------------------------------------------------------
revoke all on function public.users_default_tier() from public, anon, authenticated;
revoke all on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.calculate_order_price(uuid, uuid, integer, numeric, text) from public, anon, authenticated;
revoke all on function public.quote_order_price(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.recalculate_user_tiers() from public, anon, authenticated;
revoke all on function public.admin_upsert_promo_code(uuid, text, public.promo_discount_type, numeric, integer, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text) to service_role;
grant execute on function public.quote_order_price(uuid, uuid, integer, text) to service_role;
grant execute on function public.recalculate_user_tiers() to service_role;
grant execute on function public.admin_upsert_promo_code(uuid, text, public.promo_discount_type, numeric, integer, timestamptz, boolean) to service_role;
