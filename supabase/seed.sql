-- Development seed (runs on `supabase db reset`). Idempotent; never use in production.
-- external ids / names must match MOCK_SERVICES in supabase/functions/_shared/smm-v2-adapter.ts
-- so that `sync-catalog` with MOCK_MODE=true is a no-op on a seeded database.

-- Mock provider: no api_key_encrypted, so it only syncs when MOCK_MODE=true.
insert into public.providers (name, api_url, is_active, balance, priority)
values ('Secsers Mock', 'https://secsers.example/api/v2', true, 1000, 10)
on conflict (name) do nothing;

-- Markup: +200% for Telegram, +150% for everything else (retail = provider rate x3 / x2.5).
insert into public.price_rules (name, type, value, platform_id, priority)
select v.name, v.type::public.price_rule_type_enum, v.value, (select id from public.platforms where slug = v.platform), v.priority
from (values
  ('Default +150%',  'percentage', 150.00, null,       0),
  ('Telegram +200%', 'percentage', 200.00, 'telegram', 0)
) as v(name, type, value, platform, priority)
where not exists (select 1 from public.price_rules r where r.name = v.name);

insert into public.categories (platform_id, name, slug, sort_order)
select (select id from public.platforms where slug = v.platform), v.name, v.slug, v.sort_order
from (values
  ('telegram',  'Telegram Views',      'telegram-views',      10),
  ('telegram',  'Telegram Members',    'telegram-members',    20),
  ('instagram', 'Instagram Followers', 'instagram-followers', 30),
  ('tiktok',    'TikTok Likes',        'tiktok-likes',        40)
) as v(platform, name, slug, sort_order)
on conflict (slug) do nothing;

insert into public.provider_services
  (provider_id, external_service_id, name, category_raw, rate_per_1000,
   min_quantity, max_quantity, refill_supported, cancel_supported, is_active, last_synced_at)
select p.id, v.ext, v.name, v.cat, v.rate, v.min, v.max, v.refill, v.cancel, true, now()
from public.providers p
cross join (values
  ('1001', 'Telegram Post Views [Instant]',            'Telegram Views',      0.0800::numeric,  100, 1000000, false, false),
  ('1002', 'Telegram Post Views [Real, 30 Days]',      'Telegram Views',      0.2500::numeric,  100,  500000, false, false),
  ('2001', 'Telegram Channel Members [Non-Drop 30D]',  'Telegram Members',    1.8000::numeric,   50,   50000, true,  false),
  ('2002', 'Telegram Group Members [Mixed]',           'Telegram Members',    0.9000::numeric,  100,  100000, true,  false),
  ('3001', 'Instagram Followers [Real, Refill 30D]',   'Instagram Followers', 2.4000::numeric,   50,  100000, true,  true),
  ('3002', 'Instagram Followers [Fast, No Refill]',    'Instagram Followers', 1.2000::numeric,  100,  200000, false, false),
  ('4001', 'TikTok Likes [Instant]',                   'TikTok Likes',        0.6000::numeric,   20,  100000, false, true),
  ('4002', 'TikTok Likes [Real, Refill]',              'TikTok Likes',        1.0000::numeric,   50,   50000, true,  false)
) as v(ext, name, cat, rate, min, max, refill, cancel)
where p.name = 'Secsers Mock'
on conflict (provider_id, external_service_id) do nothing;

-- Public catalogue. customer_rate_per_1000 = what price-engine yields for the rules above.
insert into public.services
  (category_id, name, primary_provider_service_id, customer_rate_per_1000,
   min_quantity, max_quantity, refill_supported, is_active, sort_order)
select c.id, ps.name, ps.id, v.retail, ps.min_quantity, ps.max_quantity, ps.refill_supported, true, v.sort
from (values
  ('1001', 'telegram-views',      0.2400::numeric, 10),
  ('1002', 'telegram-views',      0.7500::numeric, 20),
  ('2001', 'telegram-members',    5.4000::numeric, 10),
  ('2002', 'telegram-members',    2.7000::numeric, 20),
  ('3001', 'instagram-followers', 6.0000::numeric, 10),
  ('3002', 'instagram-followers', 3.0000::numeric, 20),
  ('4001', 'tiktok-likes',        1.5000::numeric, 10),
  ('4002', 'tiktok-likes',        2.5000::numeric, 20)
) as v(ext, slug, retail, sort)
join public.providers p           on p.name = 'Secsers Mock'
join public.provider_services ps  on ps.provider_id = p.id and ps.external_service_id = v.ext
join public.categories c          on c.slug = v.slug
where not exists (
  select 1 from public.services s where s.primary_provider_service_id = ps.id
);

-- Provider offers (the routing engine reads these, not services.primary_provider_service_id). The bridge trigger
-- creates them when the services above are inserted; this only covers a re-run on an existing database.
insert into public.provider_service_offers
  (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity,
   refill_supported, cancel_supported, is_active, routing_score)
select s.id, ps.provider_id, ps.id, ps.rate_per_1000, ps.min_quantity, ps.max_quantity,
       ps.refill_supported, ps.cancel_supported, true, 100
  from public.services s
  join public.provider_services ps on ps.id = s.primary_provider_service_id
on conflict (service_id, provider_id, provider_service_id) do nothing;

-- Routing only sends orders to providers that are routing-enabled AND healthy. Nothing sets health yet
-- (health checks come later), so the dev mock provider is switched on here by hand.
update public.providers set routing_enabled = true, health_status = 'healthy'
 where name = 'Secsers Mock' and is_active;
