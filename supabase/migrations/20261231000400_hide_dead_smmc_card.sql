-- =============================================================================
-- The last card of SMM Center leaves the storefront
--
-- 20261231000100 gave every active card that carried the code of SMM Center (SMMC) the article of the panel service that serves it today. One card had
-- no working offer to take an article from: "Facebook Profile Followers [refill: lifetime]" (FB-OTH-STD-SMMC27897), whose only offer is SMM Center's,
-- switched off with the provider. Nobody can order it, so it goes: it is switched off, not deleted (no order went through it, but a card is never
-- deleted from here).
--
-- Found by its article (SMMC) and by having no working offer (the offer is on, the provider is on and takes orders, the panel still lists the service),
-- so a card that has a donor is never hidden by this.
-- =============================================================================

update public.services s
   set is_active = false
 where s.is_active
   and s.sku ~ '-SMMC[0-9A-Z]'
   and not exists (
     select 1
       from public.provider_service_offers o
       join public.providers p on p.id = o.provider_id and p.is_active and p.routing_enabled
       join public.provider_services ps on ps.id = o.provider_service_id and ps.is_active
      where o.service_id = s.id and o.is_active);
