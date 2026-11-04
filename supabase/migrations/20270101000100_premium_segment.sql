-- =============================================================================
-- Two-level catalogue: the mass market and Premium (safe growth)
--
-- A card is PREMIUM when its name promises quality: real, HQ / UHQ / high quality, premium, verified, refill, guarantee, lifetime, non-drop /
-- no drop, targeted or organic. An explicit "no refill" or "bot" in the name takes the promise back (service_name_no_guarantee, the same rule as
-- routing and the segments), so "[no refill] [high quality]" is not premium. offer-quality.ts isPremiumCard is the TypeScript twin; the price
-- engine uses it to give Premium and the rest their own markup (price_rules.quality_scope 'premium' / 'standard').
--
-- Only the NAME is read: the cards carry no description of their own, so a trigger that stood only in a description does not exist today.
--
--   services.is_premium   boolean, computed from the name by a trigger (a new or renamed card), backfilled here; the storefront sorts on it
--   segments 'premium'    the chip "Premium" is the same set (it used to be a narrower reading of the name), so chip and badge agree
--
-- Nothing here changes a price or a name. The markup is data (price_rules, added by hand after the deploy: docs/proposals/two-level-markup.sql).
-- =============================================================================

alter table public.services
  add column if not exists is_premium boolean not null default false;

create or replace function public.service_is_premium(p_name text)
returns boolean
language sql
immutable
as $$
  select not public.service_name_no_guarantee(p_name)
     and coalesce(p_name, '') ~* '\y(?:real\y(?![\s-]*time)|u?hq\y|premium\y|verified\y|lifetime\y|targeted\y|organic|refill|guarantee|non[\s-]*drop|no[\s-]*drops?\y|high[\s-]*quality|ultra[\s-]*high[\s-]*quality)';
$$;

revoke all on function public.service_is_premium(text) from public, anon, authenticated;
grant execute on function public.service_is_premium(text) to service_role;

-- the segment "premium" is the premium flag
create or replace function public.service_segments(p_name text)
returns text[]
language sql
immutable
as $$
  select array_remove(array[
    case when public.service_is_premium(p_name) then 'premium' end,
    case when not public.service_name_no_guarantee(p_name)
          and coalesce(p_name, '') ~* 'refill|guarantee|\ynon[\s-]*drop\y|\yno[\s-]*drops?\y|\ylifetime\y|\yr\d{2,3}\y|warranty' then 'guaranteed' end,
    case when coalesce(p_name, '') ~* '\y(slow|organic|natural|gradual|safe|human[\s-]*like)\y|speed:?\s*(very\s+)?slow|\y[1-9]\d{0,2}\s*(/|per\s*)day\y|\y[1-5]k\s*(/|per\s*)day\y'
          and coalesce(p_name, '') !~* 'bot' then 'safe' end
  ], null);
$$;

-- the cards that exist
update public.services
   set is_premium = public.service_is_premium(name),
       segments = public.service_segments(name)
 where is_premium is distinct from public.service_is_premium(name)
    or segments is distinct from public.service_segments(name);

-- a new or renamed card gets both by itself
create or replace function public.set_service_segments()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.segments := public.service_segments(new.name);
  new.is_premium := public.service_is_premium(new.name);
  return new;
end;
$$;
revoke all on function public.set_service_segments() from public, anon, authenticated;

create index if not exists idx_services_premium_first on public.services (is_premium desc, sort_order, customer_rate_per_1000, id) where is_active;

-- services has column-level grants: the storefront reads the flag
grant select (is_premium) on table public.services to anon, authenticated;

-- price rules may be limited to Premium cards or to all the others
alter table public.price_rules drop constraint if exists price_rules_quality_scope_check;
alter table public.price_rules
  add constraint price_rules_quality_scope_check check (quality_scope in ('quality', 'premium', 'standard'));

comment on column public.price_rules.quality_scope is
  'quality: quality cards only (isQualityCard in offer-quality.ts). premium: Premium cards only (isPremiumCard, services.is_premium). standard: every card that is not Premium. null: every card.';
