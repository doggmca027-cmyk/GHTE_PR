# Market floors per card (applied by hand on 2026-11-05)

The owner asked for prices "slightly below the competitors that actually operate" (retail storefronts such as SMM Level, not wholesale panels) and said some
cards are priced "as a joke". The price research (competitor tables per platform / action / tier, 2026-11-05, public list prices) gave a reference for the
groups below; the cards of these groups were raised toward it, conservatively. Nothing was lowered.

## What was applied

465 rules in `price_rules`, one per card (`service_id` scope, the strongest scope), named `Market floor <SKU>: at least <price> per 1000 (<group>, reference <market median> <confidence>)`.
Each rule copies the tier rule that priced the card before (value, min_markup, min_price) and raises only `min_price` to the card's floor, so the price is
`max(what it was, floor)`: it can rise to the floor and never falls, and the owner's minimum markups (Premium x2.5, the rest x1.5) and the $0.12 floor are untouched.

The floor of a card = the retail-storefront median of its group x 0.88, capped at 2x the group's median price today and at 3x the card's own price (one pass;
a second pass can continue). Only cards whose name states ONE kind of product got a floor (no bot starts, live streams, stories, Premium accounts, packages,
combos, "+"), with a cost of at least a third of the group's median cost (cheaper ones are other, lower products).

| Group (platform / product / level) | Market (retail median, USD per 1000) | Floor | Cards raised |
|---|---:|---:|---:|
| telegram / views / premium | 0.73 | 0.42 | 215 |
| telegram / followers / premium | 2.82 (30-59 d refill tier, the lowest) | 2.48 | 53 |
| telegram / likes / premium | 0.72 | 0.36 | 35 |
| instagram / likes / standard | 0.73 | 0.64 | 30 |
| instagram / followers / standard | 5.02 | 3.41 | 27 |
| youtube / comments / standard | 45.5 | 29.94 | 24 |
| instagram / views / standard | 0.44 | 0.24 | 19 |
| instagram / views / premium | 0.86 | 0.28 | 19 |
| twitter / views / standard | 0.22 | 0.19 | 17 |
| telegram / views / standard | 0.73 | 0.32 | 14 |
| instagram / comments / standard | 14.1 | 12.41 | 3 |
| telegram / followers / standard | 5.27 | 1.71 | 3 |
| telegram / likes / standard | 0.72 | 0.63 | 3 |
| vk / followers / standard | 9.6 | 6.93 | 3 |

Groups with a low-confidence reference, with no retail-storefront data (Spotify, TikTok and YouTube views and most of the catalogue) or where the market is
under our minimum markup (Instagram followers Premium, Facebook, TikTok followers Premium, YouTube views Standard ...) were left alone.

## Rollback

```sql
update public.price_rules set is_active = false where name like 'Market floor %';
```

then the next sync of each provider puts the old prices back (or run sync-catalog per provider by hand).

## Notes

- The rule loaders (`loadPriceRules`, used by sync-catalog, quote-order and place-order) read the rules page by page; PostgREST answers at most 1000 rows to one request.
- A new card of a group gets no floor until the calibration is run again (nothing changes silently).
- The reference numbers are medians of 3-9 sellers with wide spreads (confidence "medium", Instagram views and comments "high"): treat them as a conservative first pass.
