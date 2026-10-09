-- =============================================================================
-- Publishing a provider's catalogue on the storefront, kept in step with the provider every hour.
--
--   * provider_services.service_type   the panel's type of service ("Default", "Package", "Custom Comments", ...). The order form
--                                      collects a link and a quantity, so only "Default" services are put on sale.
--   * services.name_i18n / attributes   the original (Russian) name and the structured facts of the service (refill, start time, speed,
--                                      countries, drops) the app turns into a description in the customer's own language.
--   * services.auto_published           created and kept up to date by the sync (an admin's own services are never overwritten).
--   * categories.name_i18n / source_key / active_service_count
--                                      the original name, the panel category it came from, and how many active services it holds
--                                      (kept by triggers, so the storefront lists categories without counting 10 000 services).
--   * publish_provider_services()       one set-based statement per chunk: categories, new services (priced like the default rule, the
--                                      sync re-prices them from the real rules in the same run), and refreshed names / facts.
--   * four more platforms the panel sells for (Behance, Binance Square, Mentimeter, Spinnin Records).
-- Service role only; clients read the tables through their column grants, as before.
-- =============================================================================

insert into public.platforms (slug, name, icon, category, sort_order, active) values
  ('behance',         'Behance',         'behance',         'community', 192, true),
  ('binance-square',  'Binance Square',  'binance-square',  'social',    193, true),
  ('mentimeter',      'Mentimeter',      'mentimeter',      'web',       194, true),
  ('spinnin-records', 'Spinnin Records', 'spinnin-records', 'music',     195, true)
on conflict (slug) do nothing;

alter table public.provider_services add column service_type text not null default 'Default';

alter table public.services
  add column name_i18n      jsonb   not null default '{}'::jsonb,
  add column attributes     jsonb   not null default '{}'::jsonb,
  add column auto_published boolean not null default false;

alter table public.categories
  add column name_i18n            jsonb   not null default '{}'::jsonb,
  add column source_key           text,
  add column active_service_count integer not null default 0 check (active_service_count >= 0);
create unique index uq_categories_source on public.categories (platform_id, source_key) where source_key is not null;

-- services is an allow-list (20261111000000_rls_hardening.sql): the two new columns the app reads are granted on purpose,
-- auto_published stays private.
grant select (name_i18n, attributes) on table public.services to anon, authenticated;

-- -----------------------------------------------------------------------------
-- active_service_count: recounted for the categories a statement touched
-- -----------------------------------------------------------------------------
create function public.recount_categories(p_ids uuid[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.categories c
     set active_service_count = n.cnt
    from (select u.id, (select count(*) from public.services s where s.category_id = u.id and s.is_active)::integer as cnt
            from unnest(p_ids) as u(id)) n
   where c.id = n.id and c.active_service_count is distinct from n.cnt
$$;

create function public.trg_services_recount_ins()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.recount_categories((select coalesce(array_agg(distinct category_id), '{}') from new_rows));
  return null;
end;
$$;
create function public.trg_services_recount_upd()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.recount_categories((select coalesce(array_agg(distinct x.category_id), '{}')
    from (select category_id from new_rows union select category_id from old_rows) x));
  return null;
end;
$$;
create function public.trg_services_recount_del()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.recount_categories((select coalesce(array_agg(distinct category_id), '{}') from old_rows));
  return null;
end;
$$;
create trigger trg_services_recount_ins after insert on public.services
  referencing new table as new_rows for each statement execute function public.trg_services_recount_ins();
create trigger trg_services_recount_upd after update on public.services
  referencing old table as old_rows new table as new_rows for each statement execute function public.trg_services_recount_upd();
create trigger trg_services_recount_del after delete on public.services
  referencing old table as old_rows for each statement execute function public.trg_services_recount_del();

select public.recount_categories(coalesce((select array_agg(id) from public.categories), '{}'));

-- -----------------------------------------------------------------------------
-- publish_provider_services
-- -----------------------------------------------------------------------------
-- p_rows: [{ ps, platform, cat_key, cat_name, cat_name_ru, cat_sort, name, name_ru, attributes }] built by _shared/catalog-publish.ts
-- (only services that qualify to be sold: plain "Default" type, a real price, sane limits).
--   * a category is created per (platform, cat_key) and kept up to date (name, original name, order);
--   * a provider service that has no storefront service yet gets one, active, priced at the default markup (+150 %, never less than
--     cost + 0.01 per 1000); the offer comes from the bridge trigger. The sync re-prices it from the real price rules right after;
--   * a service the sync published earlier gets its name, original name, facts and category refreshed;
--   * a service an admin made by hand (auto_published = false) is never touched.
create function public.publish_provider_services(p_provider_id uuid, p_rows jsonb)
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
         coalesce(r.attributes, '{}'::jsonb) as attributes
    from jsonb_to_recordset(p_rows) as r(ps uuid, platform text, cat_key text, cat_name text, cat_name_ru text, cat_sort integer, name text, name_ru text, attributes jsonb)
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
    (category_id, name, primary_provider_service_id, customer_rate_per_1000, min_quantity, max_quantity, is_active, sort_order,
     refill_supported, name_i18n, attributes, auto_published)
  select cat.id, r.name, r.ps, greatest(round(s.rate_per_1000 * 2.5, 4), s.rate_per_1000 + 0.01), s.min_quantity, s.max_quantity, true, 0,
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
     set name = r.name, name_i18n = jsonb_build_object('ru', r.name_ru), attributes = r.attributes, category_id = cat.id
    from _pub r
    join public.platforms p on p.slug = r.platform
    join public.categories cat on cat.platform_id = p.id and cat.source_key = r.cat_key
   where sv.primary_provider_service_id = r.ps and sv.auto_published
     and (sv.name, sv.name_i18n, sv.attributes, sv.category_id)
         is distinct from (r.name, jsonb_build_object('ru', r.name_ru), r.attributes, cat.id);
  get diagnostics v_updated = row_count;

  return jsonb_build_object('categories_changed', v_categories, 'services_created', v_created, 'services_updated', v_updated);
end;
$$;

revoke all on function public.publish_provider_services(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.publish_provider_services(uuid, jsonb) to service_role;
revoke all on function public.recount_categories(uuid[]) from public, anon, authenticated;
revoke all on function public.trg_services_recount_ins(), public.trg_services_recount_upd(), public.trg_services_recount_del() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- The catalogue is re-checked every hour (it was every 6 hours): a service the provider drops is switched off, a price or limit
-- change is followed, a new service appears. The job is the one created by supabase/cron.example.sql; only its schedule changes.
-- -----------------------------------------------------------------------------
do $$
declare
  v_job bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      select jobid into v_job from cron.job where jobname = 'sync-catalog';
      if v_job is not null then
        perform cron.alter_job(v_job, schedule => '0 * * * *');
      end if;
    exception when others then
      raise warning 'sync-catalog schedule was not changed: %', sqlerrm;
    end;
  end if;
end;
$$;
