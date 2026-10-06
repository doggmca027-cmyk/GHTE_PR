-- =============================================================================
-- Phase 1B: Provider offers (1 normalized service -> N provider offers)
--
-- Purely additive. services.primary_provider_service_id / fallback_provider_service_id stay exactly as they
-- are and place_order still reads them; the routing engine (Phase 1C) will switch to this table and only
-- then are those two columns deprecated. Until then this table is a backfilled snapshot, not yet kept in
-- sync with later edits of those two columns.
-- =============================================================================

-- An offer's provider must be the provider that owns the referenced provider_service. A composite FK makes
-- that impossible to get wrong (it also keeps ON DELETE CASCADE from provider_services).
alter table public.provider_services
  add constraint ps_id_provider_unique unique (id, provider_id);

create table public.provider_service_offers (
  id                  uuid primary key default gen_random_uuid(),
  service_id          uuid not null references public.services(id) on delete cascade,
  provider_id         uuid not null references public.providers(id) on delete cascade,
  provider_service_id uuid not null,
  cost_per_1000       numeric(14,4) not null,
  min_quantity        integer not null,
  max_quantity        integer not null,
  refill_supported    boolean not null default false,
  cancel_supported    boolean not null default false,
  is_active           boolean not null default true,
  routing_score       integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pso_unique unique (service_id, provider_id, provider_service_id),
  constraint pso_provider_service_fk foreign key (provider_service_id, provider_id)
    references public.provider_services (id, provider_id) on delete cascade,
  constraint pso_cost_nonneg check (cost_per_1000 >= 0),
  constraint pso_min_positive check (min_quantity > 0),
  constraint pso_qty_range check (max_quantity >= min_quantity)
);
create index idx_pso_service  on public.provider_service_offers (service_id, routing_score desc) where is_active;
create index idx_pso_provider on public.provider_service_offers (provider_id);
create index idx_pso_provider_service on public.provider_service_offers (provider_service_id);
create trigger trg_pso_updated_at before update on public.provider_service_offers
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Backfill: every service's primary and (if any) fallback provider service becomes an active offer.
-- Cost, limits and flags are the provider's own (provider_services). routing_score keeps today's behaviour
-- visible: primary 100, fallback 0 (higher wins).
-- -----------------------------------------------------------------------------
insert into public.provider_service_offers
  (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity,
   refill_supported, cancel_supported, is_active, routing_score)
select s.id, ps.provider_id, ps.id, ps.rate_per_1000, ps.min_quantity, ps.max_quantity,
       ps.refill_supported, ps.cancel_supported, true, o.score
  from public.services s
  cross join lateral (values (s.primary_provider_service_id, 100),
                             (s.fallback_provider_service_id, 0)) as o(ps_id, score)
  join public.provider_services ps on ps.id = o.ps_id
on conflict (service_id, provider_id, provider_service_id) do nothing;

-- -----------------------------------------------------------------------------
-- Access: service_role only. Clients must never see provider costs or provider ids.
-- RLS on, no policies, no client grants.
-- -----------------------------------------------------------------------------
alter table public.provider_service_offers enable row level security;
revoke all on table public.provider_service_offers from anon, authenticated;
