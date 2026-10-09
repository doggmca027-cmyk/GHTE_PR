-- =============================================================================
-- Phase 21 (2/2): worker resilience, admin alerts and wider kill switches
--
--   1. worker_locks / try_acquire_worker_lock / release_worker_lock
--        ONE instance of a worker at a time. This is a LEASE, not pg_try_advisory_lock: the Edge Functions talk to the database over
--        HTTP (PostgREST) through a connection pool, so a session-level advisory lock would stay on whatever pooled connection
--        happened to run the call (and could never be released from another one), while a transaction-level advisory lock ends
--        with the very call that took it. A row with an expiry has neither problem: it survives between calls and frees itself
--        if the worker dies.
--   2. providers.sync_backoff_until / sync_failure_count / record_provider_sync_result
--        a circuit breaker for the order-status poll: a provider that fails is left alone for 1, 2, 4 ... 60 minutes
--   3. get_order_sync_batch
--        the poll's work list, in SQL: skips providers in backoff, and orders held for a human (processing without a provider id)
--   4. notify_admin_anomalies (+ outbox alert rows)
--        reconciliation cases waiting too long and notifications that died, as ONE digest per admin per run
--   5. three more kill switches: new tickets, referral transfers, new sign-ups
--
-- Service role only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Worker locks (leases)
-- -----------------------------------------------------------------------------
create table public.worker_locks (
  name         text primary key check (name ~ '^[a-z0-9_-]{2,60}$'),
  token        uuid not null,
  locked_until timestamptz not null,
  acquired_at  timestamptz not null default now()
);
alter table public.worker_locks enable row level security;
revoke all on table public.worker_locks from anon, authenticated;

-- Returns the lease token, or NULL when someone else holds an unexpired lease. One atomic statement: of any number of concurrent
-- callers exactly one gets a row back (the others wait for the row lock, re-check "is it still expired?" and get nothing).
create function public.try_acquire_worker_lock(p_name text, p_ttl_seconds integer default 140)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
  v_got   uuid;
begin
  if p_ttl_seconds is null or p_ttl_seconds not between 5 and 900 then
    raise exception 'invalid_parameter_value: the lease must be 5 to 900 seconds' using errcode = 'invalid_parameter_value';
  end if;
  insert into worker_locks (name, token, locked_until)
  values (p_name, v_token, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
     set token = excluded.token, locked_until = excluded.locked_until, acquired_at = now()
   where worker_locks.locked_until <= now()
  returning token into v_got;
  return v_got;
end;
$$;

-- Frees the lease, but only for the run that holds it (a run that was too slow and lost its lease cannot free the next one's).
create function public.release_worker_lock(p_name text, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update worker_locks set locked_until = now() where name = p_name and token = p_token;
  return found;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. Circuit breaker on the provider poll
-- -----------------------------------------------------------------------------
alter table public.providers
  add column sync_backoff_until timestamptz,
  add column sync_failure_count integer not null default 0 check (sync_failure_count >= 0);

-- The result of one provider's status poll. Failure n leaves the provider alone for 2^(n-1) minutes (1, 2, 4, 8 ... capped at 60);
-- one success closes the breaker. The right-hand sides read the OLD count, atomically, so overlapping runs cannot lose a failure.
create function public.record_provider_sync_result(p_provider_id uuid, p_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_until timestamptz;
begin
  update providers
     set sync_failure_count = case when p_ok then 0 else least(sync_failure_count + 1, 20) end,
         sync_backoff_until = case when p_ok then null
                                   else now() + least(interval '60 minutes', interval '1 minute' * power(2, least(sync_failure_count, 10))) end
   where id = p_provider_id
  returning sync_failure_count, sync_backoff_until into v_count, v_until;
  if not found then
    raise exception 'provider % not found', p_provider_id using errcode = 'no_data_found';
  end if;
  return jsonb_build_object('failures', v_count, 'backoff_until', v_until);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. The poll's work list
-- -----------------------------------------------------------------------------
-- Oldest-checked first. What it includes and, on purpose, what it leaves out:
--   * in flight at a provider (submitted / in_progress / processing WITH a provider order id)            -> asks the provider
--   * a held order whose note says the provider accepted it ("provider accepted as <id> ...")              -> recovers the id, then asks
--   * a canceled / failed order whose refund is still owed (needs_refund)                                  -> finishes the refund; asks nobody
--   NOT included: `processing` without a provider order id and without that note: the outcome is unknown, there is nobody to ask,
--   and it waits for a human in the reconciliation queue (it used to be touched every minute and took a place in every batch).
--   NOT included: orders of a provider whose breaker is open (sync_backoff_until in the future), except the refund retries, which
--   do not need the provider.
create function public.get_order_sync_batch(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(to_jsonb(b) order by b.updated_at, b.id), '[]'::jsonb)
    from (
      select o.id, o.user_id, o.service_id, o.provider_id, o.provider_order_id, o.status, o.quantity, o.charge_amount, o.remains,
             o.start_count, o.error_message, o.created_at, o.updated_at, po.provider_id as offer_provider_id
        from orders o
        left join provider_service_offers po on po.id = o.provider_offer_id
       where (
               (
                 (   (o.status in ('submitted', 'in_progress', 'processing') and o.provider_order_id is not null)
                  or (o.status = 'processing' and o.provider_order_id is null and o.error_message like '%provider accepted as %'))
                 and not exists (select 1 from providers p
                                  where p.id = coalesce(po.provider_id, o.provider_id)
                                    and p.sync_backoff_until is not null and p.sync_backoff_until > now())
               )
            or (o.status in ('canceled', 'failed') and o.error_message like 'needs_refund%')
             )
       order by o.updated_at, o.id
       limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) b
$$;

create index idx_orders_sync_inflight on public.orders (updated_at) where status in ('submitted', 'in_progress', 'processing');
create index idx_orders_sync_refund on public.orders (updated_at) where status in ('canceled', 'failed') and error_message like 'needs\_refund%';

-- -----------------------------------------------------------------------------
-- 4. Admin alerts
-- -----------------------------------------------------------------------------
-- An alert is a row in the same durable outbox the customers' messages use (retries, back-off, 403 / 429 handling included).
alter table public.notification_outbox
  alter column order_id drop not null,
  add column payload    jsonb,
  add column alerted_at timestamptz;
alter table public.notification_outbox drop constraint notification_outbox_kind_check;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check check (kind in ('completed', 'partial', 'canceled', 'admin_alert')),
  add constraint notification_outbox_shape check (
    (kind = 'admin_alert' and payload is not null and order_id is null) or (kind <> 'admin_alert' and payload is null and order_id is not null));

-- Which (case, escalation step) pairs an admin has already been told about, so a case is announced at 15 min, 2 h and 24 h, not every run.
create table public.reconciliation_case_alerts (
  case_id    uuid not null references public.reconciliation_cases(id) on delete cascade,
  step       text not null check (step in ('15m', '2h', '24h')),
  alerted_at timestamptz not null default now(),
  primary key (case_id, step)
);
alter table public.reconciliation_case_alerts enable row level security;
revoke all on table public.reconciliation_case_alerts from anon, authenticated;

-- claim_notification_batch, now also handing out alert rows (no order behind them).
create or replace function public.claim_notification_batch(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_ids   uuid[];
begin
  with due as (
    select id from notification_outbox
     where status = 'pending' and next_attempt_at <= now()
     order by next_attempt_at, created_at
     limit v_limit
     for update skip locked
  ), leased as (
    update notification_outbox o
       set attempts = o.attempts + 1, next_attempt_at = now() + interval '2 minutes'
      from due where o.id = due.id
    returning o.id
  )
  select array_agg(id) into v_ids from leased;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'kind', l.kind, 'dedupe_key', l.dedupe_key, 'attempts', l.attempts, 'created_at', l.created_at, 'payload', l.payload,
      'order_id', ord.id, 'order_status', ord.status, 'quantity', ord.quantity, 'remains', ord.remains,
      'charge_amount', ord.charge_amount, 'partial_refund_amount', ord.partial_refund_amount,
      'service_name', s.name,
      'user_id', u.id, 'telegram_id', u.telegram_id, 'language_code', u.language_code,
      'notifications_enabled', u.notifications_enabled,
      'bot_blocked_recently', u.bot_blocked_at is not null and u.bot_blocked_at > now() - interval '30 days'
    ) order by l.created_at)
      from notification_outbox l
      left join orders ord on ord.id = l.order_id
      join users u on u.id = l.user_id
      left join services s on s.id = ord.service_id
     where l.id = any(v_ids)), '[]'::jsonb);
end;
$$;

-- Scans for things that need a human and queues ONE digest message per admin for each kind of problem found in this run:
--   a) open reconciliation cases older than 15 minutes (told again at 2 hours and at 24 hours)
--   b) notifications that died after their retries (told once)
-- Idempotent: re-running it finds nothing new. Alert rows that themselves die are not reported again (no alert about alerts).
create function public.notify_admin_anomalies()
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

  return jsonb_build_object('cases_announced', v_cases, 'dead_announced', v_dead);
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('notify-admin-anomalies', '*/5 * * * *', 'select public.notify_admin_anomalies()');
    exception when others then
      raise warning 'notify-admin-anomalies was not scheduled: %', sqlerrm;
    end;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Kill switches for the newer vectors (flipped by supabase/scripts/emergency_quarantine.sql)
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column global_tickets_enabled            boolean not null default true,
  add column global_referral_transfers_enabled boolean not null default true,
  add column global_signups_enabled            boolean not null default true;

-- ---- Access ---------------------------------------------------------------------------------------------------------------
revoke all on function public.try_acquire_worker_lock(text, integer) from public, anon, authenticated;
revoke all on function public.release_worker_lock(text, uuid) from public, anon, authenticated;
revoke all on function public.record_provider_sync_result(uuid, boolean) from public, anon, authenticated;
revoke all on function public.get_order_sync_batch(integer) from public, anon, authenticated;
revoke all on function public.notify_admin_anomalies() from public, anon, authenticated;
grant execute on function public.try_acquire_worker_lock(text, integer) to service_role;
grant execute on function public.release_worker_lock(text, uuid) to service_role;
grant execute on function public.record_provider_sync_result(uuid, boolean) to service_role;
grant execute on function public.get_order_sync_batch(integer) to service_role;
grant execute on function public.notify_admin_anomalies() to service_role;

-- ---- the two functions that honour the new switches (same bodies as before plus the check) --------------------------------
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

create or replace function public.transfer_affiliate_balance_to_wallet(
  p_user_id         uuid,
  p_amount          numeric default null,
  p_idempotency_key text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key       text := coalesce(nullif(btrim(p_idempotency_key), ''), 'transfer:' || gen_random_uuid());
  v_existing  referral_ledger%rowtype;
  v_available numeric(14,4);
  v_amount    numeric(14,4);
  v_tx        wallet_transactions%rowtype;
  v_ledger    referral_ledger%rowtype;
begin
  if length(v_key) > 100 then
    raise exception 'invalid_parameter_value: idempotency key is too long' using errcode = 'invalid_parameter_value';
  end if;
  if p_amount is not null and round(p_amount, 4) <= 0 then
    raise exception 'invalid_parameter_value: amount must be greater than zero' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;

  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  -- replay of a finished transfer: answer with it, move nothing
  select * into v_existing from referral_ledger where idempotency_key = 'transfer:' || v_key and user_id = p_user_id;
  if found then
    return jsonb_build_object('transferred', -v_existing.amount, 'replayed', true, 'balance', referral_balance(p_user_id));
  end if;
  if exists (select 1 from referral_ledger where idempotency_key = 'transfer:' || v_key) then
    raise exception 'idempotency_conflict: this key belongs to another user' using errcode = 'unique_violation';
  end if;

  -- a transfer that already happened is still answered above; a NEW one waits while the switch is off
  if not (select global_referral_transfers_enabled from platform_settings where id = 1) then
    raise exception 'feature_paused: affiliate transfers are temporarily switched off' using errcode = 'check_violation';
  end if;

  v_available := (referral_balance(p_user_id)->>'available')::numeric;
  v_amount := round(coalesce(p_amount, v_available), 4);
  if v_amount <= 0 then
    raise exception 'insufficient_affiliate_balance: nothing is available to transfer' using errcode = 'check_violation';
  end if;
  if v_amount > v_available then
    raise exception 'insufficient_affiliate_balance: available %, requested %', v_available, v_amount using errcode = 'check_violation';
  end if;

  v_tx := process_wallet_transaction(p_user_id, 'bonus', v_amount, null, 'Affiliate earnings transferred to the wallet', 'affiliate:' || v_key);
  insert into referral_ledger (user_id, transaction_type, amount, wallet_transaction_id, idempotency_key)
  values (p_user_id, 'transfer_to_wallet', -v_amount, v_tx.id, 'transfer:' || v_key)
  returning * into v_ledger;

  return jsonb_build_object('transferred', v_amount, 'replayed', false, 'wallet_balance', v_tx.balance_after, 'balance', referral_balance(p_user_id));
end;
$$;
