-- APPROVED by the owner on 2026-11-03; applied by hand (Management API) after the code and migration 20261231000200 were deployed.
-- Markup calibration for quality cards in the $1.00 - $3.00 cost band.
--
-- What the data says (active cards, 2026-11-02; the retail multiple at the base step, below 1000 units):
--   cost per 1000      cards   of them quality   multiple now
--   < 0.05               400        115             x12.8   (min price 0.12)
--   0.05 - 0.50         1688        759             x3.0
--   0.50 - 1.00         1341       1043             x2.0
--   1.00 - 3.00         1309        808             x2.0   <- this rule
--   3.00 - 5.00          476        333             x2.0
--   5.00 and up         1913       1127             x1.6
-- Volume steps (platform_settings.volume_margin_tiers) scale a card's OWN margin, so a x2.0 card sells at x1.5 from 1000 units and x1.35 from
-- 10000 (the step floor); a x2.5 card at x1.75 and about x1.47. The discount at 1000 and 10000 stays what it is today in percent of the base
-- (about 30 % and 41 % for x2.5; about 25 % and 33 % today), so the bulk steps stay generous.
--
-- Only the quality cards in the 1.00 - 3.00 band move (x2.0 -> x2.5, never under cost + 0.80). Everything else stays: the cheap bands already
-- carry x3 and more, and from 5.00 up the retail is already above what open panels list for the same lines.
--
-- The code that makes this possible is deployed with migration 20261231000200: a price rule can be limited to quality cards (price_rules.quality_scope,
-- price-engine.ts matches / specificity; "quality" is isQualityCard of offer-quality.ts, the test routing uses, so a card that is routed as quality is
-- also priced as quality). A keyword scope (name_any) cannot do it: it would also match "[no refill] [high quality]".
--
-- The rule is data, and a migration may not insert rules (check-supabase), so it is run by hand:

insert into public.price_rules (name, type, value, min_rate, max_rate, min_markup, priority, is_active, quality_scope)
values ('Quality tier 3a: cost 1.00 - 3.00 -> max(x2.5, +0.80)', 'tier', 150, 1.0000, 2.9999, 0.8000, 1, true, 'quality');

-- The next catalogue sync of each provider re-prices the cards it touches (one run per provider, every 5 minutes in rotation).
--
-- ROLLBACK: update public.price_rules set is_active = false where name like 'Quality tier 3a:%';  (and the next sync puts the old prices back)
