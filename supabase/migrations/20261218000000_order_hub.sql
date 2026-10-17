-- =============================================================================
-- The order hub: orders wait for the provider to be funded, the owner is told on Telegram
--
-- The owner keeps no large balances at the providers. A customer tops up and orders; the order goes to the CHEAPEST offer (the best margin)
-- even when that provider has no money yet: the customer is charged, the order waits in the hub (paid + awaiting_funds_since, the deferred
-- funding of 20261115000000) and the admins get a Telegram message saying which provider to top up and by how much. The health monitor reads
-- the balances every minute; the order worker sends the waiting orders of a provider oldest first as soon as its balance covers them
-- (claim_funded_orders), and the admins are told each time an order goes out.
--
--   1. the hub is on (platform_settings.deferred_orders_enabled)
--   2. every card is on sale again: an order a provider cannot pay for yet waits instead of failing, so hiding the donors' cards
--      (20261217000000) is undone
--   3. a panel that answers "not enough funds" after all: return_order_to_hub() puts the order back in the hub (no refund)
--   4. hub_reroute_order(): an admin may send a waiting order through another provider of the card that can pay for it now
--   5. Telegram messages for the admins (outbox kind admin_hub): a top-up of a customer, an order entering the hub (with buttons), an order
--      sent to its provider (also from the hub)
-- =============================================================================

-- 1. ---------------------------------------------------------------------------------------------------------------------------------------
update public.platform_settings set deferred_orders_enabled = true where id = 1 and not deferred_orders_enabled;

-- 2. every card on sale again ------------------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('cron.job') is not null and exists (select 1 from cron.job where jobname = 'refresh-service-funding') then
    perform cron.unschedule('refresh-service-funding');
  end if;
exception when others then
  raise warning 'refresh-service-funding job not removed: %', sqlerrm;
end;
$$;
drop trigger if exists trg_providers_funding on public.providers;
drop function if exists public.trg_providers_funding();
drop function if exists public.refresh_service_funding();

drop policy if exists services_select_active on public.services;
create policy services_select_active on public.services
  for select to anon, authenticated
  using (is_active);

create or replace function public.recount_categories(p_ids uuid[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.categories c
     set active_service_count = n.cnt
    from (select u.id, (select count(*) from public.services s where s.category_id = u.id and s.is_active)::integer as cnt
            from unnest(p_ids) as u(id)) n
   where c.id = n.id and c.active_service_count is distinct from n.cnt
$$;

create or replace function public.regroup_service_variants()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grouped integer;
  v_cleared integer;
  v_groups  integer;
begin
  create temp table _variants on commit drop as
    with base as (
      select id, category_id, name, customer_rate_per_1000 rate, sort_order, service_group_key(name) k
        from services where is_active
    ), counted as (
      -- services with the very same name differ in something the name does not say (a niche in the description): never grouped
      select category_id, k, count(*) n, count(distinct name) names from base group by category_id, k
    ), sized as (
      select b.*, c.n from base b join counted c using (category_id, k) where c.n = c.names
    )
    select id, category_id, k,
           row_number() over (partition by category_id, k order by rate, sort_order, id)::smallint rk,
           first_value(id) over (partition by category_id, k order by rate, sort_order, id) main
      from sized where n between 2 and 10 and k <> '';

  update services s set parent_service_id = null, variant_rank = null
   where (s.parent_service_id is not null or s.variant_rank is not null)
     and not exists (select 1 from _variants v where v.id = s.id);
  get diagnostics v_cleared = row_count;

  update services s
     set parent_service_id = case when v.rk = 1 then null else v.main end, variant_rank = v.rk
    from _variants v
   where v.id = s.id
     and (s.parent_service_id is distinct from case when v.rk = 1 then null else v.main end or s.variant_rank is distinct from v.rk);
  get diagnostics v_grouped = row_count;

  select count(distinct (category_id, k)) into v_groups from _variants;
  return jsonb_build_object('groups', v_groups, 'services_in_groups', (select count(*) from _variants), 'rows_changed', v_grouped, 'rows_cleared', v_cleared);
end;
$$;


alter table public.services drop column if exists on_sale;
drop function if exists public.min_provider_balance();

select public.regroup_service_variants();
select public.recount_categories(coalesce((select array_agg(id) from public.categories), '{}'));

-- 3. / 4. the two hub moves the order guard allows (only inside the functions below, through a transaction-local flag) ------------------
alter table public.orders add column if not exists hub_entered_at timestamptz;
comment on column public.orders.hub_entered_at is 'When the order first entered the order hub (waited for its provider to be funded); kept after it is sent.';

create or replace function public.guard_order_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_hub text := coalesce(current_setting('app.order_hub', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'orders must be created in draft status (got %)', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     and not public.is_valid_order_transition(old.status, new.status)
     -- return_order_to_hub(): a claimed order the panel refused for lack of our money goes back to waiting (nothing was sent)
     and not (v_hub = 'return' and old.status = 'processing' and new.status = 'paid' and new.provider_order_id is null) then
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
          -- hub_reroute_order(): a waiting order may move to another offer of the card (the customer's price never changes)
          or (new.provider_offer_id is distinct from old.provider_offer_id and not (v_hub = 'reroute' and old.status = 'paid' and old.awaiting_funds_since is not null))
          or new.routing_score_snapshot <> old.routing_score_snapshot
          or (new.profit_amount <> old.profit_amount and not (v_hub = 'reroute' and old.status = 'paid' and old.awaiting_funds_since is not null))
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

create or replace function public.return_order_to_hub(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o orders%rowtype;
begin
  if not coalesce((select deferred_orders_enabled from platform_settings where id = 1), false) then
    return null;   -- no hub: the caller refunds as before
  end if;
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if o.status <> 'processing' or o.provider_order_id is not null then
    raise exception 'order % cannot go back to the hub (%)', o.id, o.status using errcode = 'check_violation';
  end if;
  -- the panel said it has not enough of our money: what we reserved is not there; the health monitor re-reads the real balance within a minute
  update providers set provider_balance = 0 where id = o.provider_id;
  perform set_config('app.order_hub', 'return', true);
  update orders
     set status = 'paid', awaiting_funds_since = now(), provider_reservation = 0, error_message = null
   where id = o.id
  returning * into o;
  perform set_config('app.order_hub', '', true);
  return to_jsonb(o);
end;
$$;

create or replace function public.hub_reroute_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o     orders%rowtype;
  r     record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found or o.status <> 'paid' or o.awaiting_funds_since is null then
    return jsonb_build_object('ok', false, 'reason', 'not_waiting');
  end if;
  -- another provider of the card that can pay for it now, the cheapest; never one that would sell at a loss
  select x.id offer_id, x.provider_id, p.name, round(x.cost_per_1000 * o.quantity / 1000, 4) cost, p.provider_balance balance
    into r
    from provider_service_offers x
    join provider_services ps on ps.id = x.provider_service_id and ps.is_active
    join providers p on p.id = x.provider_id and p.is_active and p.routing_enabled and p.health_status = 'healthy'
   where x.service_id = o.service_id and x.is_active and x.provider_id <> o.provider_id
     and o.quantity / greatest(coalesce(o.runs, 1), 1) between x.min_quantity and x.max_quantity
     and round(x.cost_per_1000 * o.quantity / 1000, 4) <= o.charge_amount
     and p.last_balance_sync is not null and p.provider_balance >= round(x.cost_per_1000 * o.quantity / 1000, 4)
   order by x.cost_per_1000, x.id
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_funded_provider');
  end if;
  perform set_config('app.order_hub', 'reroute', true);
  update orders
     set provider_offer_id = r.offer_id, provider_id = r.provider_id, cost_amount = r.cost, profit_amount = charge_amount - r.cost
   where id = o.id;
  perform set_config('app.order_hub', '', true);
  return jsonb_build_object('ok', true, 'provider_id', r.provider_id, 'provider', r.name, 'cost', r.cost, 'balance', r.balance);
end;
$$;

revoke all on function public.return_order_to_hub(uuid, text), public.hub_reroute_order(uuid) from public, anon, authenticated;
grant execute on function public.return_order_to_hub(uuid, text), public.hub_reroute_order(uuid) to service_role;

-- 5. the admins' Telegram messages -------------------------------------------------------------------------------------------------------
alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox drop constraint if exists notification_outbox_shape;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check check (kind in ('completed', 'partial', 'canceled', 'admin_alert', 'admin_hub')),
  add constraint notification_outbox_shape check (
    (kind in ('admin_alert', 'admin_hub') and payload is not null and order_id is null)
    or (kind not in ('admin_alert', 'admin_hub') and payload is null and order_id is not null));

-- One message per admin who can be reached on Telegram; the key makes a repeat of the same event a no-op.
create or replace function public.queue_hub_message(p_key text, p_payload jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  insert into notification_outbox (user_id, kind, dedupe_key, payload)
  select a.id, 'admin_hub', 'hub:' || p_key || ':' || a.id, p_payload
    from users a
   where a.is_admin and not a.is_banned and a.telegram_id is not null
  on conflict (dedupe_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.queue_hub_message(text, jsonb) from public, anon, authenticated;

-- What a provider's hub needs: the cost of all its waiting orders
create or replace function public.hub_provider_needed(p_provider_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('count', count(*), 'needed', coalesce(sum(cost_amount), 0))
    from orders where provider_id = p_provider_id and status = 'paid' and awaiting_funds_since is not null;
$$;
revoke all on function public.hub_provider_needed(uuid) from public, anon, authenticated;
grant execute on function public.hub_provider_needed(uuid) to service_role;

create or replace function public.trg_orders_hub_entered()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.awaiting_funds_since is not null and new.hub_entered_at is null then
    new.hub_entered_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists trg_orders_hub_entered on public.orders;
create trigger trg_orders_hub_entered before insert or update of awaiting_funds_since on public.orders
  for each row execute function public.trg_orders_hub_entered();

create or replace function public.trg_orders_hub_messages()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider providers%rowtype;
  v_service  text;
  v_need     jsonb;
begin
  begin
    -- an order entering the hub: paid while waiting (place_order marks it waiting already as a draft), or back after a "not enough funds"
    if new.awaiting_funds_since is not null and new.status = 'paid'
       and (tg_op = 'INSERT' or old.awaiting_funds_since is null or old.status is distinct from 'paid') then
      select * into v_provider from providers where id = new.provider_id;
      select name into v_service from services where id = new.service_id;
      v_need := hub_provider_needed(new.provider_id);
      perform queue_hub_message('waiting:' || new.id || ':' || floor(extract(epoch from new.awaiting_funds_since))::bigint, jsonb_build_object(
        'event', 'waiting', 'order_id', new.id, 'provider_id', new.provider_id, 'provider', coalesce(v_provider.name, '?'),
        'service', coalesce(v_service, '?'), 'quantity', new.quantity, 'charge', new.charge_amount, 'cost', new.cost_amount,
        'balance', v_provider.provider_balance, 'needed', v_need -> 'needed', 'waiting', v_need -> 'count'));
    end if;
    -- an order sent to its provider (straight away or from the hub)
    if tg_op = 'UPDATE' and new.status = 'submitted' and old.status is distinct from 'submitted' then
      select * into v_provider from providers where id = new.provider_id;
      select name into v_service from services where id = new.service_id;
      perform queue_hub_message('sent:' || new.id, jsonb_build_object(
        'event', 'sent', 'order_id', new.id, 'provider', coalesce(v_provider.name, '?'), 'service', coalesce(v_service, '?'),
        'quantity', new.quantity, 'charge', new.charge_amount, 'cost', new.cost_amount, 'balance', v_provider.provider_balance,
        'from_hub', new.hub_entered_at is not null));
    end if;
  exception when others then
    raise warning 'order hub message skipped: %', sqlerrm;   -- a message never blocks an order
  end;
  return null;
end;
$$;
drop trigger if exists trg_orders_hub_messages on public.orders;
create trigger trg_orders_hub_messages after insert or update of status, awaiting_funds_since on public.orders
  for each row execute function public.trg_orders_hub_messages();

create or replace function public.trg_deposits_hub_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u users%rowtype;
begin
  begin
    if new.status = 'completed' and old.status is distinct from 'completed' then
      select * into u from users where id = new.user_id;
      perform queue_hub_message('deposit:' || new.id, jsonb_build_object(
        'event', 'deposit', 'amount', new.amount_usd, 'user_id', new.user_id, 'username', u.username, 'telegram_id', u.telegram_id));
    end if;
  exception when others then
    raise warning 'deposit message skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists trg_deposits_hub_message on public.deposits;
create trigger trg_deposits_hub_message after update of status on public.deposits
  for each row execute function public.trg_deposits_hub_message();

revoke all on function public.trg_orders_hub_entered(), public.trg_orders_hub_messages(), public.trg_deposits_hub_message() from public, anon, authenticated;
