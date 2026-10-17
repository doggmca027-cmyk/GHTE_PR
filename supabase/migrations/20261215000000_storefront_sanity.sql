-- =============================================================================
-- Nothing on sale that cannot be ordered or is not a service
--
--   * a card without a single active offer cannot take an order: it leaves the storefront (two RootPanel placeholders filled a gap at
--     $179,998 per 1000; their offers had already been suspended by the catalogue guard)
--   * a panel's separator row ("--------------- Real People ---------------") is not a service
-- Nothing is deleted; the variant groups follow.
-- =============================================================================

update public.services s
   set is_active = false
 where s.is_active
   and not exists (select 1 from public.provider_service_offers o where o.service_id = s.id and o.is_active);

update public.services
   set is_active = false
 where is_active and name ~ '^\s*[-=_~*]{3,}';

select public.regroup_service_variants();
select public.refresh_service_dripfeed();
