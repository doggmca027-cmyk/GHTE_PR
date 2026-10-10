-- Pricing strategy: tiered markups for the whole catalogue plus keyword overrides for the services that carry margin.
--
-- The price engine (supabase/functions/_shared/price-engine.ts) stays the only place prices are computed; this migration only gives it
-- data and one new capability:
--   * price_rules.name_all / name_any: a rule may require words in the service NAME (whole-word, case-insensitive, scoped to a platform).
--     "0% drop" does not match "10% drop"; the engine does the matching, never SQL ILIKE.
--   * precedence: service > category > keywords > platform > global, then priority. An explicit admin margin on a category or a service
--     always beats an automatic keyword rule; a keyword rule beats a plain platform margin.
--   * the anti-loss floor (cost + 0.02 per 1000, rounded UP to 4 decimals) is DEFAULT_MIN_MARGIN in the engine, applied after every rule.
--
-- Values are markups in percent, as everywhere in price_rules: a multiplier m is value (m - 1) * 100, so x4.0 is 300.
-- sync-catalog loads these rules on every run and re-prices each storefront service from its cheapest offer, so a later provider price
-- change is marked up by the same rules without anyone touching this table.
--
-- Idempotent: a rule is inserted only when no rule of that name exists, so re-running (or editing a seeded rule in the admin) is safe.

alter table public.price_rules
  add column name_all text[],
  add column name_any text[];

alter table public.price_rules
  add constraint price_rules_keywords_not_empty check (
    (name_all is null or cardinality(name_all) > 0) and (name_any is null or cardinality(name_any) > 0)
  ),
  add constraint price_rules_keywords_flat_only check (type <> 'tier' or (name_all is null and name_any is null));

-- -----------------------------------------------------------------------------
-- 1. Global tiers by provider cost per 1000 (fallback for every platform and every service no keyword rule claims).
--    Upper bounds are inclusive and costs are stored with 4 decimals, so "< 0.05" is max_rate 0.0499.
-- -----------------------------------------------------------------------------
do $$
begin
insert into public.price_rules (name, type, value, min_rate, max_rate, priority, is_active)
select v.name, 'tier'::public.price_rule_type_enum, v.value, v.min_rate, v.max_rate, 0, true
from (values
  ('Strategy tier 1: cost < 0.05 (x4.0)',        300::numeric, 0::numeric,    0.0499::numeric),
  ('Strategy tier 2: cost 0.05 - 0.50 (x2.5)',   150::numeric, 0.05::numeric, 0.4999::numeric),
  ('Strategy tier 3: cost 0.50 - 5.00 (x1.8)',    80::numeric, 0.5::numeric,  4.9999::numeric),
  ('Strategy tier 4: cost >= 5.00 (x1.5)',        50::numeric, 5::numeric,    null::numeric)
) as v(name, value, min_rate, max_rate)
where not exists (select 1 from public.price_rules r where r.name = v.name);
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Keyword overrides, scoped to a platform (a platform that does not exist yet simply gets no rule).
--    priority 20: beats the platform-less keyword rules below when a service matches both.
-- -----------------------------------------------------------------------------
do $$
begin
insert into public.price_rules (name, type, value, platform_id, name_all, name_any, priority, is_active)
select v.name, 'percentage'::public.price_rule_type_enum, v.value, p.id, v.name_all, v.name_any, v.priority, true
from (values
  -- Telegram
  ('Strategy: Telegram Members 0% Drop (x2.0)',        'telegram',  100::numeric, array['telegram members', '0% drop'], null::text[], 20),
  ('Strategy: Telegram Premium Members (x1.6)',        'telegram',   60::numeric, array['telegram premium members'],    null::text[], 20),
  ('Strategy: Telegram Post Views / Reactions (x4.5)', 'telegram',  350::numeric, null::text[], array['telegram post views', 'telegram reactions'], 20),
  -- Instagram
  ('Strategy: Instagram Followers Guaranteed / Non Drop (x2.2)', 'instagram', 120::numeric, array['instagram followers'], array['guaranteed', 'non drop'], 20),
  ('Strategy: Instagram Likes Real / Premium (x3.0)',  'instagram', 200::numeric, array['instagram likes'],     array['real', 'premium'], 20),
  ('Strategy: Instagram Story / Reels Views (x4.0)',   'instagram', 300::numeric, null::text[], array['instagram story views', 'reels views'], 20),
  -- YouTube
  ('Strategy: YouTube Subscribers (x1.5)',             'youtube',    50::numeric, array['youtube subscribers'],     null::text[], 20),
  ('Strategy: YouTube Views High Retention / SEO (x1.6)', 'youtube', 60::numeric, array['youtube views'],           array['high retention', 'seo'], 20),
  ('Strategy: YouTube 4000 Watch Hours (x1.4)',        'youtube',    40::numeric, array['4000 watch hours'],        null::text[], 20),
  -- TikTok
  ('Strategy: TikTok Followers (x2.0)',                'tiktok',    100::numeric, array['tiktok followers'],        null::text[], 20),
  ('Strategy: TikTok Views (x4.0)',                    'tiktok',    300::numeric, array['tiktok views'],            null::text[], 20),
  ('Strategy: TikTok Live Stream (x1.5)',              'tiktok',     50::numeric, array['live stream'],             null::text[], 20),
  -- X (Twitter) / Facebook / Discord
  ('Strategy: Twitter Followers / Likes (x2.0)',       'twitter',   100::numeric, null::text[], array['followers', 'likes'], 20),
  ('Strategy: Twitter Views (x4.0)',                   'twitter',   300::numeric, array['views'],                   null::text[], 30),
  ('Strategy: Facebook Page Likes / Followers (x2.2)', 'facebook',  120::numeric, null::text[], array['page likes', 'followers'], 20),
  ('Strategy: Discord Members / Online (x2.5)',        'discord',   150::numeric, null::text[], array['members', 'online'], 20),
  ('Strategy: Discord Boosts (x1.5)',                  'discord',    50::numeric, array['boosts'],                  null::text[], 30),
  -- Streaming and music
  ('Strategy: Spotify Plays / Streams (x2.5)',         'spotify',   150::numeric, null::text[], array['plays', 'streams'], 20),
  ('Strategy: Spotify Followers (x2.0)',               'spotify',   100::numeric, array['followers'],               null::text[], 30),
  ('Strategy: Twitch Followers (x2.2)',                'twitch',    120::numeric, array['followers'],               null::text[], 20),
  ('Strategy: Twitch Live Viewers (x1.6)',             'twitch',     60::numeric, array['live viewers'],            null::text[], 30),
  ('Strategy: Kick Live Viewers (x1.6)',               'kick',       60::numeric, array['live viewers'],            null::text[], 20),
  -- B2B
  ('Strategy: LinkedIn Followers (x1.8)',              'linkedin',   80::numeric, array['followers'],               null::text[], 20)
) as v(name, slug, value, name_all, name_any, priority)
join public.platforms p on p.slug = v.slug
where not exists (select 1 from public.price_rules r where r.name = v.name);
end
$$;

-- -----------------------------------------------------------------------------
-- 3. Keyword overrides that are not tied to one platform (priority 10, below the platform-scoped ones).
-- -----------------------------------------------------------------------------
do $$
begin
insert into public.price_rules (name, type, value, name_all, name_any, priority, is_active)
select v.name, 'percentage'::public.price_rule_type_enum, v.value, v.name_all, v.name_any, 10, true
from (values
  ('Strategy: Reviews Trustpilot / Google Maps / TripAdvisor (x1.5)', 50::numeric,  array['reviews'], array['trustpilot', 'google maps', 'tripadvisor']),
  ('Strategy: Website Traffic / SEO / Backlinks (x2.5)',              150::numeric, null::text[],     array['website traffic', 'seo', 'backlinks']),
  ('Strategy: App Installs (x1.8)',                                    80::numeric,  array['app installs'], null::text[])
) as v(name, value, name_all, name_any)
where not exists (select 1 from public.price_rules r where r.name = v.name);
end
$$;

-- -----------------------------------------------------------------------------
-- 4. The admin rule list also reports the keywords (same JSON as before, two keys added).
-- -----------------------------------------------------------------------------
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
      'name_all', to_jsonb(r.name_all), 'name_any', to_jsonb(r.name_any),
      'scope', case when r.service_id is not null then 'Service: ' || coalesce((select name from services where id = r.service_id), '?')
                    when r.category_id is not null then 'Category: ' || coalesce((select name from categories where id = r.category_id), '?')
                    when r.name_all is not null or r.name_any is not null then 'Keywords' || coalesce(': ' || pl.slug, '')
                    when r.platform_id is not null then 'Platform: ' || pl.slug
                    else 'Global' end
    ) order by r.priority desc, r.name)
    from price_rules r left join platforms pl on pl.id = r.platform_id), '[]'::jsonb);
end;
$$;
