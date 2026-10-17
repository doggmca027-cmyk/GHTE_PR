-- =============================================================================
-- Storefront compaction: the English donor catalogues work behind the scenes again
--
-- Publishing JAP / SMMFollows / SMMProvider (2026-10-16) grew the storefront from 7,309 to 18,944 services, mostly English duplicates of
-- what the main catalogue (SMM Center, Russian names, Economy / Standard / Premium variants) already sells. The owner wants the
-- storefront to show the reference cards only; the donors serve them through offers (routing, Smart Arbitrage autopilot).
--
--   1. the donors go back to catalog_mode = 'linked_only' (RootPanel stays so): their catalogues are still synced and priced, nothing new
--      is published
--   2. a service a donor published is taken off the storefront when its PLATFORM already has reference services of a publishing provider;
--      on a platform the main catalogue does not cover at all it stays (it is the only offer there)
--   3. categories left without an active service go dark; the variant groups and the drip-feed flags are rebuilt; the autopilot is asked to
--      run again (hidden donor services are now free to back the reference cards)
-- Nothing is deleted: the services stay (orders keep pointing at them) and can be switched back on.
-- =============================================================================

update public.providers
   set catalog_mode = 'linked_only'
 where name in ('JAP', 'SMMFollows', 'SMMProvider', 'RootPanel') and catalog_mode <> 'linked_only';

with reference_platforms as (
  select distinct c.platform_id
    from public.services s
    join public.categories c on c.id = s.category_id
    join public.provider_services ps on ps.id = s.primary_provider_service_id
    join public.providers p on p.id = ps.provider_id
   where s.is_active and p.catalog_mode = 'publish'
)
update public.services s
   set is_active = false
  from public.provider_services ps, public.providers p, public.categories c
 where ps.id = s.primary_provider_service_id and p.id = ps.provider_id and c.id = s.category_id
   and p.catalog_mode = 'linked_only' and s.auto_published and s.is_active
   and c.platform_id in (select platform_id from reference_platforms);

update public.categories c
   set is_active = false
 where c.is_active and c.source_key like 'canonical:%'
   and not exists (select 1 from public.services s where s.category_id = c.id and s.is_active);

select public.regroup_service_variants();
select public.refresh_service_dripfeed();
update public.arbitrage_state set requested_at = now() where id = 1;
