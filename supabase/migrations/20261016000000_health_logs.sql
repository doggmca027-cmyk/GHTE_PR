-- =============================================================================
-- Phase 1E: provider health log (SLA tracking)
--
-- One row per health check made by the provider-health-monitor worker. Rows are append-only data for
-- uptime reporting; routing never reads this table (it reads providers.health_status). Service role only:
-- RLS on, no policies, no client grants. `error_kind` is a short machine label (e.g. "timeout",
-- "http 503"), never a provider response body.
--
-- Volume: one row per provider per run (every minute = ~1,440 per provider per day). Prune old rows
-- on a schedule if the table grows, e.g. delete from provider_health_log where checked_at < now() - interval '90 days'.
-- =============================================================================
create table public.provider_health_log (
  id              bigint generated always as identity primary key,
  provider_id     uuid not null references public.providers(id) on delete cascade,
  status          public.provider_health_enum not null,
  previous_status public.provider_health_enum not null,
  latency_ms      integer check (latency_ms is null or latency_ms >= 0),
  error_kind      text,
  checked_at      timestamptz not null default now()
);
create index idx_health_log_provider on public.provider_health_log (provider_id, checked_at desc);

alter table public.provider_health_log enable row level security;
revoke all on table public.provider_health_log from anon, authenticated;
