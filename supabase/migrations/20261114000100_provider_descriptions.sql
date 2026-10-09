-- Some panels send their own text about a service ("desc"). It is kept on provider_services and, for the services the sync puts on the
-- storefront by itself, copied to services.description (which customers can already read). A service an admin made by hand is not touched.

alter table public.provider_services add column description text;

create or replace function public.publish_provider_services(p_provider_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_categories integer;
  v_created    integer;
  v_updated    integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_parameter_value: rows must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  drop table if exists _pub;
  create temp table _pub on commit drop as
  select r.ps, r.platform, r.cat_key, r.cat_name, r.cat_name_ru, r.cat_sort, left(r.name, 240) as name, left(r.name_ru, 240) as name_ru,
         coalesce(r.attributes, '{}'::jsonb) as attributes, nullif(left(r.description, 2000), '') as description
    from jsonb_to_recordset(p_rows) as r(ps uuid, platform text, cat_key text, cat_name text, cat_name_ru text, cat_sort integer, name text, name_ru text, attributes jsonb, description text)
    join public.provider_services s on s.id = r.ps and s.provider_id = p_provider_id and s.is_active;

  insert into public.categories (platform_id, name, slug, sort_order, is_active, name_i18n, source_key)
  select distinct on (c.platform, c.cat_key)
         p.id, left(c.cat_name, 120), p.slug || '-' || substr(md5(c.cat_key), 1, 10), c.cat_sort, true,
         jsonb_build_object('ru', left(c.cat_name_ru, 120)), c.cat_key
    from _pub c join public.platforms p on p.slug = c.platform
   order by c.platform, c.cat_key, c.cat_sort
  on conflict (platform_id, source_key) where source_key is not null do update
     set name = excluded.name, name_i18n = excluded.name_i18n, sort_order = excluded.sort_order
   where (public.categories.name, public.categories.name_i18n, public.categories.sort_order)
         is distinct from (excluded.name, excluded.name_i18n, excluded.sort_order);
  get diagnostics v_categories = row_count;

  insert into public.services
    (category_id, name, description, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active, sort_order,
     refill_supported, name_i18n, attributes, auto_published)
  select cat.id, r.name, r.description, r.ps, greatest(round(s.rate_per_1000 * 2.5, 4), s.rate_per_1000 + 0.01), s.min_quantity, s.max_quantity, true, 0,
         s.refill_supported, jsonb_build_object('ru', r.name_ru), r.attributes, true
    from _pub r
    join public.provider_services s on s.id = r.ps
    join public.platforms p on p.slug = r.platform
    join public.categories cat on cat.platform_id = p.id and cat.source_key = r.cat_key
   where s.rate_per_1000 > 0
     and not exists (select 1 from public.provider_service_offers o where o.provider_service_id = r.ps)
     and not exists (select 1 from public.services x where x.primary_provider_service_id = r.ps);
  get diagnostics v_created = row_count;

  update public.services sv
     set name = r.name, description = r.description, name_i18n = jsonb_build_object('ru', r.name_ru), attributes = r.attributes, category_id = cat.id
    from _pub r
    join public.platforms p on p.slug = r.platform
    join public.categories cat on cat.platform_id = p.id and cat.source_key = r.cat_key
   where sv.primary_provider_service_id = r.ps and sv.auto_published
     and (sv.name, sv.description, sv.name_i18n, sv.attributes, sv.category_id)
         is distinct from (r.name, r.description, jsonb_build_object('ru', r.name_ru), r.attributes, cat.id);
  get diagnostics v_updated = row_count;

  return jsonb_build_object('categories_changed', v_categories, 'services_created', v_created, 'services_updated', v_updated);
end;
$$;

revoke all on function public.publish_provider_services(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.publish_provider_services(uuid, jsonb) to service_role;
