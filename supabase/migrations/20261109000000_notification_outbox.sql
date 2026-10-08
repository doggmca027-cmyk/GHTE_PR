-- =============================================================================
-- Phase 19: a durable outbox for order notifications (Telegram)
--
-- Why: sync-order-status already tells customers about completed / partial / canceled orders, straight after its database work.
-- That "fast path" has gaps: a Telegram hiccup or rate limit loses the message (the order is already final, so nothing re-sends it),
-- and orders that finish through other doors (admin force refund, reconciliation) were never announced. The outbox closes both:
--
--   notification_outbox          one row per (order, outcome), written by a trigger in the SAME transaction as the status change.
--                                A single INSERT into its own table: no network, no lock on orders beyond the row being updated,
--                                and a failure inside the trigger is swallowed (it can never fail an order).
--   claim_notification_batch()   hands the telegram-notifier function a batch of due rows; FOR UPDATE SKIP LOCKED, so overlapping
--                                runs never take the same row, and a 2-minute lease makes a crashed run's rows come back
--   complete_notification()      records the outcome: sent / retry with back-off (or Telegram's retry_after) / blocked / dead
--   users.bot_blocked_at         set when Telegram answers 403 (the customer blocked the bot); no more attempts for 30 days
--
-- The fast path and the notifier share one dedupe key per event (notification_log, 'order:<id>:<completed|partial|canceled>'),
-- so whichever sends first wins and the customer is never told twice. Service role only.
-- =============================================================================

alter table public.users add column bot_blocked_at timestamptz;

create type public.notification_status as enum ('pending', 'sent', 'blocked', 'skipped', 'dead');

create table public.notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  kind            text not null check (kind in ('completed', 'partial', 'canceled')),
  dedupe_key      text not null unique,
  status          public.notification_status not null default 'pending',
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index idx_outbox_due on public.notification_outbox (next_attempt_at) where status = 'pending';

alter table public.notification_outbox enable row level security;
revoke all on table public.notification_outbox from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. The trigger: an order reached an outcome the customer should hear about
-- -----------------------------------------------------------------------------
-- 'failed' is told as 'canceled', as the customer-facing messages already do. The first attempt is held back 30 seconds so the
-- worker's own fast path (which sends right after it has refunded) normally gets there first; the dedupe key makes a race harmless.
create function public.trg_orders_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := case new.status when 'completed' then 'completed' when 'partial' then 'partial' else 'canceled' end;
begin
  begin
    insert into notification_outbox (order_id, user_id, kind, dedupe_key, next_attempt_at)
    values (new.id, new.user_id, v_kind, 'order:' || new.id || ':' || v_kind, now() + interval '30 seconds')
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'notification outbox: order % skipped: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
create trigger trg_orders_notify after update of status on public.orders
  for each row when (old.status is distinct from new.status and new.status in ('completed', 'partial', 'canceled', 'failed'))
  execute function public.trg_orders_notify();

-- -----------------------------------------------------------------------------
-- 2. Claiming a batch
-- -----------------------------------------------------------------------------
-- Due rows, oldest first. Each claimed row is leased for 2 minutes (next_attempt_at moves forward) and its attempt counter goes up,
-- so a run that dies mid-way does not lose its rows and two runs never share one. Returns what the notifier needs to write the
-- message, read in the same statement: order facts, the service name and the customer's chat.
create function public.claim_notification_batch(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_ids   uuid[];
begin
  -- the lease: one statement picks the due rows (skipping any another run holds) and pushes their next attempt forward
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
      'id', l.id, 'kind', l.kind, 'dedupe_key', l.dedupe_key, 'attempts', l.attempts, 'created_at', l.created_at,
      'order_id', ord.id, 'order_status', ord.status, 'quantity', ord.quantity, 'remains', ord.remains,
      'charge_amount', ord.charge_amount, 'partial_refund_amount', ord.partial_refund_amount,
      'service_name', s.name,
      'user_id', u.id, 'telegram_id', u.telegram_id, 'language_code', u.language_code,
      'notifications_enabled', u.notifications_enabled,
      'bot_blocked_recently', u.bot_blocked_at is not null and u.bot_blocked_at > now() - interval '30 days'
    ) order by l.created_at)
      from notification_outbox l
      join orders ord on ord.id = l.order_id
      join users u on u.id = l.user_id
      left join services s on s.id = ord.service_id
     where l.id = any(v_ids)), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Recording the outcome
-- -----------------------------------------------------------------------------
--   sent      delivered (or already delivered by the fast path)
--   skipped   nothing to send: the customer turned notifications off, or the bot is not configured for this environment
--   blocked   Telegram said 403: the bot is flagged on the user and never retried for 30 days
--   retry     transient: tried again after Telegram's retry_after when given, else 1, 2, 5, 15, 30, 60 ... minutes; a row that has
--             failed 8 times or is older than 24 hours is dead
--   wait      not ready yet (a cancellation whose refund has not been booked): tried again in 2 minutes without counting as a failure
create function public.complete_notification(p_id uuid, p_outcome text, p_retry_after_seconds integer default null, p_error text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o       notification_outbox%rowtype;
  v_wait  interval;
begin
  select * into o from notification_outbox where id = p_id for update;
  if not found then
    raise exception 'notification % not found', p_id using errcode = 'no_data_found';
  end if;
  if o.status <> 'pending' then
    return o.status::text; -- already finished: a repeated report changes nothing
  end if;

  if p_outcome = 'sent' then
    update notification_outbox set status = 'sent', finished_at = now(), last_error = null where id = p_id;
    return 'sent';
  elsif p_outcome = 'skipped' then
    update notification_outbox set status = 'skipped', finished_at = now(), last_error = left(p_error, 200) where id = p_id;
    return 'skipped';
  elsif p_outcome = 'blocked' then
    update users set bot_blocked_at = now() where id = o.user_id;
    update notification_outbox set status = 'blocked', finished_at = now(), last_error = 'user_blocked_bot' where id = p_id;
    return 'blocked';
  elsif p_outcome = 'wait' then
    update notification_outbox set attempts = greatest(o.attempts - 1, 0), next_attempt_at = now() + interval '2 minutes', last_error = left(p_error, 200) where id = p_id;
    if o.created_at < now() - interval '24 hours' then
      update notification_outbox set status = 'dead', finished_at = now(), last_error = 'not ready after 24 hours' where id = p_id;
      return 'dead';
    end if;
    return 'pending';
  elsif p_outcome = 'retry' then
    if o.attempts >= 8 or o.created_at < now() - interval '24 hours' then
      update notification_outbox set status = 'dead', finished_at = now(), last_error = left(coalesce(p_error, 'gave up'), 200) where id = p_id;
      return 'dead';
    end if;
    v_wait := case
      when p_retry_after_seconds is not null then make_interval(secs => least(greatest(p_retry_after_seconds, 1), 3600))
      else (array[1, 2, 5, 15, 30, 60, 60, 60])[least(o.attempts, 8)] * interval '1 minute' end;
    update notification_outbox set next_attempt_at = now() + v_wait, last_error = left(p_error, 200) where id = p_id;
    return 'pending';
  end if;
  raise exception 'invalid_parameter_value: unknown outcome %', p_outcome using errcode = 'invalid_parameter_value';
end;
$$;

-- What the health screen / an admin can read: the queue at a glance.
create function public.notification_outbox_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'oldest_pending_seconds', coalesce(extract(epoch from now() - min(created_at) filter (where status = 'pending'))::int, 0),
    'sent', count(*) filter (where status = 'sent'),
    'blocked', count(*) filter (where status = 'blocked'),
    'dead', count(*) filter (where status = 'dead'))
  from notification_outbox
$$;

revoke all on function public.trg_orders_notify() from public, anon, authenticated;
revoke all on function public.claim_notification_batch(integer) from public, anon, authenticated;
revoke all on function public.complete_notification(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.notification_outbox_stats() from public, anon, authenticated;
grant execute on function public.claim_notification_batch(integer) to service_role;
grant execute on function public.complete_notification(uuid, text, integer, text) to service_role;
grant execute on function public.notification_outbox_stats() to service_role;
