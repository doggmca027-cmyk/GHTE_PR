-- =============================================================================
-- A price rule that applies to quality cards only
--
-- The keyword scope of a rule (name_any) cannot say "quality": it would also match "[no refill] [high quality]". quality_scope = 'quality' limits a
-- rule to the cards that offer-quality.ts isQualityCard calls quality (the name promises a refill, HQ, real, organic or non-drop and does not take
-- it back): the same test routing uses, so a card that is routed as quality is also priced as quality (price-engine.ts matches / specificity).
--
-- The rule that uses it ("Quality tier 3a": quality cards at a cost of 1.00 - 3.00 sell at max(x2.5, cost + 0.80) instead of x2.0) is data, and a
-- migration may not insert rules (check-supabase): it is added by hand once this is deployed (docs/proposals/premium-markup.sql).
-- =============================================================================

alter table public.price_rules
  add column if not exists quality_scope text check (quality_scope in ('quality'));

comment on column public.price_rules.quality_scope is
  'quality: the rule applies to quality cards only (isQualityCard in offer-quality.ts). null: every card.';
