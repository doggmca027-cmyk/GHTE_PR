-- =============================================================================
-- One source of truth for platforms: categories.platform / price_rules.platform (platform_enum) -> platform_id (FK).
--
-- Strict order, one transaction (a failure anywhere leaves the old schema exactly as it was):
--   1. add platform_id (nullable)            2. link every row by slug (platforms.slug = platform::text)
--   3. refuse to go on if any row is unlinked   4. categories.platform_id NOT NULL, foreign keys
--   5. drop the enum columns (their indexes and the single-scope check go with them) and recreate those
--   6. the two admin RPCs that read the column now join platforms (same JSON shape: 'platform' is still the slug)
--   7. drop platform_enum (fails loudly if anything still uses it)
--
-- price_rules.platform_id stays NULLABLE on purpose: NULL means "this rule does not target a platform"
-- (it targets a service, a category, or is global). Orders are not touched: they reach a platform through
-- services -> categories only.
-- =============================================================================

-- 1. new columns
alter table public.categories  add column platform_id uuid;
alter table public.price_rules add column platform_id uuid;

-- 2. link by slug
update public.categories c  set platform_id = p.id from public.platforms p where p.slug = c.platform::text;
update public.price_rules r set platform_id = p.id from public.platforms p where p.slug = r.platform::text;

-- 3. nothing may be left behind (every enum value has a platforms row since 20261029000000)
do $$
declare
  v_cat integer;
  v_rule integer;
begin
  select count(*) into v_cat from public.categories where platform_id is null;
  select count(*) into v_rule from public.price_rules where platform is not null and platform_id is null;
  if v_cat > 0 or v_rule > 0 then
    raise exception 'platform migration aborted: % categories and % price rules have no matching platforms row', v_cat, v_rule;
  end if;
end $$;

-- 4. constraints
alter table public.categories alter column platform_id set not null;
alter table public.categories  add constraint categories_platform_id_fkey  foreign key (platform_id) references public.platforms(id) on delete restrict;
alter table public.price_rules add constraint price_rules_platform_id_fkey foreign key (platform_id) references public.platforms(id) on delete restrict;

-- 5. drop the enum columns, then recreate what depended on them
alter table public.price_rules drop constraint price_rules_single_scope;
alter table public.categories  drop column platform;
alter table public.price_rules drop column platform;
alter table public.price_rules add constraint price_rules_single_scope check (num_nonnulls(platform_id, category_id, service_id) <= 1);
create index idx_categories_platform_active on public.categories (platform_id, sort_order) where is_active;
create index idx_price_rules_lookup on public.price_rules (platform_id, priority desc) where is_active;

-- 6. RPCs that read the old column (output unchanged: 'platform' is the slug; 'platform_id' is new)
create or replace function public.admin_list_price_rules()
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
      'id', r.id, 'name', r.name, 'type', r.type, 'value', r.value, 'is_active', r.is_active, 'priority', r.priority,
      'platform', pl.slug, 'platform_id', r.platform_id, 'min_rate', r.min_rate, 'max_rate', r.max_rate,
      'scope', case when r.service_id is not null then 'Service: ' || coalesce((select name from services where id = r.service_id), '?')
                    when r.category_id is not null then 'Category: ' || coalesce((select name from categories where id = r.category_id), '?')
                    when r.platform_id is not null then 'Platform: ' || pl.slug
                    else 'Global' end
    ) order by r.priority desc, r.name)
    from price_rules r left join platforms pl on pl.id = r.platform_id), '[]'::jsonb);
end;
$$;

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
      'margin_absolute', case when b.cost_per_1000 is null then null
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end
    ) order by pl.sort_order, pl.slug, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    join platforms pl on pl.id = c.platform_id
    left join lateral (
      select o.cost_per_1000, round(o.cost_per_1000 * p.reliability_penalty_multiplier, 4) as effective_cost
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
    where s.is_active), '[]'::jsonb);
end;
$$;

-- 7. the enum has no users left
drop type public.platform_enum;
