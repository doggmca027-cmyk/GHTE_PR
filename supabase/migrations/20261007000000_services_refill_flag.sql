-- Clients cannot read provider_services (it holds provider cost and is service_role only),
-- so the refill guarantee needed by the storefront is mirrored onto the public services row.
-- Kept in sync by the sync-catalog Edge Function.
alter table public.services
  add column refill_supported boolean not null default false;

-- Backfill for rows created before this migration.
update public.services s
   set refill_supported = ps.refill_supported
  from public.provider_services ps
 where ps.id = s.primary_provider_service_id;
