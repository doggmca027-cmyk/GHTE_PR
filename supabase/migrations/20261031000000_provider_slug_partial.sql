-- =============================================================================
-- providers.slug (stable, unique identifier) + provider_service_offers.supports_partial (capability flag).
-- Two additive columns. Nothing is dropped or renamed; routing, orders and the legacy primary/fallback columns of
-- services are untouched.
--
-- slug: "Secsers Mock" -> "secsers-mock". Lower case; every run of characters other than a-z, 0-9 becomes one "-"; no
-- leading/trailing "-"; at most 40 characters; "provider" when nothing is left. A clash gets "-2", "-3", ... so existing
-- providers always migrate. New providers inserted WITHOUT a slug (the seed, SQL consoles, older scripts) get one from
-- their name by the trigger below, so the NOT NULL does not break any existing insert.
-- supports_partial: whether the provider's panel can deliver part of an order and refund the rest. Default false
-- (unknown = not claimed); informational for now, the routing engine does not read it yet.
-- =============================================================================

create function public.slugify_provider_name(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(left(trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')), 40), ''), 'provider')
$$;

-- first free slug for a base: base, base-2, base-3, ...
create function public.next_provider_slug(p_base text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_slug text := p_base;
  n      integer := 1;
begin
  while exists (select 1 from providers where slug = v_slug) loop
    n := n + 1;
    v_slug := left(p_base, 40 - length(n::text) - 1) || '-' || n;
  end loop;
  return v_slug;
end;
$$;

-- 1. column (unique), 2. backfill, 3. NOT NULL
alter table public.providers add column slug text unique;

do $$
declare
  r record;
begin
  for r in select id, name from providers where slug is null order by created_at, name, id loop
    update providers set slug = next_provider_slug(slugify_provider_name(r.name)) where id = r.id;
  end loop;
end $$;

alter table public.providers alter column slug set not null;
alter table public.providers add constraint providers_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$');

-- providers created without a slug get one from their name
create function public.providers_default_slug()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.slug is null then
    new.slug := next_provider_slug(slugify_provider_name(new.name));
  end if;
  return new;
end;
$$;
create trigger trg_providers_default_slug before insert on public.providers
  for each row execute function public.providers_default_slug();

alter table public.provider_service_offers add column supports_partial boolean not null default false;

revoke all on function public.slugify_provider_name(text), public.next_provider_slug(text), public.providers_default_slug() from public, anon, authenticated;
