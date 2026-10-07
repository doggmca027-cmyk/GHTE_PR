-- =============================================================================
-- Phase 8: observability
--
-- 1. worker_heartbeats: the HTTP workers started by pg_cron (provider-health-monitor, sync-order-status, sync-catalog)
--    report here when a run ends. pg_cron's own log only proves the request was SENT (pg_net is asynchronous); the heartbeat
--    proves the function actually ran to the end, or says how it failed (short, sanitized text).
-- 2. get_system_health(hours): one read-only snapshot for the admin "System Health" tab: stuck orders, queue depths, open
--    reconciliation cases, provider API health from provider_health_log, treasury, worker heartbeats and the pg_cron
--    pulse (when pg_cron is installed and readable; local test databases have none, then `cron` is null).
-- Service role only. The admin-observability Edge Function checks the JWT and users.is_admin before calling it.
-- =============================================================================

create table public.worker_heartbeats (
  worker           text primary key check (length(worker) between 1 and 60),
  last_run_at      timestamptz not null default now(),
  last_success_at  timestamptz,
  last_error_at    timestamptz,
  last_error       text check (last_error is null or length(last_error) <= 300),
  last_duration_ms integer check (last_duration_ms is null or last_duration_ms >= 0),
  runs             bigint not null default 0,
  failures         bigint not null default 0
);
alter table public.worker_heartbeats enable row level security;
revoke all on table public.worker_heartbeats from anon, authenticated;

create function public.record_worker_heartbeat(p_worker text, p_ok boolean, p_error text default null, p_duration_ms integer default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into worker_heartbeats as w (worker, last_run_at, last_success_at, last_error_at, last_error, last_duration_ms, runs, failures)
  values (left(p_worker, 60), now(), case when p_ok then now() end, case when not p_ok then now() end,
          case when not p_ok then left(coalesce(p_error, 'unknown error'), 300) end, greatest(p_duration_ms, 0), 1, case when p_ok then 0 else 1 end)
  on conflict (worker) do update set
    last_run_at      = now(),
    last_success_at  = case when p_ok then now() else w.last_success_at end,
    last_error_at    = case when not p_ok then now() else w.last_error_at end,
    last_error       = case when not p_ok then left(coalesce(p_error, 'unknown error'), 300) else w.last_error end,
    last_duration_ms = greatest(p_duration_ms, 0),
    runs             = w.runs + 1,
    failures         = w.failures + case when p_ok then 0 else 1 end
$$;

create function public.get_system_health(p_hours integer default 24)
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
    'cron_error', v_cron_error
  );
end;
$$;

revoke all on function public.record_worker_heartbeat(text, boolean, text, integer), public.get_system_health(integer) from public, anon, authenticated;
grant execute on function public.record_worker_heartbeat(text, boolean, text, integer), public.get_system_health(integer) to service_role;
