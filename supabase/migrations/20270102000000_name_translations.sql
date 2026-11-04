-- =============================================================================
-- Translated names of the services: services.name_translations
--
--   {"ru": "Трафик на сайт ...", "es": "Tráfico del sitio web ..."}    language code -> the name in that language
--
-- WHY A COLUMN OF ITS OWN. services.name_i18n already exists, but it is the provider's catalogue column: the catalogue publish (catalog_publish.sql)
-- writes it ({"ru": <the original Russian name>}) every time it publishes, so anything else put there would be overwritten. name_translations is
-- written only by the translator (scripts/translate-service-names.ts) and read by the storefront. The sync of the catalogue (sync-catalog, the
-- publish, the price and status updates) never names this column, so it is never touched by them: tests/name-translations.test.ts checks that.
--
-- A translation belongs to the English name it was made from. When the name changes (a provider renamed the service) the translations are
-- cleared by the trigger below, so a stale translation of an old name is never shown; the translator then makes them again. A change of anything
-- else (price, status, segments) leaves them.
--
-- The storefront reads the column (column grant, like the other storefront columns); only the service role writes it.
-- =============================================================================

alter table public.services
  add column if not exists name_translations jsonb not null default '{}'::jsonb;

alter table public.services
  drop constraint if exists services_name_translations_is_object;
alter table public.services
  add constraint services_name_translations_is_object check (jsonb_typeof(name_translations) = 'object');

comment on column public.services.name_translations is
  'Language code -> the service name in that language, written by scripts/translate-service-names.ts only. Cleared when the English name changes. The storefront shows the one of the customer''s language and falls back to name.';

create or replace function public.clear_stale_name_translations()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.name is distinct from old.name and new.name_translations is not distinct from old.name_translations then
    new.name_translations := '{}'::jsonb;
  end if;
  return new;
end;
$$;
revoke all on function public.clear_stale_name_translations() from public, anon, authenticated;

drop trigger if exists trg_services_clear_translations on public.services;
create trigger trg_services_clear_translations before update of name on public.services
  for each row execute function public.clear_stale_name_translations();

-- the translator looks for the cards that have none yet, Premium first
create index if not exists idx_services_untranslated on public.services (is_premium desc, id)
  where is_active and name_translations = '{}'::jsonb;

grant select (name_translations) on table public.services to anon, authenticated;
