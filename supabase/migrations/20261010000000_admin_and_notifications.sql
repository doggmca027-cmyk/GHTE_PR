-- =============================================================================
-- Admin dashboard + Telegram notifications
--
-- Security model: the DATABASE is the only gate. Every admin operation is a SECURITY DEFINER
-- function that calls require_admin(), which looks up auth.uid() in `users` on EVERY call
-- (is_admin and not banned). Nothing is taken from JWT claims or request bodies, and clients
-- have no table privileges to read or change the admin flag, price rules, or the audit log.
-- =============================================================================

alter table public.users
  add column is_admin boolean not null default false,
  add column notifications_enabled boolean not null default true;

alter table public.providers
  add column balance_updated_at timestamptz;

-- -----------------------------------------------------------------------------
-- Audit log (append-only) + notification dedupe log. Service-role / definer functions only.
-- -----------------------------------------------------------------------------
create table public.admin_audit_log (
  id         uuid primary key default gen_random_uuid(),
  admin_id   uuid references public.users(id) on delete restrict,   -- null = changed outside the app (SQL console)
  action     text not null,
  target_id  text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index idx_audit_created on public.admin_audit_log (created_at desc);
create trigger trg_audit_no_update before update on public.admin_audit_log
  for each row execute function public.forbid_mutation();
create trigger trg_audit_no_delete before delete on public.admin_audit_log
  for each row execute function public.forbid_mutation();
create trigger trg_audit_no_truncate before truncate on public.admin_audit_log
  for each statement execute function public.forbid_mutation();

-- One row per notification we decided to send; the unique key makes every event fire at most once,
-- however many times a deposit is re-verified or an order re-synced.
create table public.notification_log (
  dedupe_key text primary key,
  user_id    uuid not null references public.users(id) on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now()
);
create index idx_notification_user on public.notification_log (user_id, created_at desc);

alter table public.admin_audit_log enable row level security;
alter table public.notification_log enable row level security;
revoke all on table public.admin_audit_log, public.notification_log from anon, authenticated;

-- Granting or revoking admin outside the app leaves a trace.
create function public.audit_admin_flag_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_admin is distinct from old.is_admin then
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (null, case when new.is_admin then 'grant_admin' else 'revoke_admin' end, new.id::text,
            jsonb_build_object('telegram_id', new.telegram_id));
  end if;
  return new;
end;
$$;
create trigger trg_users_admin_audit after update of is_admin on public.users
  for each row execute function public.audit_admin_flag_change();

-- -----------------------------------------------------------------------------
-- The gate
-- -----------------------------------------------------------------------------
create function public.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null
     or not exists (select 1 from users where id = v_uid and is_admin and not is_banned) then
    raise exception 'forbidden: admin access required' using errcode = 'insufficient_privilege';
  end if;
  return v_uid;
end;
$$;

-- Orders in `processing` younger than this are probably still being submitted to the provider.
-- place-order stamps every in-flight order with a needs_reconciliation note, so for `processing`
-- orders ONLY age decides: young ones are neither problems nor refundable (a refund could race the
-- provider call). `needs_*` notes on other statuses (failed / canceled: refund still owed) always count.
create function public.admin_inflight_grace()
returns interval
language sql
immutable
as $$ select interval '10 minutes' $$;

-- -----------------------------------------------------------------------------
-- Metrics
--   revenue  = completed: charge | partial: charge - partial refund | everything else: 0
--              (refunded and canceled orders earn nothing; active orders are "pending revenue")
--   cost     = provider cost of what was actually delivered: completed: cost_amount,
--              partial: cost_amount prorated by delivered share (quantity - remains) / quantity
--   profit   = revenue - cost       margin = profit / revenue
-- -----------------------------------------------------------------------------
create function public.get_admin_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_revenue numeric(14,4);
  v_cost    numeric(14,4);
  v_pending numeric(14,4);
  v_result  jsonb;
begin
  perform require_admin();

  select
    coalesce(sum(case status when 'completed' then charge_amount
                             when 'partial'   then charge_amount - partial_refund_amount end), 0),
    coalesce(sum(case status when 'completed' then cost_amount
                             when 'partial'   then round(cost_amount * (quantity - coalesce(remains, 0)) / quantity, 4) end), 0),
    coalesce(sum(case when status in ('awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress') then charge_amount end), 0)
  into v_revenue, v_cost, v_pending
  from orders;

  select jsonb_build_object(
    'gross_revenue',      v_revenue,
    'estimated_cost',     v_cost,
    'gross_profit',       v_revenue - v_cost,
    'margin_pct',         case when v_revenue > 0 then round((v_revenue - v_cost) / v_revenue * 100, 2) end,
    'pending_revenue',    v_pending,
    'total_orders',       (select count(*) from orders where status <> 'draft'),
    'active_orders',      (select count(*) from orders where status in ('awaiting_payment', 'paid', 'processing', 'submitted', 'in_progress')),
    'problematic_orders', (select count(*) from orders
                            where (status = 'processing' and created_at < now() - admin_inflight_grace())
                               or (status <> 'processing' and error_message like 'needs\_%')),
    'total_users',        (select count(*) from users),
    'user_balances',      (select coalesce(sum(balance), 0) from wallets),
    'deposits_total',     (select coalesce(sum(amount_usd), 0) from deposits where status = 'completed')
  ) into v_result;
  return v_result;
end;
$$;

create function public.admin_provider_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'is_active', p.is_active, 'balance', p.balance,
      'balance_updated_at', p.balance_updated_at,
      'last_synced_at', (select max(last_synced_at) from provider_services where provider_id = p.id),
      'active_services', (select count(*) from provider_services where provider_id = p.id and is_active)
    ) order by p.priority desc, p.name)
    from providers p), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- Reconciliation queue and actions
-- -----------------------------------------------------------------------------
create function public.admin_reconciliation_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'status', o.status, 'charge_amount', o.charge_amount, 'quantity', o.quantity,
      'target_url', o.target_url, 'provider_order_id', o.provider_order_id, 'error_message', o.error_message,
      'created_at', o.created_at, 'service_name', s.name, 'username', u.username, 'telegram_id', u.telegram_id
    ) order by o.created_at)
    from orders o
    join users u on u.id = o.user_id
    left join services s on s.id = o.service_id
    where o.status not in ('refunded', 'completed', 'partial', 'draft')
      and ((o.status = 'processing' and o.created_at < now() - admin_inflight_grace())
           or (o.status <> 'processing' and o.error_message like 'needs\_%'))), '[]'::jsonb);
end;
$$;

-- Refunds an order stuck in the reconciliation queue. Idempotent (refund_order is).
create function public.admin_force_refund(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  o       orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if o.status = 'refunded' then
    return jsonb_build_object('id', o.id, 'status', o.status);
  end if;

  if not ((o.status = 'processing' and o.created_at < now() - admin_inflight_grace())
          or (o.status in ('failed', 'canceled') and o.error_message like 'needs\_%')) then
    raise exception 'order % (%) is not in the reconciliation queue', o.id, o.status using errcode = 'check_violation';
  end if;

  if o.status = 'processing' then
    update orders set status = 'failed', error_message = 'needs_refund: admin force refund' where id = o.id;
  end if;

  perform refund_order(o.id, null, 'Admin force refund' || coalesce(': ' || nullif(trim(p_reason), ''), ''));
  update orders set error_message = null where id = o.id returning * into o;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'force_refund', o.id::text, jsonb_build_object('reason', p_reason, 'charge_amount', o.charge_amount));
  return jsonb_build_object('id', o.id, 'status', o.status);
end;
$$;

-- Clears the flag on an order the admin has checked with the provider.
--   processing  : the provider id is REQUIRED (otherwise nothing could ever sync the order again);
--                 the order moves to `submitted` and the sync worker takes over.
--   failed/canceled with needs_refund: the admin handled the money elsewhere; a note is required.
create function public.admin_mark_resolved(
  p_order_id          uuid,
  p_provider_order_id text default null,
  p_note              text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  o       orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if o.status = 'processing' and o.created_at < now() - admin_inflight_grace() then
    if p_provider_order_id is null or length(trim(p_provider_order_id)) = 0 then
      raise exception 'the provider order id is required to resolve a processing order' using errcode = 'invalid_parameter_value';
    end if;
    perform set_config('app.status_comment', 'Resolved by admin' || coalesce(': ' || nullif(trim(p_note), ''), ''), true);
    update orders
       set provider_order_id = trim(p_provider_order_id), status = 'submitted', error_message = null
     where id = o.id returning * into o;
  elsif o.status in ('failed', 'canceled') and o.error_message like 'needs\_%' then
    if p_note is null or length(trim(p_note)) = 0 then
      raise exception 'a note is required to resolve this order without a refund' using errcode = 'invalid_parameter_value';
    end if;
    update orders set error_message = null where id = o.id returning * into o;
  else
    raise exception 'order % (%) is not in the reconciliation queue', o.id, o.status using errcode = 'check_violation';
  end if;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'mark_resolved', o.id::text, jsonb_build_object('provider_order_id', o.provider_order_id, 'note', p_note));
  return jsonb_build_object('id', o.id, 'status', o.status);
end;
$$;

-- -----------------------------------------------------------------------------
-- Price rules
-- -----------------------------------------------------------------------------
create function public.admin_list_price_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name, 'type', r.type, 'value', r.value, 'is_active', r.is_active, 'priority', r.priority,
      'platform', r.platform, 'min_rate', r.min_rate, 'max_rate', r.max_rate,
      'scope', case when r.service_id is not null then 'Service: ' || coalesce((select name from services where id = r.service_id), '?')
                    when r.category_id is not null then 'Category: ' || coalesce((select name from categories where id = r.category_id), '?')
                    when r.platform is not null then 'Platform: ' || r.platform::text
                    else 'Global' end
    ) order by r.priority desc, r.name)
    from price_rules r), '[]'::jsonb);
end;
$$;

create function public.admin_update_price_rule(
  p_rule_id   uuid,
  p_value     numeric default null,
  p_is_active boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  old_r   price_rules%rowtype;
  new_r   price_rules%rowtype;
begin
  if p_value is null and p_is_active is null then
    raise exception 'nothing to update' using errcode = 'invalid_parameter_value';
  end if;
  if p_value is not null and (p_value < 0 or p_value > 100000) then
    raise exception 'value must be between 0 and 100000' using errcode = 'invalid_parameter_value';
  end if;

  select * into old_r from price_rules where id = p_rule_id for update;
  if not found then
    raise exception 'price rule % not found', p_rule_id using errcode = 'no_data_found';
  end if;

  update price_rules
     set value = coalesce(round(p_value, 2), value), is_active = coalesce(p_is_active, is_active)
   where id = p_rule_id returning * into new_r;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'update_price_rule', p_rule_id::text,
          jsonb_build_object('value', jsonb_build_array(old_r.value, new_r.value), 'is_active', jsonb_build_array(old_r.is_active, new_r.is_active)));
  return jsonb_build_object('id', new_r.id, 'value', new_r.value, 'is_active', new_r.is_active);
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges: the admin RPCs are callable by signed-in clients (they gate themselves via
-- require_admin()); never by anon. Everything else stays service-role only.
-- -----------------------------------------------------------------------------
revoke all on function public.require_admin(), public.admin_inflight_grace(), public.audit_admin_flag_change()
  from public, anon, authenticated;

revoke all on function
  public.get_admin_metrics(), public.admin_provider_status(), public.admin_reconciliation_queue(),
  public.admin_force_refund(uuid, text), public.admin_mark_resolved(uuid, text, text),
  public.admin_list_price_rules(), public.admin_update_price_rule(uuid, numeric, boolean)
  from public, anon;
grant execute on function
  public.get_admin_metrics(), public.admin_provider_status(), public.admin_reconciliation_queue(),
  public.admin_force_refund(uuid, text), public.admin_mark_resolved(uuid, text, text),
  public.admin_list_price_rules(), public.admin_update_price_rule(uuid, numeric, boolean)
  to authenticated, service_role;
