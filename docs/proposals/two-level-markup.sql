-- APPROVED by the owner on 2026-11-04; applied by hand (Management API) after migration 20270101000100 and the price-engine change were deployed.
-- The two-level catalogue: Premium (the name promises quality) sells at x2.5 - x3.0 of the cost, every other card at x1.5 - x2.0.
--
--   cost per 1000      Premium         the rest
--   below 1.00         x3.0            x2.0
--   1.00 - 4.9999      x2.75           x1.75
--   5.00 and up        x2.5            x1.5
--
-- The cheapest cards (below 0.05) keep the floors they have today (cost + 0.10, never under 0.12) and the 0.05 - 1.00 band cost + 0.05, so a tiny
-- order still pays the gateway and the network. Volume steps (platform_settings.volume_margin_tiers) scale a card's own margin as before.
--
-- "Premium" is isPremiumCard of offer-quality.ts = services.is_premium = service_is_premium(name); "standard" is every other card. The old global
-- tiers (Tier 1..4) stay active as a safety net: a rule of a scope beats them (specificity 2 against 0), and with the new rules switched off they
-- price the catalogue as before. The old "Quality tier 3a" is switched off: Premium replaces it.
--
-- The rules are data, and a migration may not insert rules (check-supabase), so this is run by hand:

insert into public.price_rules (name, type, value, min_rate, max_rate, min_markup, min_price, priority, is_active, quality_scope) values
  ('Standard tier 1: cost < 0.05 -> x2.0 (floor 0.10 / 0.12)',  'tier', 100, 0.0000, 0.0499, 0.1000, 0.1200, 0, true, 'standard'),
  ('Standard tier 2: cost 0.05 - 1.00 -> x2.0',                 'tier', 100, 0.0500, 0.9999, 0.0500, null,   0, true, 'standard'),
  ('Standard tier 3: cost 1.00 - 5.00 -> x1.75',                'tier',  75, 1.0000, 4.9999, null,   null,   0, true, 'standard'),
  ('Standard tier 4: cost 5.00 and up -> x1.5',                 'tier',  50, 5.0000, null,   null,   null,   0, true, 'standard'),
  ('Premium tier 1: cost < 0.05 -> x3.0 (floor 0.10 / 0.12)',   'tier', 200, 0.0000, 0.0499, 0.1000, 0.1200, 0, true, 'premium'),
  ('Premium tier 2: cost 0.05 - 1.00 -> x3.0',                  'tier', 200, 0.0500, 0.9999, 0.0500, null,   0, true, 'premium'),
  ('Premium tier 3: cost 1.00 - 5.00 -> x2.75',                 'tier', 175, 1.0000, 4.9999, null,   null,   0, true, 'premium'),
  ('Premium tier 4: cost 5.00 and up -> x2.5',                  'tier', 150, 5.0000, null,   null,   null,   0, true, 'premium');

update public.price_rules set is_active = false where name like 'Quality tier 3a:%';

-- The next catalogue sync of each provider re-prices the cards it touches (one run per provider, every 5 minutes in rotation).
--
-- ROLLBACK: update public.price_rules set is_active = false where name like 'Standard tier %' or name like 'Premium tier %';
--           update public.price_rules set is_active = true  where name like 'Quality tier 3a:%';   (and the next sync puts the old prices back)
