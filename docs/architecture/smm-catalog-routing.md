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
panel's price), its own limits and flags, `is_active`. `sync-catalog` keeps it in step with the panel every 6 hours.
`unique (provider_id, external_service_id)`.

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

1. **Catalog sync** (`sync-catalog`, every 6 hours) reads each panel, writes `provider_services`, creates missing `categories`
   and `services`, and prices `services.customer_rate_per_1000` with the price rules. A trigger (`trg_provider_services_sync_offers`) keeps the
   offers' cost and limits equal to the provider service.
2. **Routing** (`place-order`): loads the offers of the service, drops inactive/unhealthy ones, ranks by
   **effective cost** = `cost_per_1000 x reliability_penalty_multiplier`, then `routing_score`, then id.
3. **`place_order()`** (database function, one transaction) validates the chosen offer, debits the customer, reserves the
   provider balance, and writes the order with its snapshots. If the provider refuses before anything is sent, the next offer is
   tried; once a request reached a provider the outcome is final for that call.
4. **Sync** (`sync-order-status`, every minute) follows the order at the provider and settles refunds. Unknown outcomes go to
   the Reconciliation Center.

## 4. Legacy: `services.primary_provider_service_id` and `fallback_provider_service_id`

These two columns are the **old routing**: a service named one primary and one fallback provider service. They are still in the
schema and still used:

* `trg_services_sync_offers` turns a primary/fallback into offers (primary score 100, fallback 0);
* `sync-catalog` sets `primary_provider_service_id` when it creates a service, and the repricing (admin-pricing and
  sync-catalog) uses the primary provider's rate as the cost basis;
* about 25 files (functions, shared modules, tests, scripts) refer to them.

`place_order` and the router no longer read them for new orders: they use the offers. **They must not be dropped yet.** The
planned refactor moves sync-catalog and pricing fully onto offers; only then can the columns go, in a migration of their own.

## 5. Where to look

| Question | Where |
| --- | --- |
| Table definitions | `supabase/migrations/` (`..13` offers, `..14` order snapshots, `..30` platform FK, `..31` slug) |
| Routing rules | `supabase/functions/_shared/routing.ts` |
| Order placement | `place_order()` and `supabase/functions/_shared/place-order-flow.ts` |
| Catalog sync and anomaly guard | `supabase/functions/_shared/catalog-sync.ts` |
| Types | `supabase/functions/_shared/types.ts` (`IProvider`, `IProviderServiceOffer`), `src/types/` |
