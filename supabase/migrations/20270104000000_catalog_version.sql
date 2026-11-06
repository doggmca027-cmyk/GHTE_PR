-- =============================================================================
-- catalog_version: ONE row that changes exactly when what the storefront shows changes.
--
-- WHY. The free plan of Supabase allows 5 GB of egress a month. The app reads the same public catalogue (platforms, categories, the pages of services)
-- for everyone; with a version the app and the CDN can tell "nothing changed" with a few hundred bytes instead of downloading it again:
--   * /api/catalog-version (Vercel Edge) reads this view once an hour per CDN region and says the version to the app;
--   * the app asks for the catalogue as /api/catalog?...&v=<version>: the URL changes with the version, so the CDN may keep each answer for a day
--     and Supabase is asked once per version, not once per customer;
--   * the app keeps what it downloaded in the browser together with the version it belongs to and does not download it again while the version is the
--     same (src/lib/catalog-cache.ts).
--
-- WHAT IT HASHES: the active services (id, name, price, limits, the flags the cards show, category, order, segments, translations), the active
-- categories (id, name, order, how many services) and the active platforms. Not the provider side, not the cost, not anything private. A price change
-- of one service changes the version; nothing else does.
--
-- A VIEW, not a function: the project's own rule (scripts/check-supabase.ts) lets no client role execute a function. A view runs with the rights of its
-- owner, so it needs no column grant on services; it exposes the hash and a count, nothing else.
-- =============================================================================

create or replace view public.catalog_version as
select
  md5(
    coalesce((
      select string_agg(
        md5(concat_ws(':', s.id, s.category_id, s.name, s.customer_rate_per_1000, s.min_quantity, s.max_quantity, s.refill_supported, s.dripfeed_available,
                      s.is_premium, s.sort_order, s.segments::text, s.name_i18n::text, s.name_translations::text)),
        ',' order by s.id)
      from public.services s where s.is_active), '')
    || '#' ||
    coalesce((
      select string_agg(concat_ws(':', c.id, c.name, c.sort_order, coalesce(c.active_service_count, 0)), ',' order by c.id)
      from public.categories c where c.is_active), '')
    || '#' ||
    coalesce((
      select string_agg(concat_ws(':', p.slug, p.name, p.sort_order, p.category), ',' order by p.slug)
      from public.platforms p where p.active), '')
  ) as version,
  (select count(*) from public.services s where s.is_active)::integer as services;

comment on view public.catalog_version is
  'One row: version = md5 of what the storefront shows (active services, categories, platforms), services = how many active services. Read by /api/catalog-version; changes only when the storefront changes.';

-- Supabase's default privileges give every API role everything on a new relation: take it back, then give the one thing the view is for.
revoke all on public.catalog_version from anon, authenticated;
grant select on public.catalog_version to anon, authenticated;
