-- =============================================================================
-- Premium segments of the storefront
--
-- A card gets 0..3 segments from its name; the app shows them as chips and a customer taps one to see only those cards:
--   premium      "Premium / real"      the name says HQ, UHQ, real, premium, verified, high quality
--   guaranteed   "With guarantee"      refill, guarantee, non-drop, no drop, lifetime, R30...
--   safe         "Safe growth"         slow, organic, natural, gradual, human-like, or a small daily speed (up to 5K a day)
-- An explicit "no refill" or "bot" in the name takes premium and guaranteed back (the same rule as offer-quality.ts, so routing, price and
-- segment always agree about what "quality" means). Safe is also taken back by "bot".
--
-- On the 7127 cards of 2026-11-02: premium 1280, guaranteed 3604, safe 1498; premium and guaranteed 767, all three 240, none 2519.
-- Nothing here changes a price, a card or a category. services.segments is a storefront column (column grant to anon and authenticated, like the
-- others); the segment of a new or renamed card is computed by a trigger.
-- =============================================================================

alter table public.services
  add column if not exists segments text[] not null default '{}';

create or replace function public.service_segments(p_name text)
returns text[]
language sql
immutable
as $$
  select array_remove(array[
    case when not public.service_name_no_guarantee(p_name)
          and coalesce(p_name, '') ~* '\y(hq|uhq|premium|real|real users?|real people|verified|high quality|ultra high quality)\y' then 'premium' end,
    case when not public.service_name_no_guarantee(p_name)
          and coalesce(p_name, '') ~* 'refill|guarantee|\ynon[\s-]*drop\y|\yno[\s-]*drops?\y|\ylifetime\y|\yr\d{2,3}\y|warranty' then 'guaranteed' end,
    case when coalesce(p_name, '') ~* '\y(slow|organic|natural|gradual|safe|human[\s-]*like)\y|speed:?\s*(very\s+)?slow|\y[1-9]\d{0,2}\s*(/|per\s*)day\y|\y[1-5]k\s*(/|per\s*)day\y'
          and coalesce(p_name, '') !~* 'bot' then 'safe' end
  ], null);
$$;

revoke all on function public.service_segments(text) from public, anon, authenticated;
grant execute on function public.service_segments(text) to service_role;

-- the cards that exist
update public.services set segments = public.service_segments(name) where segments is distinct from public.service_segments(name);

-- a new or renamed card gets its segments by itself
create or replace function public.set_service_segments()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.segments := public.service_segments(new.name);
  return new;
end;
$$;
revoke all on function public.set_service_segments() from public, anon, authenticated;

drop trigger if exists trg_services_segments on public.services;
create trigger trg_services_segments before insert or update of name on public.services
  for each row execute function public.set_service_segments();

create index if not exists idx_services_segments on public.services using gin (segments) where is_active;

-- services has column-level grants: the storefront reads the segments
grant select (segments) on table public.services to anon, authenticated;
