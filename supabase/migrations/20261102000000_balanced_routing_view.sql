-- =============================================================================
-- Phase 7: the admin pricing grid follows the Balanced routing engine
--
-- Functions only: no table changes (services.primary_provider_service_id / fallback_provider_service_id stay as they are).
-- The router (supabase/functions/_shared/routing.ts) ranks offers by
--     effective_cost = cost_per_1000 * reliability_penalty * (1 - least(routing_score, 1000) / 10000)
-- and the price is built on the CHEAPEST offer that can receive an order (service-cost.ts), so the grid now shows both:
--   best_offer_*      the offer routing would pick first (healthy providers only), same formula as the router
--   base_offer_cost   the cheapest offer that can receive an order, health ignored: the number the markup is applied to
-- =============================================================================

create or replace function public.get_admin_pricing_view()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'service_id', s.id,
      'name', s.name,
      'category_id', c.id,
      'category', c.name,
      'platform', pl.slug,
      'customer_rate_per_1000', s.customer_rate_per_1000,
      'best_offer_cost', b.cost_per_1000,
      'best_offer_effective_cost', b.effective_cost,
      'base_offer_cost', base.cost_per_1000,
      'margin_absolute', case when b.cost_per_1000 is null then null
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end
    ) order by pl.sort_order, pl.slug, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    join platforms pl on pl.id = c.platform_id
    left join lateral (
      select o.cost_per_1000,
             round(o.cost_per_1000 * p.reliability_penalty_multiplier * (1 - least(greatest(o.routing_score, 0), 1000) * 0.0001), 4) as effective_cost
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active
         and ps.is_active
         and p.is_active and p.routing_enabled and p.health_status = 'healthy'
       order by o.cost_per_1000 * p.reliability_penalty_multiplier * (1 - least(greatest(o.routing_score, 0), 1000) * 0.0001) asc,
                o.routing_score desc, o.id asc
       limit 1
    ) b on true
    left join lateral (
      select min(o.cost_per_1000) as cost_per_1000
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active and ps.is_active and p.is_active and p.routing_enabled
    ) base on true
    where s.is_active), '[]'::jsonb);
end;
$$;

revoke all on function public.get_admin_pricing_view() from public, anon;
grant execute on function public.get_admin_pricing_view() to authenticated, service_role;
