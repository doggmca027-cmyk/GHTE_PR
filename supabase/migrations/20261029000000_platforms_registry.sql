-- =============================================================================
-- Platform registry: the canonical list of platforms (foundation of the marketplace).
--
-- Until now a platform was only the enum value public.platform_enum ('telegram', 'instagram', 'tiktok', 'youtube',
-- 'twitter', 'facebook', 'other') on categories.platform / price_rules.platform, mirrored by hard-coded lists in the
-- frontend and Edge Functions. Adding a platform meant a migration plus code changes in several places.
--
-- This table becomes the source of truth for WHICH platforms exist and how they are shown. It is additive:
--   * categories.platform / price_rules.platform keep the enum (nothing that references orders changes);
--   * every enum value has a row here with the SAME slug, so platforms.slug = categories.platform::text joins today;
--   * new platforms (spotify, discord, ...) live here first; moving categories to a platform_id FK is a later phase.
--
-- Access:
--   * read: anyone sees active platforms; admins also see inactive ones (RLS);
--   * write: admins only. Client roles get no write grant (project invariant: every write goes through an audited
--     function); admins write through admin_upsert_platform(). The admin-only write policies below are kept as a
--     second line of defense, should a write grant ever be added.
-- =============================================================================

create table public.platforms (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  name       text not null check (length(trim(name)) between 1 and 60),
  icon       text check (icon is null or length(icon) <= 300),
  category   text not null check (category in ('social', 'messaging', 'video', 'music', 'community', 'web', 'other')),
  active     boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_platforms_active_sort on public.platforms (sort_order, name) where active;
create trigger trg_platforms_updated_at before update on public.platforms
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Seed. The first seven slugs are exactly the platform_enum values (backward compatible with categories / price rules).
-- `icon` is an icon name for the frontend (the UI keeps its current icons until the platform UI phase).
-- -----------------------------------------------------------------------------
insert into public.platforms (slug, name, icon, category, sort_order) values
  ('telegram',  'Telegram',        'telegram',  'messaging', 10),
  ('instagram', 'Instagram',       'instagram', 'social',    20),
  ('tiktok',    'TikTok',          'tiktok',    'video',     30),
  ('youtube',   'YouTube',         'youtube',   'video',     40),
  ('twitter',   'X (Twitter)',     'twitter',   'social',    50),
  ('facebook',  'Facebook',        'facebook',  'social',    60),
  ('spotify',   'Spotify',         'spotify',   'music',     70),
  ('discord',   'Discord',         'discord',   'community', 80),
  ('reddit',    'Reddit',          'reddit',    'community', 90),
  ('website',   'Website Traffic', 'globe',     'web',       100),
  ('other',     'Other',           'sparkles',  'other',     1000);

-- -----------------------------------------------------------------------------
-- Row level security
-- -----------------------------------------------------------------------------
alter table public.platforms enable row level security;
revoke all on table public.platforms from anon, authenticated;
grant select on table public.platforms to anon, authenticated;

create policy platforms_select_active on public.platforms
  for select to anon using (active);

-- the subquery reads the caller's own users row (allowed by users_select_own)
create policy platforms_select_active_or_admin on public.platforms
  for select to authenticated
  using (active or exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin and not u.is_banned));

create policy platforms_insert_admin on public.platforms
  for insert to authenticated
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin and not u.is_banned));
create policy platforms_update_admin on public.platforms
  for update to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin and not u.is_banned))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin and not u.is_banned));
create policy platforms_delete_admin on public.platforms
  for delete to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.is_admin and not u.is_banned));

-- -----------------------------------------------------------------------------
-- Admin write path (audited). Creates or updates a platform by slug. There is no delete: a platform is switched off
-- (active = false), so anything that still references it keeps working.
-- -----------------------------------------------------------------------------
create function public.admin_upsert_platform(
  p_slug       text,
  p_name       text,
  p_category   text,
  p_icon       text default null,
  p_active     boolean default true,
  p_sort_order integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  v_old   platforms%rowtype;
  v_new   platforms%rowtype;
begin
  select * into v_old from platforms where slug = lower(trim(p_slug));
  insert into platforms (slug, name, icon, category, active, sort_order)
  values (lower(trim(p_slug)), trim(p_name), nullif(trim(p_icon), ''), p_category, coalesce(p_active, true), coalesce(p_sort_order, 0))
  on conflict (slug) do update
     set name = excluded.name, icon = excluded.icon, category = excluded.category,
         active = excluded.active, sort_order = excluded.sort_order
  returning * into v_new;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'upsert_platform', v_new.slug, jsonb_build_object(
    'before', case when v_old.id is null then null else to_jsonb(v_old) - 'created_at' - 'updated_at' end,
    'after', to_jsonb(v_new) - 'created_at' - 'updated_at'));
  return to_jsonb(v_new);
end;
$$;

revoke all on function public.admin_upsert_platform(text, text, text, text, boolean, integer) from public, anon;
grant execute on function public.admin_upsert_platform(text, text, text, text, boolean, integer) to authenticated, service_role;
