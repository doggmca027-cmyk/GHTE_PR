-- =============================================================================
-- Every provider is an equal partner: no primary provider, no donors in pricing and routing
--
-- SMM Center, JAP, SMMFollows, RootPanel, SMMProvider, ... form one pool. A card's price and its order both follow the CHEAPEST working
-- offer of the card, whoever serves it:
--   * the storefront price (customer_rate_per_1000, cost_basis_per_1000) is built on the cheapest priceable offer (service-cost.ts; the
--     catalogue sync re-prices each provider's cards in its run, so the cards with a cheaper offer get their new price within one rotation)
--   * routing ranks by cost x reliability penalty only (routing.ts): routing_score breaks a tie and no longer gives the provider a card was
--     published from (score 100 by default) a 1 % edge over the linked ones (score 0)
--   * the provider's balance plays no part in either: an order its provider cannot pay for yet waits in the order hub (20261218000000)
--
-- Here: the admin pricing grid shows the offer routing would pick by the same rule.
-- =============================================================================

create or replace function public.get_admin_pricing_view()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_margin numeric(14,4);
begin
  perform require_admin();
  select discount_min_margin_per_1000 into v_margin from platform_settings where id = 1;
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
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end,
      -- the most any combination of tier and promo discount can take off the list price before cost + minimum margin
      'max_discount_percent', case when base.cost_per_1000 is null or s.customer_rate_per_1000 <= 0 then null
                                   else round(greatest(s.customer_rate_per_1000 - base.cost_per_1000 - v_margin, 0) / s.customer_rate_per_1000 * 100, 2) end
    ) order by pl.sort_order, pl.slug, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    join platforms pl on pl.id = c.platform_id
    left join lateral (
      select o.cost_per_1000,
             round(o.cost_per_1000 * p.reliability_penalty_multiplier, 4) as effective_cost
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active
         and ps.is_active
         and p.is_active and p.routing_enabled and p.health_status = 'healthy'
       order by o.cost_per_1000 * p.reliability_penalty_multiplier asc, o.routing_score desc, o.id asc
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
