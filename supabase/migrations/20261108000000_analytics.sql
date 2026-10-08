-- =============================================================================
-- Phase 16: product analytics and business intelligence, inside PostgreSQL (no third party, no PII)
--
--   analytics_events          append-only event log. user_id has NO foreign key on purpose: an analytics insert must never take a
--                             lock on a core table (a foreign key check locks the referenced users row) or fail a business transaction.
--   server events             written by AFTER triggers in a sub-transaction that swallows its own errors:
--                               user_registered, first_deposit, order_placed, order_refunded, promo_applied
--                             once per user / order (unique indexes), never the content of a link, never an address or a code
--   client events             record_client_events(): the track-event Edge Function's only write path; per-user rate limit in SQL,
--                             and the server-only events above can never be written through it
--   bi_funnel / bi_revenue_daily / bi_retention / bi_top_services     read-only aggregations for the admin dashboard
--
-- Everything is service role only. Revenue figures are computed from the orders table (the money), funnels and retention
-- from the events.
-- =============================================================================

create table public.analytics_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_]{1,40}$'),
  source     text not null check (source in ('server', 'client')),
  properties jsonb not null default '{}'::jsonb check (jsonb_typeof(properties) = 'object' and octet_length(properties::text) <= 4000),
  created_at timestamptz not null default now()
);
create index idx_analytics_created_at       on public.analytics_events (created_at desc);
create index idx_analytics_name_time        on public.analytics_events (event_name, created_at);
create index idx_analytics_user_time        on public.analytics_events (user_id, created_at) where user_id is not null;
-- one registration and one first deposit per user; one placed / refunded / promo event per order
create unique index uq_analytics_once_per_user on public.analytics_events (event_name, user_id) where event_name in ('user_registered', 'first_deposit');
create unique index uq_analytics_once_per_order on public.analytics_events (event_name, (properties->>'order_id'))
  where event_name in ('order_placed', 'order_refunded', 'promo_applied');

create trigger trg_analytics_no_update before update on public.analytics_events
  for each row execute function public.forbid_mutation();
create trigger trg_analytics_no_delete before delete on public.analytics_events
  for each row execute function public.forbid_mutation();
create trigger trg_analytics_no_truncate before truncate on public.analytics_events
  for each statement execute function public.forbid_mutation();

alter table public.analytics_events enable row level security;
revoke all on table public.analytics_events from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. Server-side events (triggers)
-- -----------------------------------------------------------------------------
-- Every trigger runs its insert inside its own BEGIN ... EXCEPTION block: a failure becomes a warning, never an error in the
-- transaction that caused the event. They only INSERT into analytics_events, so no business row is locked.
create function public.trg_track_user_registered()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into analytics_events (user_id, event_name, source, properties, created_at)
    values (new.id, 'user_registered', 'server', '{}'::jsonb, new.created_at)
    on conflict do nothing;
  exception when others then
    raise warning 'analytics: user_registered skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
create trigger trg_users_track_registered after insert on public.users
  for each row execute function public.trg_track_user_registered();

create function public.trg_track_first_deposit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
begin
  begin
    select user_id into v_user from wallets where id = new.wallet_id;
    insert into analytics_events (user_id, event_name, source, properties)
    values (v_user, 'first_deposit', 'server', jsonb_build_object('amount', new.amount))
    on conflict do nothing;
  exception when others then
    raise warning 'analytics: first_deposit skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
-- a deposit counts when it is COMPLETED: inserted completed, or a pending one that settles (the unique index keeps the first)
create trigger trg_wtx_track_first_deposit_ins after insert on public.wallet_transactions
  for each row when (new.type = 'deposit' and new.status = 'completed')
  execute function public.trg_track_first_deposit();
create trigger trg_wtx_track_first_deposit_upd after update of status on public.wallet_transactions
  for each row when (new.type = 'deposit' and new.status = 'completed' and old.status is distinct from new.status)
  execute function public.trg_track_first_deposit();

create function public.trg_track_order_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if new.status = 'paid' then
      insert into analytics_events (user_id, event_name, source, properties)
      values (new.user_id, 'order_placed', 'server', jsonb_build_object(
        'order_id', new.id, 'service_id', new.service_id, 'quantity', new.quantity, 'amount', new.charge_amount,
        'tier_discount', new.tier_discount_amount, 'promo_discount', new.promo_discount_amount))
      on conflict do nothing;
    elsif new.status = 'refunded' then
      insert into analytics_events (user_id, event_name, source, properties)
      values (new.user_id, 'order_refunded', 'server', jsonb_build_object('order_id', new.id, 'service_id', new.service_id, 'amount', new.charge_amount))
      on conflict do nothing;
    end if;
  exception when others then
    raise warning 'analytics: order event skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
create trigger trg_orders_track_events after update of status on public.orders
  for each row when (old.status is distinct from new.status and new.status in ('paid', 'refunded'))
  execute function public.trg_track_order_events();

create function public.trg_track_promo_applied()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    -- the promo's id and amount, never the code text a customer typed
    insert into analytics_events (user_id, event_name, source, properties)
    values (new.user_id, 'promo_applied', 'server', jsonb_build_object('order_id', new.order_id, 'promo_code_id', new.promo_code_id, 'discount', new.discount_amount))
    on conflict do nothing;
  exception when others then
    raise warning 'analytics: promo_applied skipped: %', sqlerrm;
  end;
  return null;
end;
$$;
create trigger trg_redemptions_track_promo after insert on public.promo_code_redemptions
  for each row execute function public.trg_track_promo_applied();

-- History from before analytics existed, so funnels and retention have a past: registrations and placed orders.
insert into public.analytics_events (user_id, event_name, source, properties, created_at)
select u.id, 'user_registered', 'server', '{}'::jsonb, u.created_at from public.users u
on conflict do nothing;
insert into public.analytics_events (user_id, event_name, source, properties, created_at)
select o.user_id, 'order_placed', 'server',
       jsonb_build_object('order_id', o.id, 'service_id', o.service_id, 'quantity', o.quantity, 'amount', o.charge_amount),
       o.created_at
  from public.orders o where o.status not in ('draft', 'awaiting_payment')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. Client-side events (written only by the track-event function)
-- -----------------------------------------------------------------------------
-- The function already allow-lists names and properties; this is the second wall: server-only events are refused here, the
-- properties are size-capped by the table, and one user can write at most p_limit client events per minute whatever the number
-- of isolates serving them. Returns how many were stored.
create function public.record_client_events(p_user_id uuid, p_events jsonb, p_limit integer default 120)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used  integer;
  v_room  integer;
  v_added integer := 0;
  e       jsonb;
begin
  if p_user_id is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;
  select count(*) into v_used from analytics_events
   where user_id = p_user_id and source = 'client' and created_at > now() - interval '1 minute';
  v_room := greatest(p_limit - v_used, 0);

  for e in select * from jsonb_array_elements(p_events) loop
    exit when v_room <= 0 or v_added >= 50;
    continue when jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'name') <> 'string'
               or (e->>'name') !~ '^[a-z][a-z0-9_]{1,40}$'
               or (e->>'name') in ('user_registered', 'first_deposit', 'order_placed', 'order_refunded', 'promo_applied')
               or jsonb_typeof(coalesce(e->'properties', '{}'::jsonb)) <> 'object';
    begin
      insert into analytics_events (user_id, event_name, source, properties)
      values (p_user_id, e->>'name', 'client', coalesce(e->'properties', '{}'::jsonb));
      v_added := v_added + 1;
      v_room := v_room - 1;
    exception when others then
      raise warning 'analytics: client event skipped: %', sqlerrm;
    end;
  end loop;
  return v_added;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. BI aggregations
-- -----------------------------------------------------------------------------
create function public.bi_check_range(p_from timestamptz, p_to timestamptz)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'invalid_parameter_value: the range must have a start before its end' using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > interval '366 days' then
    raise exception 'invalid_parameter_value: the range is limited to 366 days' using errcode = 'invalid_parameter_value';
  end if;
end;
$$;

-- a) Funnel: catalog_view -> checkout_started -> order_placed. A user counts at a step only if they reached the earlier steps in
-- order (each step at or after the previous one), inside the window. Rates are of the previous step and of the first.
create function public.bi_funnel(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_viewed integer; v_checkout integer; v_ordered integer;
begin
  perform bi_check_range(p_from, p_to);
  with step1 as (
    select user_id, min(created_at) as at from analytics_events
     where event_name = 'catalog_view' and user_id is not null and created_at >= p_from and created_at < p_to group by user_id
  ), step2 as (
    select s.user_id, min(e.created_at) as at from step1 s
      join analytics_events e on e.user_id = s.user_id and e.event_name = 'checkout_started' and e.created_at >= s.at and e.created_at < p_to
     group by s.user_id
  ), step3 as (
    select s.user_id from step2 s
      join analytics_events e on e.user_id = s.user_id and e.event_name = 'order_placed' and e.created_at >= s.at and e.created_at < p_to
     group by s.user_id
  )
  select (select count(*) from step1), (select count(*) from step2), (select count(*) from step3) into v_viewed, v_checkout, v_ordered;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'steps', jsonb_build_array(
      jsonb_build_object('step', 'catalog_view', 'users', v_viewed, 'rate_from_previous', null, 'rate_from_first', case when v_viewed > 0 then 100 end),
      jsonb_build_object('step', 'checkout_started', 'users', v_checkout,
                         'rate_from_previous', case when v_viewed > 0 then round(v_checkout * 100.0 / v_viewed, 2) end,
                         'rate_from_first', case when v_viewed > 0 then round(v_checkout * 100.0 / v_viewed, 2) end),
      jsonb_build_object('step', 'order_placed', 'users', v_ordered,
                         'rate_from_previous', case when v_checkout > 0 then round(v_ordered * 100.0 / v_checkout, 2) end,
                         'rate_from_first', case when v_viewed > 0 then round(v_ordered * 100.0 / v_viewed, 2) end)));
end;
$$;

-- b) Revenue, margin and average order value per UTC day (days without orders are listed with zeros). Net of refunds:
-- an order counts for what the customer kept paying (charge - partial refund), refunded / canceled / failed orders for nothing,
-- and the provider cost shrinks in the same proportion.
create function public.bi_revenue_daily(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform bi_check_range(p_from, p_to);
  return coalesce((
    with days as (
      select d::date as day from generate_series(date_trunc('day', p_from at time zone 'utc'), date_trunc('day', (p_to - interval '1 microsecond') at time zone 'utc'), interval '1 day') d
    ), net as (
      select (o.created_at at time zone 'utc')::date as day,
             (o.charge_amount - o.partial_refund_amount) as revenue,
             case when o.charge_amount > 0 then o.cost_amount * (o.charge_amount - o.partial_refund_amount) / o.charge_amount else 0 end as cost
        from orders o
       where o.created_at >= p_from and o.created_at < p_to
         and o.status in ('paid', 'processing', 'submitted', 'in_progress', 'completed', 'partial')
    ), agg as (
      select day, count(*) as orders, sum(revenue) as revenue, sum(cost) as cost from net group by day
    )
    select jsonb_agg(jsonb_build_object(
      'day', d.day,
      'orders', coalesce(a.orders, 0),
      'revenue', round(coalesce(a.revenue, 0), 4),
      'cost', round(coalesce(a.cost, 0), 4),
      'margin', round(coalesce(a.revenue, 0) - coalesce(a.cost, 0), 4),
      'aov', case when coalesce(a.orders, 0) > 0 then round(a.revenue / a.orders, 4) end) order by d.day)
      from days d left join agg a on a.day = d.day), '[]'::jsonb);
end;
$$;

-- c) Retention by signup cohort (UTC day of users.created_at): of the users who joined that day, how many were active exactly N
-- days later (any event of theirs on that day). A cohort too young for day N shows null. Activity is only known from when
-- analytics started; earlier days read as not retained.
create function public.bi_retention(p_from timestamptz, p_to timestamptz, p_days integer[] default array[1, 7])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
begin
  perform bi_check_range(p_from, p_to);
  if p_days is null or cardinality(p_days) = 0 or cardinality(p_days) > 12 or exists (select 1 from unnest(p_days) n where n < 1 or n > 90) then
    raise exception 'invalid_parameter_value: days must be 1 to 12 values between 1 and 90' using errcode = 'invalid_parameter_value';
  end if;
  return coalesce((
    with cohorts as (
      select (u.created_at at time zone 'utc')::date as cohort, u.id as user_id from users u where u.created_at >= p_from and u.created_at < p_to
    ), sizes as (
      select cohort, count(*) as size from cohorts group by cohort
    ), active as (
      select distinct c.cohort, c.user_id, ((e.created_at at time zone 'utc')::date - c.cohort) as day_n
        from cohorts c join analytics_events e on e.user_id = c.user_id and e.created_at >= c.cohort::timestamptz
       where ((e.created_at at time zone 'utc')::date - c.cohort) = any(p_days)
    ), retained as (
      select cohort, day_n, count(*) as users from active group by cohort, day_n
    )
    select jsonb_agg(jsonb_build_object(
      'cohort', s.cohort, 'size', s.size,
      'retention', (select jsonb_agg(jsonb_build_object(
          'day', n,
          'users', case when s.cohort + n <= v_today then coalesce(r.users, 0) end,
          'rate', case when s.cohort + n <= v_today then round(coalesce(r.users, 0) * 100.0 / s.size, 2) end) order by n)
        from unnest(p_days) n left join retained r on r.cohort = s.cohort and r.day_n = n)) order by s.cohort)
      from sizes s), '[]'::jsonb);
end;
$$;

-- d) Top services by net revenue in the window (same net maths as bi_revenue_daily).
create function public.bi_top_services(p_from timestamptz, p_to timestamptz, p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform bi_check_range(p_from, p_to);
  return coalesce((
    select jsonb_agg(x order by (x->>'revenue')::numeric desc, x->>'service_id') from (
      select jsonb_build_object(
        'service_id', o.service_id, 'name', s.name, 'orders', count(*), 'units', sum(o.quantity),
        'revenue', round(sum(o.charge_amount - o.partial_refund_amount), 4),
        'margin', round(sum((o.charge_amount - o.partial_refund_amount)
                            - case when o.charge_amount > 0 then o.cost_amount * (o.charge_amount - o.partial_refund_amount) / o.charge_amount else 0 end), 4),
        'aov', round(sum(o.charge_amount - o.partial_refund_amount) / count(*), 4)) as x
        from orders o join services s on s.id = o.service_id
       where o.created_at >= p_from and o.created_at < p_to
         and o.status in ('paid', 'processing', 'submitted', 'in_progress', 'completed', 'partial')
       group by o.service_id, s.name
       order by sum(o.charge_amount - o.partial_refund_amount) desc, o.service_id
       limit least(greatest(coalesce(p_limit, 10), 1), 100)) t), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Access: service role only
-- -----------------------------------------------------------------------------
revoke all on function public.trg_track_user_registered() from public, anon, authenticated;
revoke all on function public.trg_track_first_deposit() from public, anon, authenticated;
revoke all on function public.trg_track_order_events() from public, anon, authenticated;
revoke all on function public.trg_track_promo_applied() from public, anon, authenticated;
revoke all on function public.bi_check_range(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.record_client_events(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.bi_funnel(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.bi_revenue_daily(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.bi_retention(timestamptz, timestamptz, integer[]) from public, anon, authenticated;
revoke all on function public.bi_top_services(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.record_client_events(uuid, jsonb, integer) to service_role;
grant execute on function public.bi_funnel(timestamptz, timestamptz) to service_role;
grant execute on function public.bi_revenue_daily(timestamptz, timestamptz) to service_role;
grant execute on function public.bi_retention(timestamptz, timestamptz, integer[]) to service_role;
grant execute on function public.bi_top_services(timestamptz, timestamptz, integer) to service_role;
