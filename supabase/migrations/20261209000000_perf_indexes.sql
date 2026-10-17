-- =============================================================================
-- Indexes for the storefront's hottest reads
--
-- A category page asks for the active MAIN services of a category in the order sort_order, customer_rate_per_1000, id (services.ts
-- fetchCategoryServices). idx_services_category (category_id, sort_order) WHERE is_active found them but left the rest of the order and the
-- "main service" filter to a sort; this index answers the page straight from the index, in order.
--
-- orders had two identical indexes (idx_orders_sync_active from 20261009000000 and idx_orders_sync_inflight from 20261111000100: both
-- (updated_at) for submitted / in_progress / processing). Every order write paid for both; one is enough.
-- =============================================================================

create index if not exists idx_services_category_listing
  on public.services (category_id, sort_order, customer_rate_per_1000, id)
  where is_active and parent_service_id is null;

drop index if exists public.idx_orders_sync_inflight;
