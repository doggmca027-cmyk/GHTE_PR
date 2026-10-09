-- =============================================================================
-- Phase 21 (1/2): customers can no longer read the platform's internals through PostgREST
--
-- The finding: `authenticated` had a table-wide SELECT on orders, order_status_history and services (the RLS policies limit the
-- ROWS, not the columns). Any signed-in customer could request, for their own orders, cost_amount, profit_amount, the provider
-- and its order id, the routing snapshot, internal notes in error_message ("needs_reconciliation: timeout ..."), and the
-- provider-service ids of every service. Row level security does not hide columns; column privileges do.
--
-- The fix is an ALLOW-LIST: the table-wide grant is revoked and only the columns the app needs are granted back. A column added
-- to one of these tables later is private until someone grants it on purpose (a table-level GRANT is never implied for new
-- columns of a table that only has column grants). A query that names a private column, or `select=*`, is now refused with
-- "permission denied". The app already names its columns (src/services/api/orders.ts, services.ts), which a test pins.
--
-- Not affected: the Edge Functions (service role) and SECURITY DEFINER functions (they run as the owner); the admin screens read
-- through those.
-- =============================================================================

-- ---- orders: what a customer sees of their own order -------------------------------------------------------------------
revoke select on table public.orders from anon, authenticated;
grant select (id, user_id, service_id, target_url, quantity, charge_amount, status, start_count, remains, partial_refund_amount, created_at, updated_at)
  on table public.orders to authenticated;
-- user_id is needed by the row policy (orders_select_own); the rest is what the order card shows.

-- ---- order_status_history: the transition, never the internal comment ("Provider rejected order", admin reasons ...) ----
revoke select on table public.order_status_history from anon, authenticated;
grant select (id, order_id, old_status, new_status, created_at) on table public.order_status_history to authenticated;

-- ---- services: the storefront, without which provider service sits behind it ------------------------------------------
revoke select on table public.services from anon, authenticated;
grant select (id, category_id, name, description, customer_rate_per_1000, min_quantity, max_quantity, is_active, sort_order, created_at, updated_at, refill_supported)
  on table public.services to anon, authenticated;
-- is_active is granted because the catalog query filters on it (a WHERE on a column needs the privilege too).
