-- =============================================================================
-- Orders that wait for the provider to be funded
--
-- A new shop has no money at its providers yet. With the switch on (platform_settings.deferred_orders_enabled), an order that every provider
-- turns down only for lack of balance is still accepted: the customer pays from their wallet as usual, the order stays `paid` and carries
-- awaiting_funds_since. Nothing is reserved at the provider and nothing is sent. When the owner tops the provider up, claim_funded_orders()
-- hands the waiting orders out oldest first (reserving each cost, paid -> processing, exactly like the normal claim) and the worker sends them.
-- An order that is still waiting after deferred_orders_ttl_hours is refunded in full (expire_unfunded_orders).
--
--   * the customer money waiting is capped: deferred_orders_cap (USD of customer charges)
--   * among the WAITING orders of a provider the order is first come, first served: a small waiting order never jumps ahead of an older one
--     (an order the provider can pay for right now simply is not deferred: it is reserved and sent as usual)
--   * an order whose provider price has since risen above what the customer paid is NOT sent (it would sell at a loss): it waits and expires
--   * everything here is service role only; the customer sees only their own awaiting_funds_since (column grant) to show "waiting to be connected"
-- =============================================================================

alter table public.platform_settings
  add column deferred_orders_enabled   boolean       not null default false,
  add column deferred_orders_cap       numeric(14,4) not null default 200 check (deferred_orders_cap >= 0),
  add column deferred_orders_ttl_hours integer       not null default 24 check (deferred_orders_ttl_hours between 1 and 168);

alter table public.orders add column awaiting_funds_since timestamptz;
create index idx_orders_awaiting_funds on public.orders (awaiting_funds_since, id) where awaiting_funds_since is not null;
grant select (awaiting_funds_since) on table public.orders to authenticated;

-- -----------------------------------------------------------------------------
-- place_order: p_allow_unfunded
-- -----------------------------------------------------------------------------
drop function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text);

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
  p_allow_unfunded      boolean default false
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
                      awaiting_funds_since)
  values (p_user_id, p_service_id, p_target_url, p_quantity, v_charge, v_cost, v_charge - v_cost,
          v_offer.provider_id, v_offer.id, v_offer.routing_score, p_idempotency_key, v_reserved,
          (v_price->>'list_price')::numeric, (v_price->>'tier_discount')::numeric, (v_price->>'promo_discount')::numeric,
          v_promo_id, (v_price->>'capped')::boolean,
          case when v_unfunded then now() end)
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

revoke all on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean) from public, anon, authenticated;
grant execute on function public.place_order(uuid, uuid, text, integer, uuid, uuid, uuid, numeric, text, text, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- claim_funded_orders: hand out the waiting orders the provider can now pay for
-- -----------------------------------------------------------------------------
-- Oldest first. For each order: the provider must be active, routing on, healthy and not in maintenance; its cached balance must cover the
-- order's cost (reserved here, one atomic UPDATE, like place_order); the offer must still exist and must not have become dearer than what the
-- customer paid. An order that does not fit stops the line for ITS provider in this call (first come, first served). The claim is the same
-- transition the Edge Function makes for a fresh order (paid -> processing with the in-flight note), so a crash afterwards is found by the
-- usual reconciliation. p_provider_ids limits the claim to providers the caller can actually send to. Returns what the worker needs to send them.
create function public.claim_funded_orders(p_limit integer default 20, p_provider_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r          record;
  v_out      jsonb := '[]'::jsonb;
  v_blocked  uuid[] := '{}';
  v_cost_now numeric(14,4);
  v_ext      text;
begin
  if coalesce((select maintenance_mode from platform_settings where id = 1), false) then
    return v_out;
  end if;

  for r in
    select o.id, o.user_id, o.provider_id, o.provider_offer_id, o.target_url, o.quantity, o.cost_amount, o.charge_amount
      from orders o
     where o.awaiting_funds_since is not null and o.status = 'paid'
       and (p_provider_ids is null or o.provider_id = any (p_provider_ids))
     order by o.awaiting_funds_since, o.id
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
       for update of o skip locked
  loop
    continue when r.provider_id = any (v_blocked);

    select o2.cost_per_1000 * r.quantity / 1000, ps.external_service_id
      into v_cost_now, v_ext
      from provider_service_offers o2
      join provider_services ps on ps.id = o2.provider_service_id
      join providers p on p.id = o2.provider_id
     where o2.id = r.provider_offer_id and o2.is_active and ps.is_active
       and p.is_active and p.routing_enabled and p.health_status = 'healthy';
    if not found then
      v_blocked := v_blocked || r.provider_id;   -- offer gone or provider not usable right now: nobody behind this order jumps ahead
      continue;
    end if;
    if round(v_cost_now, 4) > r.charge_amount then
      continue;   -- the provider's price rose above what the customer paid: sending it would sell at a loss; it waits (and is refunded at the limit)
    end if;

    update providers set provider_balance = provider_balance - r.cost_amount
     where id = r.provider_id and last_balance_sync is not null and provider_balance >= r.cost_amount;
    if not found then
      v_blocked := v_blocked || r.provider_id;
      continue;
    end if;

    update orders
       set status = 'processing', awaiting_funds_since = null, provider_reservation = r.cost_amount,
           error_message = 'needs_reconciliation: submission in flight'
     where id = r.id;

    v_out := v_out || jsonb_build_object(
      'id', r.id, 'user_id', r.user_id, 'provider_id', r.provider_id, 'target_url', r.target_url, 'quantity', r.quantity,
      'charge_amount', r.charge_amount, 'external_service_id', v_ext);
  end loop;
  return v_out;
end;
$$;

-- -----------------------------------------------------------------------------
-- expire_unfunded_orders: whatever has waited longer than the limit is refunded in full
-- -----------------------------------------------------------------------------
-- The order is canceled (the existing outcome trigger queues the customer's Telegram message) and refund_order credits the wallet once and moves it
-- to `refunded`, both in one sub-transaction: either the customer is told and refunded, or nothing changed and the next run tries again. One
-- order failing never stops the others.
create function public.expire_unfunded_orders()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r         record;
  v_ttl     integer := coalesce((select deferred_orders_ttl_hours from platform_settings where id = 1), 24);
  v_done    integer := 0;
  v_failed  integer := 0;
begin
  for r in
    select id from orders
     where awaiting_funds_since is not null and status = 'paid'
       and awaiting_funds_since < now() - make_interval(hours => v_ttl)
     order by awaiting_funds_since, id
     limit 100
       for update skip locked
  loop
    begin
      -- canceled first: that is the outcome the customer is told about (the trigger on status); then the money goes back. All or nothing per order.
      update orders set status = 'canceled', awaiting_funds_since = null, error_message = 'Provider was not funded in time' where id = r.id;
      perform refund_order(r.id, null, 'Provider was not funded in time');
      v_done := v_done + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'expire_unfunded_orders: order % not refunded: %', r.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('refunded', v_done, 'failed', v_failed);
end;
$$;

-- -----------------------------------------------------------------------------
-- unfunded_orders_summary: for the admin screen (read through the admin Edge function) and the digest below
-- -----------------------------------------------------------------------------
create function public.unfunded_orders_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'count',  coalesce(sum(t.n), 0),
    'charge', coalesce(sum(t.charge), 0),
    'cost',   coalesce(sum(t.cost), 0),
    'oldest', min(t.oldest),
    'providers', coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'count', t.n, 'cost', t.cost, 'balance', t.balance, 'oldest', t.oldest) order by t.oldest), '[]'::jsonb))
  from (
    select p.id, p.name, p.provider_balance as balance, count(*) as n, sum(o.charge_amount) as charge, sum(o.cost_amount) as cost, min(o.awaiting_funds_since) as oldest
      from orders o join providers p on p.id = o.provider_id
     where o.awaiting_funds_since is not null and o.status = 'paid'
     group by p.id, p.name, p.provider_balance
  ) t;
$$;

-- -----------------------------------------------------------------------------
-- The owner is told: one digest per admin, again whenever the number of waiting orders changes (and every six hours otherwise)
-- -----------------------------------------------------------------------------
create or replace function public.notify_admin_anomalies()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run     text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_cases   integer := 0;
  v_dead    integer := 0;
  v_oldest  interval;
  v_digest  text;
  v_alerts  integer := 0;
  v_wait    jsonb;
  v_wait_n  integer;
begin
  -- a) cases: record the (case, step) pairs that are new
  with stale as (
    select c.id, c.reason, c.created_at, now() - c.created_at as age,
           case when c.created_at < now() - interval '24 hours' then '24h'
                when c.created_at < now() - interval '2 hours' then '2h' else '15m' end as step
      from reconciliation_cases c
     where c.status = 'open' and c.created_at < now() - interval '15 minutes'
  ), fresh as (
    insert into reconciliation_case_alerts (case_id, step)
    select s.id, s.step from stale s
    on conflict do nothing
    returning case_id, step
  )
  select count(*), max(s.age),
         string_agg(distinct left(regexp_replace(s.reason, '\s+', ' ', 'g'), 80), ' | ')
    into v_cases, v_oldest, v_digest
    from fresh f join stale s on s.id = f.case_id;

  if v_cases > 0 then
    insert into notification_outbox (user_id, kind, dedupe_key, payload)
    select a.id, 'admin_alert', 'alert:cases:' || v_run || ':' || a.id,
           jsonb_build_object('headline', v_cases || ' reconciliation case(s) need attention',
                              'detail', 'Waiting for a decision, the oldest for ' || (extract(epoch from v_oldest)::int / 60) || ' min. Open Admin → Reconciliation. Reasons: ' || coalesce(v_digest, '-'))
      from users a where a.is_admin and not a.is_banned
    on conflict (dedupe_key) do nothing;
    get diagnostics v_alerts = row_count;
  end if;

  -- b) dead notifications (customers' messages that could not be delivered)
  with died as (
    update notification_outbox set alerted_at = now()
     where status = 'dead' and alerted_at is null and kind <> 'admin_alert'
    returning id
  )
  select count(*) into v_dead from died;

  if v_dead > 0 then
    insert into notification_outbox (user_id, kind, dedupe_key, payload)
    select a.id, 'admin_alert', 'alert:dead:' || v_run || ':' || a.id,
           jsonb_build_object('headline', v_dead || ' notification(s) could not be delivered',
                              'detail', 'They failed all their retries and were given up on. See notification_outbox where status = ''dead''.')
      from users a where a.is_admin and not a.is_banned
    on conflict (dedupe_key) do nothing;
  end if;

  -- c) orders that are paid and waiting for a provider to be funded: what to transfer, where
  v_wait := unfunded_orders_summary();
  v_wait_n := (v_wait->>'count')::integer;
  if v_wait_n > 0 then
    insert into notification_outbox (user_id, kind, dedupe_key, payload)
    select a.id, 'admin_alert',
           'alert:unfunded:' || to_char(date_trunc('day', now()) + (extract(hour from now())::int / 6) * interval '6 hours', 'YYYYMMDDHH24') || ':' || v_wait_n || ':' || a.id,
           jsonb_build_object(
             'headline', v_wait_n || ' paid order(s) wait for a provider top-up',
             'detail', 'Transfer about $' || to_char((v_wait->>'cost')::numeric, 'FM999999990.00') || ' to: ' ||
                       (select string_agg((p->>'name') || ' $' || to_char((p->>'cost')::numeric, 'FM999999990.00') || ' (' || (p->>'count') || ')', ', ')
                          from jsonb_array_elements(v_wait->'providers') p) ||
                       '. They start by themselves within a minute of the top-up; otherwise they are refunded after the time limit.')
      from users a where a.is_admin and not a.is_banned
    on conflict (dedupe_key) do nothing;
  end if;

  return jsonb_build_object('cases_announced', v_cases, 'dead_announced', v_dead);
end;
$$;

revoke all on function public.claim_funded_orders(integer, uuid[]) from public, anon, authenticated;
revoke all on function public.expire_unfunded_orders() from public, anon, authenticated;
revoke all on function public.unfunded_orders_summary() from public, anon, authenticated;
revoke all on function public.notify_admin_anomalies() from public, anon, authenticated;
grant execute on function public.claim_funded_orders(integer, uuid[]) to service_role;
grant execute on function public.expire_unfunded_orders() to service_role;
grant execute on function public.unfunded_orders_summary() to service_role;
grant execute on function public.notify_admin_anomalies() to service_role;
