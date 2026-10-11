-- Security audit remediation (phases 1-5 of the audit; tests/security-audit-remediation.test.ts reproduces every item).
--
--   #2   an order that stayed `paid` (charged, never claimed, never sent) was invisible to every recovery path
--   #3   the amount a customer really paid was thrown away: overpayments vanished without a trace
--   #4   no way to credit an underpaid / late deposit: cases could only be closed with a note
--   #5   wallet balance was protected by a convention only (service_role could UPDATE it); drift was not monitored
--   #9   remains / start_count came from the provider with no bound in the database
--   #10  the provider reservation was only released on a clean rejection
--   #11  a quote assumed the cheapest provider while the order is routed to whichever is eligible
--   #13  there was no way to ban (or unban) a customer from the application, and a banned customer could still use support
--
-- Nothing here weakens an existing policy, constraint or grant. users_select_own stays as it is on purpose: a suspended customer must be
-- able to read their own row so the app can show the "account suspended" state.

-- ===== #3 what was received ==============================================================================================
alter table public.deposits add column received_amount_nano bigint
  check (received_amount_nano is null or received_amount_nano >= 0);

create or replace function public.complete_deposit(
  p_deposit_id     uuid,
  p_tx_hash        text,
  p_sender_address text default null,
  p_received_nano  numeric default null
) returns public.deposits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.deposits%rowtype;
  v_required numeric;
begin
  if p_tx_hash is null or length(p_tx_hash) = 0 or length(p_tx_hash) > 128 or p_tx_hash ~ '\s' then
    raise exception 'tx hash is required and must be a single token of at most 128 characters' using errcode = 'invalid_parameter_value';
  end if;

  -- Serialises every verification of this deposit: concurrent callers queue here.
  select * into d from deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;

  if d.status = 'completed' then
    return d; -- already credited: idempotent (the ledger key below would refuse a second credit anyway)
  end if;
  if d.status = 'failed' then
    raise exception 'deposit % has failed and cannot be completed', d.id using errcode = 'check_violation';
  end if;

  v_required := round(d.amount_crypto * 1000000000);
  if p_received_nano is not null and p_received_nano < v_required then
    raise exception 'underpaid: received % nanoton, required %', p_received_nano, v_required
      using errcode = 'check_violation';
  end if;

  -- Explicit check for a friendly error; the UNIQUE constraint on tx_hash is the real guarantee.
  if exists (select 1 from deposits where tx_hash = p_tx_hash and id <> d.id) then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end if;

  -- Two DIFFERENT deposits racing for the same hash both pass the check above (neither sees the other's uncommitted
  -- claim); the UNIQUE index then makes the second one wait and fail. Report that as the same business error.
  begin
    update deposits
       set status = 'completed', tx_hash = p_tx_hash, sender_address = p_sender_address, completed_at = now(),
           received_amount_nano = case when p_received_nano is null then null else round(p_received_nano)::bigint end
     where id = d.id
    returning * into d;
  exception when unique_violation then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end;

  perform process_wallet_transaction(
    d.user_id, 'deposit', d.amount_usd, d.id,
    'Deposit via Tonkeeper (' || d.asset || ')', 'deposit:' || d.id);

  -- Only the quoted amount is credited. What came on top stays on our wallet, so it is written down and put in front of an admin
  -- (to be returned or kept by decision), instead of disappearing silently.
  if p_received_nano is not null and p_received_nano > v_required then
    insert into reconciliation_cases (entity_type, entity_id, reason)
    values ('deposit', d.id::text, left(format('overpaid: received %s nanoton, quoted %s (credited %s USD only)', round(p_received_nano), v_required, d.amount_usd), 500))
    on conflict (entity_type, entity_id) where status = 'open'
    do update set reason = excluded.reason;
  end if;

  return d;
end;
$$;

-- ===== #4 resolving a deposit that could not be credited automatically ===================================================
-- action 'credit':  the admin names the on-chain transaction that paid it and the amount that arrived (nanoton). The customer is
--                   credited pro rata (a full payment, even a late one, is credited in full; half a payment, half). One transaction
--                   hash funds one deposit, ever (UNIQUE), and repeating the same call credits nothing twice.
-- action 'dismiss': closes the case with a mandatory note and credits nothing (e.g. the money was sent back by hand).
create or replace function public.admin_resolve_deposit(
  p_deposit_id    uuid,
  p_action        text,
  p_tx_hash       text    default null,
  p_received_nano numeric default null,
  p_note          text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin    uuid := require_admin();
  d          public.deposits%rowtype;
  v_note     text := nullif(btrim(p_note), '');
  v_hash     text := nullif(btrim(p_tx_hash), '');
  v_required numeric;
  v_credit   numeric(14,4);
begin
  if p_action not in ('credit', 'dismiss') then
    raise exception 'invalid_parameter_value: action must be credit or dismiss' using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;

  if p_action = 'dismiss' then
    if v_note is null then
      raise exception 'invalid_parameter_value: a note is required to dismiss a deposit case' using errcode = 'invalid_parameter_value';
    end if;
    update reconciliation_cases
       set status = 'resolved', resolution = 'manual', resolution_note = left(v_note, 500), resolved_by = v_admin, resolved_at = now()
     where entity_type = 'deposit' and entity_id = d.id::text and status = 'open';
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (v_admin, 'resolve_deposit', d.id::text, jsonb_build_object('action', 'dismiss', 'note', v_note));
    return jsonb_build_object('deposit_id', d.id, 'status', d.status, 'credited', 0, 'action', 'dismiss');
  end if;

  -- credit
  if v_hash is null or length(v_hash) > 128 or v_hash ~ '\s' then
    raise exception 'invalid_parameter_value: tx hash is required, one token of at most 128 characters' using errcode = 'invalid_parameter_value';
  end if;
  if d.status = 'completed' then
    if d.tx_hash = v_hash then
      return jsonb_build_object('deposit_id', d.id, 'status', 'completed', 'credited', 0, 'action', 'credit', 'replayed', true);
    end if;
    raise exception 'deposit_already_completed: this deposit was credited with another transaction' using errcode = 'check_violation';
  end if;
  if d.status = 'failed' then
    raise exception 'deposit % has failed and cannot be credited', d.id using errcode = 'check_violation';
  end if;
  if exists (select 1 from deposits where tx_hash = v_hash and id <> d.id) then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end if;
  if p_received_nano is null or p_received_nano <= 0 then
    raise exception 'invalid_parameter_value: the received amount (nanoton) is required' using errcode = 'invalid_parameter_value';
  end if;

  v_required := round(d.amount_crypto * 1000000000);
  v_credit := round(d.amount_usd * least(p_received_nano / v_required, 1), 4);
  if v_credit <= 0 then
    raise exception 'invalid_parameter_value: nothing to credit' using errcode = 'invalid_parameter_value';
  end if;

  begin
    update deposits
       set status = 'completed', tx_hash = v_hash, received_amount_nano = round(p_received_nano)::bigint, completed_at = now()
     where id = d.id
    returning * into d;
  exception when unique_violation then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end;

  perform process_wallet_transaction(
    d.user_id, 'deposit', v_credit, d.id,
    'Deposit resolved by an administrator', 'deposit:' || d.id);

  update reconciliation_cases
     set status = 'resolved', resolution = 'manual', resolution_note = left(coalesce(v_note, 'credited by an administrator'), 500),
         resolved_by = v_admin, resolved_at = now()
   where entity_type = 'deposit' and entity_id = d.id::text and status = 'open';

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'resolve_deposit', d.id::text,
          jsonb_build_object('action', 'credit', 'tx_hash', v_hash, 'received_nano', round(p_received_nano), 'credited_usd', v_credit, 'note', v_note));

  return jsonb_build_object('deposit_id', d.id, 'status', 'completed', 'credited', v_credit, 'action', 'credit');
end;
$$;

revoke all on function public.admin_resolve_deposit(uuid, text, text, numeric, text) from public, anon;
grant execute on function public.admin_resolve_deposit(uuid, text, text, numeric, text) to authenticated, service_role;

-- ===== #2 an order that stayed paid ======================================================================================
-- paid + not waiting for provider funds + older than the grace period: nothing was ever sent (the only way out of `paid` is the
-- atomic claim), so it is safe to show it to an admin. After an hour it is refunded by the worker below.
create or replace function public.order_needs_reconciliation(o public.orders)
returns boolean
language sql
stable
as $$
  select coalesce(o.status not in ('refunded', 'completed', 'partial', 'draft')
     and ((o.status = 'processing'
           and (o.created_at < now() - public.admin_inflight_grace()
                -- the provider call RETURNED with an unknown outcome: nothing is in flight any more
                or (o.provider_order_id is null
                    and o.error_message like 'needs\_reconciliation:%'
                    and o.error_message <> 'needs_reconciliation: submission in flight'
                    and o.error_message not like 'needs\_reconciliation: retry in progress%')))
          or (o.status = 'paid' and o.awaiting_funds_since is null and o.created_at < now() - public.admin_inflight_grace())
          or (o.status <> 'processing' and o.error_message like 'needs\_%')), false)
$$;

create function public.expire_stale_paid_orders()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        record;
  v_done   integer := 0;
  v_failed integer := 0;
begin
  for r in
    select id from orders
     where status = 'paid' and awaiting_funds_since is null and created_at < now() - interval '1 hour'
     order by created_at, id
     limit 100
       for update skip locked
  loop
    begin
      -- a client retry may have claimed it between the scan and the lock: only an order that is STILL paid is refunded
      perform 1 from orders where id = r.id and status = 'paid' and awaiting_funds_since is null;
      if found then
        perform refund_order(r.id, null, 'The order was never sent to the provider');
        perform release_provider_reservation(r.id);
        v_done := v_done + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'expire_stale_paid_orders: order % not refunded: %', r.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('refunded', v_done, 'failed', v_failed);
end;
$$;

revoke all on function public.expire_stale_paid_orders() from public, anon, authenticated;
grant execute on function public.expire_stale_paid_orders() to service_role;

-- ===== #5 the wallet is writable only through the ledger functions =======================================================
-- Every legitimate change runs inside process_wallet_transaction / settle_wallet_transaction, which are SECURITY DEFINER and execute as
-- the table owner. The API role does not need UPDATE on wallets, so it no longer has it.
revoke update on public.wallets from service_role;

create function public.ledger_drift_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
    from wallets w
   where w.balance <> coalesce((select sum(t.amount) from wallet_transactions t where t.wallet_id = w.id and t.status = 'completed'), 0)
$$;

revoke all on function public.ledger_drift_count() from public, anon, authenticated;
grant execute on function public.ledger_drift_count() to service_role;

create or replace function public.get_system_health(p_hours integer default 24)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hours      integer := least(greatest(coalesce(p_hours, 24), 1), 24);
  v_since      timestamptz := now() - make_interval(hours => v_hours);
  v_cron       jsonb;
  v_cron_error text;
  v_orders     jsonb;
  v_providers  jsonb;
  v_errors     jsonb;
  v_cases      jsonb;
begin
  -- pg_cron pulse. Read through dynamic SQL so databases without pg_cron still work (null = not readable).
  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    begin
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_object(
                 'name', j.jobname, 'schedule', j.schedule, 'active', j.active,
                 'last_run_at', r.start_time, 'last_status', r.status,
                 'last_success_at', (select max(s.start_time) from cron.job_run_details s
                                      where s.jobid = j.jobid and s.status = 'succeeded' and s.start_time > now() - interval '2 days'),
                 'runs', (select count(*) from cron.job_run_details s where s.jobid = j.jobid and s.start_time >= $1),
                 'failed_runs', (select count(*) from cron.job_run_details s where s.jobid = j.jobid and s.status = 'failed' and s.start_time >= $1)
               ) order by j.jobname), '[]'::jsonb)
          from cron.job j
          left join lateral (select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) r on true
      $q$ into v_cron using v_since;
    exception when others then
      v_cron := null;
      v_cron_error := sqlstate;
    end;
  end if;

  select jsonb_build_object(
    'stuck', count(*) filter (where status = 'processing' and created_at < now() - admin_inflight_grace()),
    'stuck_oldest_minutes', coalesce(floor(extract(epoch from now() - min(created_at) filter (where status = 'processing' and created_at < now() - admin_inflight_grace())) / 60), 0),
    'held', count(*) filter (where order_needs_reconciliation(o)),
    'queue', (select coalesce(jsonb_object_agg(q.status, q.n), '{}'::jsonb)
                from (select status, count(*) n from orders where status in ('paid', 'processing', 'submitted', 'in_progress') group by status) q)
  ) into v_orders
  from orders o
  where o.status not in ('refunded', 'completed', 'partial', 'draft');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'is_active', p.is_active, 'routing_enabled', p.routing_enabled,
    'health_status', p.health_status, 'last_health_check', p.last_health_check,
    'balance', p.provider_balance, 'currency', p.currency, 'last_balance_sync', p.last_balance_sync, 'low_balance_threshold', p.low_balance_threshold,
    'checks', coalesce(h.checks, 0), 'failed_checks', coalesce(h.failed, 0), 'avg_latency_ms', h.avg_latency, 'max_latency_ms', h.max_latency,
    'last_error_kind', h.last_error_kind, 'last_error_at', h.last_error_at, 'errors_by_kind', coalesce(h.kinds, '{}'::jsonb),
    'orders', coalesce(od.total, 0), 'orders_failed', coalesce(od.failed, 0), 'orders_held', coalesce(od.held, 0)
  ) order by p.priority desc, p.name), '[]'::jsonb) into v_providers
  from providers p
  left join lateral (
    select count(*) checks,
           count(*) filter (where l.error_kind is not null or l.status = 'unavailable') failed,
           round(avg(l.latency_ms))::integer avg_latency, max(l.latency_ms) max_latency,
           (select e.error_kind from provider_health_log e where e.provider_id = p.id and e.error_kind is not null and e.checked_at >= v_since order by e.checked_at desc limit 1) last_error_kind,
           (select max(e.checked_at) from provider_health_log e where e.provider_id = p.id and e.error_kind is not null and e.checked_at >= v_since) last_error_at,
           (select jsonb_object_agg(k.error_kind, k.n) from (select e.error_kind, count(*) n from provider_health_log e
                    where e.provider_id = p.id and e.error_kind is not null and e.checked_at >= v_since group by e.error_kind) k) kinds
      from provider_health_log l where l.provider_id = p.id and l.checked_at >= v_since) h on true
  left join lateral (
    select count(*) total, count(*) filter (where ord.status = 'failed') failed, count(*) filter (where order_needs_reconciliation(ord)) held
      from orders ord where ord.provider_id = p.id and ord.created_at >= v_since) od on true;

  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_id', e.provider_id, 'provider_name', p.name, 'error_kind', e.error_kind, 'status', e.status,
    'latency_ms', e.latency_ms, 'checked_at', e.checked_at) order by e.checked_at desc), '[]'::jsonb) into v_errors
  from (select * from provider_health_log where error_kind is not null and checked_at >= v_since order by checked_at desc limit 15) e
  join providers p on p.id = e.provider_id;

  -- open reconciliation cases, briefly (the Edge Function ranks them with the same severity rule as the Reconciliation tab)
  select jsonb_build_object(
    'total', (select count(*) from reconciliation_cases where status = 'open'),
    'cases', coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'entity_type', c.entity_type, 'reason', c.reason, 'created_at', c.created_at,
                                                    'amount', coalesce(o.charge_amount, pp.amount)) order by c.created_at), '[]'::jsonb)
  ) into v_cases
  from (select * from reconciliation_cases where status = 'open' order by created_at limit 200) c
  left join orders o on c.entity_type = 'order' and o.id::text = c.entity_id
  left join provider_payments pp on c.entity_type = 'provider_payment' and pp.id::text = c.entity_id;

  return jsonb_build_object(
    'generated_at', now(),
    'window_hours', v_hours,
    'db', jsonb_build_object('ok', true, 'now', now()),
    'orders', v_orders,
    'reconciliation', v_cases,
    'providers', v_providers,
    'recent_provider_errors', v_errors,
    'deposits', jsonb_build_object(
      'pending', (select count(*) from deposits where status = 'pending' and valid_until >= now()),
      'stale_pending', (select count(*) from deposits where status = 'pending' and valid_until < now())),
    'proposals', jsonb_build_object('pending', (select count(*) from topup_proposals where status = 'pending')),
    'payments', jsonb_build_object('in_progress', (select count(*) from provider_payments where status not in ('COMPLETED', 'FAILED', 'CANCELED'))),
    'treasury', jsonb_build_object(
      'balance', (select balance from treasury_state where id = 1),
      'minimum_reserve', (select minimum_treasury_reserve from platform_settings where id = 1)),
    'workers', coalesce((select jsonb_agg(jsonb_build_object(
      'worker', w.worker, 'last_run_at', w.last_run_at, 'last_success_at', w.last_success_at, 'last_error_at', w.last_error_at,
      'last_error', w.last_error, 'last_duration_ms', w.last_duration_ms, 'runs', w.runs, 'failures', w.failures) order by w.worker) from worker_heartbeats w), '[]'::jsonb),
    'cron', v_cron,
    'cron_error', v_cron_error,
    -- wallets whose balance is not the sum of their completed ledger entries (must always be 0)
    'ledger', jsonb_build_object('drift_count', public.ledger_drift_count())
  );
end;
$$;

-- ===== #9 numbers from a provider are bounded in the database ============================================================
-- Rows that already break the rule are repaired first (the unknown value is NULL), otherwise the constraint would also block every
-- later update of those orders. The constraints are added NOT VALID (enforced for every write from now on) and validated if the
-- existing data allows it.
update public.orders set remains = null where remains is not null and (remains < 0 or remains > quantity);
update public.orders set start_count = null where start_count is not null and start_count < 0;

alter table public.orders
  add constraint orders_remains_bounds check (remains is null or (remains >= 0 and remains <= quantity)) not valid;
alter table public.orders
  add constraint orders_start_count_nonneg check (start_count is null or start_count >= 0) not valid;

do $$
begin
  alter table public.orders validate constraint orders_remains_bounds;
  alter table public.orders validate constraint orders_start_count_nonneg;
exception when others then
  raise notice 'orders bounds constraints stay NOT VALID: %', sqlerrm;
end;
$$;

-- ===== #10 the provider reservation follows the order to its end =========================================================
-- When the PROVIDER confirms that an accepted order ended (canceled / failed), the money it had reserved is free again; for a partial
-- order the share that was not delivered is. Orders in unknown state (processing) keep their reservation: the provider may hold them.
create function public.trg_orders_release_reservation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_release numeric(14,4) := 0;
begin
  if new.provider_id is null or new.provider_reservation <= 0 then
    return new;
  end if;
  if new.status in ('canceled', 'failed') then
    v_release := new.provider_reservation;
  elsif new.status = 'partial' and new.remains is not null and new.quantity > 0 then
    v_release := round(new.provider_reservation * new.remains / new.quantity, 4);
  end if;
  if v_release > 0 then
    update providers set provider_balance = provider_balance + v_release where id = new.provider_id;
    new.provider_reservation := new.provider_reservation - v_release;
  end if;
  return new;
end;
$$;

create trigger trg_orders_release_reservation
  before update of status on public.orders
  for each row
  when (old.status in ('submitted', 'in_progress') and new.status is distinct from old.status)
  execute function public.trg_orders_release_reservation();

revoke all on function public.trg_orders_release_reservation() from public, anon, authenticated;

-- ===== #11 a quote can only be too high, never too low ===================================================================
create or replace function public.quote_order_price(p_user_id uuid, p_service_id uuid, p_quantity integer, p_promo_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost numeric(14,4);
begin
  -- The order is routed to the best ELIGIBLE offer (health, balance and score are decided by the Edge Function). The quote assumes the
  -- most expensive offer that can take the order and still be sold at the list price: the customer is never shown less than they pay.
  select max(o.cost_per_1000) into v_cost
    from provider_service_offers o
    join providers p on p.id = o.provider_id
    join provider_services ps on ps.id = o.provider_service_id
    join services s on s.id = o.service_id
   where o.service_id = p_service_id and o.is_active and ps.is_active and p.is_active and p.routing_enabled
     and p_quantity between o.min_quantity and o.max_quantity
     and o.cost_per_1000 <= s.customer_rate_per_1000;
  if v_cost is null then
    raise exception 'service_unavailable: no provider can take this order' using errcode = 'no_data_found';
  end if;
  return calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_cost * p_quantity / 1000, 4), p_promo_code);
end;
$$;

-- ===== #13 banning ===========================================================================================================
create function public.admin_set_user_ban(p_user_id uuid, p_is_banned boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin  uuid := require_admin();
  v_reason text := nullif(btrim(p_reason), '');
  u        users%rowtype;
begin
  if p_is_banned is null then
    raise exception 'invalid_parameter_value: p_is_banned is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_user_id = v_admin then
    raise exception 'invalid_parameter_value: you cannot ban or unban yourself' using errcode = 'invalid_parameter_value';
  end if;
  select * into u from users where id = p_user_id for update;
  if not found then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;
  if u.is_banned is distinct from p_is_banned then
    update users set is_banned = p_is_banned where id = u.id;
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (v_admin, case when p_is_banned then 'ban_user' else 'unban_user' end, u.id::text,
            jsonb_build_object('telegram_id', u.telegram_id, 'reason', v_reason));
  end if;
  return jsonb_build_object('user_id', u.id, 'is_banned', p_is_banned);
end;
$$;

revoke all on function public.admin_set_user_ban(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_user_ban(uuid, boolean, text) to authenticated, service_role;

-- A suspended customer cannot open or answer tickets (the same refusal as buying or depositing).
create or replace function public.support_create_ticket(p_user_id uuid, p_subject text, p_message text, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text := btrim(coalesce(p_subject, ''));
  v_message text := btrim(coalesce(p_message, ''));
  t         support_tickets%rowtype;
begin
  if char_length(v_subject) not between 3 and 120 then
    raise exception 'invalid_parameter_value: the subject must be 3 to 120 characters' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_message) not between 1 and 4000 then
    raise exception 'invalid_parameter_value: the message must be 1 to 4000 characters' using errcode = 'invalid_parameter_value';
  end if;
  if not (select global_tickets_enabled from platform_settings where id = 1) then
    raise exception 'feature_paused: new tickets are temporarily switched off' using errcode = 'check_violation';
  end if;
  perform 1 from users where id = p_user_id for update;   -- serialises this customer's tickets, so the caps below hold under load
  if not found then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  -- an order can only be attached by its owner; any other id is "not found", exactly like one that does not exist
  if p_order_id is not null and not exists (select 1 from orders where id = p_order_id and user_id = p_user_id) then
    raise exception 'order_not_found: that order is not yours or does not exist' using errcode = 'no_data_found';
  end if;
  if (select count(*) from support_tickets where user_id = p_user_id and status in ('open', 'answered')) >= 5 then
    raise exception 'too_many_open_tickets: please wait for an answer to your open tickets' using errcode = 'check_violation';
  end if;
  if (select count(*) from ticket_messages where sender_id = p_user_id and not is_admin and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited: too many messages, try again later' using errcode = 'check_violation';
  end if;

  insert into support_tickets (user_id, order_id, subject) values (p_user_id, p_order_id, v_subject) returning * into t;
  insert into ticket_messages (ticket_id, sender_id, is_admin, message_text) values (t.id, p_user_id, false, v_message);
  select * into t from support_tickets where id = t.id;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;

create or replace function public.support_add_message(p_user_id uuid, p_ticket_id uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  t      support_tickets%rowtype;
begin
  if char_length(v_text) not between 1 and 4000 then
    raise exception 'invalid_parameter_value: the message must be 1 to 4000 characters' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  select * into t from support_tickets where id = p_ticket_id and user_id = p_user_id for update;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';
  end if;
  if t.status = 'closed' then
    raise exception 'ticket_closed: this ticket is closed' using errcode = 'restrict_violation';
  end if;
  if (select count(*) from ticket_messages where sender_id = p_user_id and not is_admin and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited: too many messages, try again later' using errcode = 'check_violation';
  end if;
  insert into ticket_messages (ticket_id, sender_id, is_admin, message_text) values (t.id, p_user_id, false, v_text);
  select * into t from support_tickets where id = t.id;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;
