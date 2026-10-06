-- =============================================================================
-- Phase 1D: Admin pricing view
--
-- Read-only grid of active services with the cost of the offer the routing engine would pick today:
-- among active offers of active, routing-enabled, healthy providers (and active provider services),
-- the highest routing_score wins, the lowest cost breaks ties. No pricing math lives here: prices are
-- (re)calculated by the admin-pricing Edge Function with _shared/price-engine.ts.
-- =============================================================================
create function public.get_admin_pricing_view()
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
      'platform', c.platform,
      'customer_rate_per_1000', s.customer_rate_per_1000,
      'best_offer_cost', b.cost_per_1000,
      'margin_absolute', case when b.cost_per_1000 is null then null
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end
    ) order by c.platform, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    left join lateral (
      select o.cost_per_1000
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active
         and ps.is_active
         and p.is_active and p.routing_enabled and p.health_status = 'healthy'
       order by o.routing_score desc, o.cost_per_1000 asc
       limit 1
    ) b on true
    where s.is_active), '[]'::jsonb);
end;
$$;

revoke all on function public.get_admin_pricing_view() from public, anon;
grant execute on function public.get_admin_pricing_view() to authenticated, service_role;
