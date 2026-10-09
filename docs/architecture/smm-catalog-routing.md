# SMM catalog and routing: the data model as it is today

This page describes what is **in the database now** (migrations up to `20261031000000`). Nothing here is a plan, except where
a section says so.

```
platforms ──< categories ──< services ──< provider_service_offers >── providers
                                │                   │                   │
                                │                   └── provider_services (the provider's own catalog row)
                                │
                              orders ── provider_offer_id ──> provider_service_offers
                                 └──── provider_id ─────────> providers
```

## 1. Who sees what

| Table | Customers (anon / signed in) | Admins | Workers (service role) |
| --- | --- | --- | --- |
| `platforms` | read active rows | read all, write through `admin_upsert_platform` | all |
| `categories` | read active rows | (via functions) | all |
| `services` | read active rows | (via functions) | all |
| `orders` | read their own | (via functions) | all |
| `providers`, `provider_services`, `provider_service_offers` | **nothing**: RLS on, no policies, no grants | (via audited functions) | all |

Customers never learn that providers exist: no provider id, cost or API URL is reachable from a client. The security audit
(`npm run check:supabase`) fails the build if any of these tables ever gets a client grant.

## 2. The chain

### platforms
The registry of platforms (`telegram`, `instagram`, `spotify`, ...): `slug` (unique), `name`, `icon`, `category`, `active`,
`sort_order`. `platform_enum` no longer exists. A platform is switched off with `active = false`, never deleted.

### categories
`categories.platform_id` -> `platforms.id` (NOT NULL, `ON DELETE RESTRICT`). The app reads
`categories?select=...,platforms!inner(slug)`, so a category of an inactive platform is hidden.

### services (the storefront)
What the customer sees and buys. It is the **normalized service**: `category_id`, `name`, `description`, `customer_rate_per_1000`
(the retail price), `min_quantity` / `max_quantity` (storefront limits), `refill_supported`, `is_active`, `sort_order`.
Provider data does not belong here, with one legacy exception (section 4).

### provider_services
One row per service in a **provider's own catalog**: `external_service_id` (the id at the panel), `rate_per_1000` (the
panel's price), its own limits and flags, `is_active`. `sync-catalog` keeps it in step with the panel every hour.
`unique (provider_id, external_service_id)`. Also kept: `service_type` (the panel's own type, "Default", "Package", ...) and
`description` (the panel's own text, when it sends one: `desc`).

**Publishing.** After storing a catalogue the sync calls `publish_provider_services` (service role only): every service of type
"Default" with a real price and sane limits gets a category (per platform, by the panel's category text) and a storefront
service, named in English by the glossary (`service-text.ts`; the original stays in `name_i18n.ru`), with its facts in
`attributes` (refill, start time, speed, geography, drops). The customer-side description is generated from those facts in the
customer's language. A service an admin made by hand (`auto_published = false`) is never touched. A provider with
`routing_enabled = false` is imported but **never published**, and the hourly run does not even sync it (call `sync-catalog`
with `{"providerId": ...}` to import or refresh it). Prices: the admin sets markups for everything / a platform / a category /
a service (Admin -> Цены и наценки); with no rule that applies, the sync keeps the price a service has (the publisher gives a new one cost x 2.5) and only lifts it to cost + the minimum margin.

### provider_service_offers (the provider offer)
**One normalized service can have many offers.** An offer says "this provider fulfils this service at this cost":

| Column | Meaning |
| --- | --- |
| `service_id`, `provider_id`, `provider_service_id` | the three ends (the provider must own the provider service: a composite foreign key enforces it) |
| `cost_per_1000` | what the provider charges us; copied from `provider_services.rate_per_1000` by a trigger |
| `min_quantity`, `max_quantity` | the provider's actual limits |
| `refill_supported`, `cancel_supported`, `supports_partial` | capability flags (`supports_partial` is new and defaults to false: not claimed) |
| `is_active` | an operator decision (also turned off by the catalog anomaly guard) |
| `routing_score` | higher wins ties; primary = 100, fallback = 0 when created from the legacy columns |
| `anomaly_*` | why the offer was suspended (price jumped more than 30 % and similar) |

### providers
The registry of providers: `slug` (unique, new), `name`, `api_url`, `api_key_encrypted`, `is_active`, `routing_enabled`,
`health_status`, `provider_balance` (the balance **at the panel**, in `currency`), `reliability_penalty_multiplier`, the payout
configuration (`allowed_destination_wallet`, limits) and low-balance thresholds. `slug` is generated from the name
("Secsers Mock" -> `secsers-mock`) when not given.

There is no `reserved_balance` column on purpose: the provider balance is reserved **inside `place_order`**, in the same
transaction as the customer's debit (`orders.provider_reservation`), so there is a single number to trust.

### orders
An order points at what actually served it: `service_id` (what was bought), `provider_offer_id` (the offer chosen),
`provider_id`, `provider_order_id` (the id at the panel), plus snapshots taken at the moment of ordering (`cost_amount`,
`routing_score_snapshot`, `profit_amount`). A later price change, or the offer disappearing, never changes an old order.

## 3. How an order travels

1. **Catalog sync** (`sync-catalog`, every hour) reads each panel through `IProviderAdapter.getServices()` and upserts `provider_services`.
   It does **not** create `categories` or `services`: a new panel service waits in `provider_services` until an admin links it
   (`admin-catalog-mapping`). Offers' cost, limits and flags are kept equal to their provider service by the trigger
   `trg_provider_services_sync_offers` and re-checked by the sync itself (`planOfferSync`; `is_active` / `routing_score` untouched).
   A service the panel stops listing gets `is_active = false` (soft delete) on `provider_services`. More than half of a large
   catalogue vanishing in one run is treated as a partial response and deactivates nothing. Logic: `_shared/catalog-sync-run.ts`.
   **Pricing**: every storefront service that has an offer from the provider is re-priced and re-limited from ALL its offers
   (`_shared/service-cost.ts`, shared with `admin-pricing`):
   * **base cost** = the lowest `cost_per_1000` among the offers that can receive an order: offer active, panel still lists the
     service, provider active and `routing_enabled` (health is ignored on purpose: a few minutes of "degraded" must not move prices).
     The markup from the price rules is applied to it. With no such offer the price is left alone.
   * **limits**: never wider than the smallest `min` / largest `max` of those offers; a narrower admin choice is kept (limits are
     only ever tightened by the sync, never widened).
   * `refill_supported` only when every such offer supports it.
   * the service is switched off when this run took away its last usable offer, and back on when a panel service returns.
2. **Routing** (`place-order`, mode **BALANCED**): loads the offers of the service and keeps those that are active, whose provider is
   active, routing-enabled and healthy, whose limits take the quantity and whose cost does not exceed the customer's price. Ranks by
   `effective_cost = cost_per_1000 x reliability_penalty x (1 - min(routing_score, 1000) / 10000)`: the score is worth 0.01 % of the
   price per point (100 = 1 %, cap 1000 = 10 %). Equal: higher score, then lowest offer id. The first accepting offer in that order
   gets the order; an offer that refuses before anything is sent hands over to the next. The price is built on the cheapest offer, so
   the "cost <= price" rule is what keeps a score-preferred, dearer offer from selling at a loss.
3. **`place_order()`** (database function, one transaction) validates the chosen offer, debits the customer, reserves the
   provider balance, and writes the order with its snapshots. If the provider refuses before anything is sent, the next offer is
   tried; once a request reached a provider the outcome is final for that call.
4. **Sync** (`sync-order-status`, every minute) follows the order at the provider and settles refunds. Unknown outcomes go to
   the Reconciliation Center.

## 4. Legacy: `services.primary_provider_service_id` and `fallback_provider_service_id`

These two columns are the **old routing**: a service named one primary and one fallback provider service. They are still in the
schema and still used:

* `trg_services_sync_offers` turns a primary/fallback into offers (primary score 100, fallback 0);
* pricing no longer uses them: the base cost is the cheapest usable offer (see 3.1). `sync-catalog` does not create services;
* about 25 files (functions, shared modules, tests, scripts) still refer to them.

`place_order`, the router and pricing do not read them: they use the offers. **They must not be dropped yet** (the storefront
and other legacy code still read them); that is a migration of its own.

## 5. Where to look

| Question | Where |
| --- | --- |
| Table definitions | `supabase/migrations/` (`..13` offers, `..14` order snapshots, `..30` platform FK, `..31` slug) |
| Routing rules | `supabase/functions/_shared/routing.ts` |
| Order placement | `place_order()` and `supabase/functions/_shared/place-order-flow.ts` |
| Catalog sync and anomaly guard | `supabase/functions/_shared/catalog-sync.ts` |
| Types | `supabase/functions/_shared/types.ts` (`IProvider`, `IProviderServiceOffer`), `src/types/` |
