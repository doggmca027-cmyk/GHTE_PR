-- =============================================================================
-- Phase 1A: Provider Manager foundation
--
-- Adds health tracking, routing toggle and capability flags to providers. Purely additive:
-- existing providers keep working exactly as before (routing off, health 'disabled'), and no
-- function that exists today (place_order, sync workers, admin RPCs) is changed or reads these
-- columns yet. The routing engine that will use them comes in a later phase.
-- =============================================================================

create type public.provider_health_enum as enum ('healthy', 'degraded', 'unavailable', 'disabled');

alter table public.providers
  add column api_version       varchar(10)  not null default 'v2',
  add column routing_enabled   boolean      not null default false,
  add column health_status     public.provider_health_enum not null default 'disabled',
  add column last_health_check timestamptz,
  add column last_balance_sync timestamptz,
  add column provider_balance  numeric(14,4) not null default 0,
  add column currency          varchar(10)  not null default 'USD',
  add constraint providers_api_version_format check (api_version ~ '^v[0-9]+$'),
  add constraint providers_currency_format    check (currency ~ '^[A-Z]{3,10}$'),
  -- a provider that is switched off can never be a routing target
  add constraint providers_routing_needs_active check (not routing_enabled or is_active);

-- Cheap lookups for the future router and for health dashboards.
create index idx_providers_routing on public.providers (priority desc) where routing_enabled and is_active;
create index idx_providers_health  on public.providers (health_status);

-- -----------------------------------------------------------------------------
-- provider_balance / last_balance_sync duplicate the older balance / balance_updated_at columns, which
-- sync-catalog already writes. Keep them in lock-step so the two pairs can never disagree:
-- whichever pair is written, the other follows (the legacy pair wins if both change at once).
-- -----------------------------------------------------------------------------
update public.providers
   set provider_balance = balance,
       last_balance_sync = balance_updated_at;

create function public.mirror_provider_balance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- a row created with only one pair filled in gets the other pair from it
    if new.provider_balance = 0 and new.balance <> 0 then
      new.provider_balance := new.balance;
    elsif new.balance = 0 and new.provider_balance <> 0 then
      new.balance := new.provider_balance;
    end if;
    new.last_balance_sync := coalesce(new.last_balance_sync, new.balance_updated_at);
    new.balance_updated_at := coalesce(new.balance_updated_at, new.last_balance_sync);
    return new;
  end if;

  if new.balance is distinct from old.balance then
    new.provider_balance := new.balance;
  elsif new.provider_balance is distinct from old.provider_balance then
    new.balance := new.provider_balance;
  end if;

  if new.balance_updated_at is distinct from old.balance_updated_at then
    new.last_balance_sync := new.balance_updated_at;
  elsif new.last_balance_sync is distinct from old.last_balance_sync then
    new.balance_updated_at := new.last_balance_sync;
  end if;
  return new;
end;
$$;
create trigger trg_providers_mirror_balance before insert or update on public.providers
  for each row execute function public.mirror_provider_balance();

-- -----------------------------------------------------------------------------
-- Capabilities: strictly 1-to-1 with providers
-- -----------------------------------------------------------------------------
create table public.provider_capabilities (
  provider_id          uuid primary key references public.providers(id) on delete cascade,
  supports_refill      boolean not null default false,
  supports_cancel      boolean not null default false,
  supports_drip_feed   boolean not null default false,
  supports_partial     boolean not null default false,
  supports_balance_api boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger trg_provider_capabilities_updated_at before update on public.provider_capabilities
  for each row execute function public.set_updated_at();

-- Existing providers: infer what we already know. Every SMM v2 panel reports Partial and has a balance
-- action; refill / cancel come from what their catalogue actually advertises. Drip-feed is unknown (false).
insert into public.provider_capabilities (provider_id, supports_refill, supports_cancel, supports_partial, supports_balance_api)
select p.id,
       coalesce((select bool_or(ps.refill_supported) from public.provider_services ps where ps.provider_id = p.id), false),
       coalesce((select bool_or(ps.cancel_supported) from public.provider_services ps where ps.provider_id = p.id), false),
       p.api_version = 'v2',
       p.api_version = 'v2'
  from public.providers p;

-- Every provider created from now on gets its capabilities row automatically (all flags false until detected).
create function public.create_provider_capabilities()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.provider_capabilities (provider_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger trg_providers_create_capabilities after insert on public.providers
  for each row execute function public.create_provider_capabilities();

-- -----------------------------------------------------------------------------
-- Access: service_role only. Clients must never read raw provider configuration.
-- RLS on, no policies, no grants (Supabase's default grants are revoked explicitly).
-- -----------------------------------------------------------------------------
alter table public.provider_capabilities enable row level security;
revoke all on table public.provider_capabilities from anon, authenticated;
revoke all on function public.create_provider_capabilities() from public, anon, authenticated;
