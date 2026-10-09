# Live provider flight test

The first real-money order against a real SMM provider, on production, with the least money and the least exposure possible.
This is `LAUNCH_PLAN.md` stage 1 (real provider connected) plus the order half of stage 3 (one real micro-order). It skips stage 2
(the TON deposit) on purpose: the test wallet is funded by a ledger entry, so no TON secret is configured and nothing else changes.

**Money at risk is exactly two numbers you choose:** the test funds you put in the wallet (step 3) and the balance you top up at the
provider's panel (step 1). Nothing here touches the treasury, provider payouts or any Edge Function.

Every SQL block below is marked `-- live-test: <name>` and is executed against the real migrations in `tests/live-test-runbook.test.ts`,
so the commands in this file cannot drift away from the schema. Run SQL in **Supabase Dashboard -> SQL Editor**.
Replace every `<PLACEHOLDER>`; the table at the end lists them.

> **If anything looks wrong at any step: stop first, think second.** The three levels of stopping are in
> [Abort](#abort-stop-everything). Keep that section open in a tab.

---

## What this runbook corrects in the original plan

| Assumed | What is true on this project |
| --- | --- |
| `PROVIDER_KEY_SECRET` lives in Vault | It is an **Edge Function secret** (`npm run secrets:push`), already set on production (`smoke:live` check `provider-key-secret`). Vault only holds `cron_secret`. The provider's API key is stored **encrypted with it** in `providers.api_key_encrypted`; it can never be written by plain SQL. |
| Wallet ledger table `wallet_ledger` | The ledger is `public.wallet_transactions` (append-only). |
| `provider_balance_samples` | No such table. The balance is `providers.provider_balance` / `last_balance_sync`; health history is `provider_health_log`. |
| Storefront categories exist | Production has **no category and no service yet**; step 2 creates the category. |
| Orders are off | Production currently has `global_orders_enabled = true`. Step 0 switches it off before anything is configured. |

---

## Step 0: Contain, snapshot, rehearse the exit

1. Read [Abort](#abort-stop-everything) once. Know where `supabase/scripts/emergency_quarantine.sql` is.
2. Close the doors for the duration of the test. Nobody can place an order or register while you configure:

```sql
-- live-test: lockdown
begin;
update public.platform_settings
   set global_orders_enabled = false, global_signups_enabled = false, updated_by = null, updated_at = now()
 where id = 1;
insert into public.admin_audit_log (admin_id, action, target_id, details)
values (null, 'live_test_lockdown', 'platform_settings', jsonb_build_object('by', session_user, 'at', now()));
commit;
select global_orders_enabled, global_payments_enabled, maintenance_mode, global_signups_enabled, minimum_treasury_reserve
  from public.platform_settings where id = 1;
```

Expected: `global_orders_enabled = false`, `global_signups_enabled = false`, `maintenance_mode = false`.

3. Find the test account. It is **your own** account (you are the admin and the only customer). It must exist (open the bot once) and show a wallet:

```sql
-- live-test: test-user
select u.id, u.telegram_id, u.is_admin, u.is_banned, w.balance, w.locked_balance
  from public.users u join public.wallets w on w.user_id = u.id
 where u.telegram_id = <YOUR TELEGRAM ID>;
```

4. Baseline and the pre-flight check (both read-only):

```powershell
npm run smoke:live -- --stage 1
npm run observe:live -- --once
```

Expected now: the only `[FAIL]` of `--stage 1` is `routing: No provider is configured`. `provider-key-secret`, `mock-mode` and the four cron
checks pass. The `ton`, `deposit-functions`, `payout-limits`, `reserve` and `balance` warnings are expected and stay.
`observe:live -- --once` prints the workers (sync, health monitor, notifier) with a recent success.

> `--stage 3` will report `deposit-functions` and `ton` as FAIL. That is expected for this test (stage 2 is skipped). Every other
> stage-3 check should pass once steps 1 to 3 are done.

**Do not continue** if `sync-order-status` or `provider-health-monitor` is not fresh, or `MOCK_MODE` is on.

---

## Step 1: Add the provider

**1a. Money first.** Top up the provider's panel with the smallest amount it accepts (a few dollars). That balance is the real
exposure of the test. Create an API key for this integration at the panel.

**1b. The provider row.** Use the HTTPS API endpoint of the panel (usually `https://<panel-domain>/api/v2`). Routing starts OFF:

```sql
-- live-test: add-provider
insert into public.providers (name, api_url, is_active, priority, currency)
values ('<PROVIDER NAME>', '<PANEL API URL>', true, 10, 'USD')
on conflict (name) do nothing;
select id, name, api_url, is_active, routing_enabled, health_status::text as health, api_key_encrypted is not null as has_key
  from public.providers where name = '<PROVIDER NAME>';
```

**1c. The API key, encrypted, never in SQL or in shell history.** Copy the key to the clipboard, then (first without `--apply` to see the plan):

```powershell
Get-Clipboard | npm run secrets:rotate -- provider-key --provider "<PROVIDER NAME>" --store db
Get-Clipboard | npm run secrets:rotate -- provider-key --provider "<PROVIDER NAME>" --store db --apply
```

(Alternative: *Admin -> Providers -> Edit -> API key*; the `admin-providers` function encrypts it the same way.)
The key is AES-256-GCM encrypted with `PROVIDER_KEY_SECRET`. **Do not rotate `PROVIDER_KEY_SECRET` during the test.**

**1d. Switch routing on** (audit-logged; it refuses a provider without a stored key):

```sql
-- live-test: enable-routing
select public.admin_set_provider_routing(
  (select id from public.users where telegram_id = <YOUR TELEGRAM ID>),
  (select id from public.providers where name = '<PROVIDER NAME>'),
  true);
```

**1e. Wait up to two minutes** for the health monitor, then:

```sql
-- live-test: provider-state
select name, is_active, routing_enabled, health_status::text as health, api_key_encrypted is not null as has_key,
       provider_balance, currency, last_balance_sync, last_health_check, sync_backoff_until, sync_failure_count
  from public.providers where name = '<PROVIDER NAME>';
```

Expected: `health = healthy`, `has_key = true`, `provider_balance` equals the panel's own balance, `sync_backoff_until` empty, `sync_failure_count = 0`.
If `health` is not `healthy` after three minutes:

```sql
-- live-test: provider-health-log
select checked_at, status::text as status, previous_status::text as previous_status, latency_ms, error_kind
  from public.provider_health_log
 where provider_id = (select id from public.providers where name = '<PROVIDER NAME>')
 order by checked_at desc limit 10;
```

`error_kind` tells you why (auth, timeout, ...). Fix the key or URL; do not force `health_status` by hand.

---

## Step 2: Map exactly one service

**2a. Import the provider's catalogue** (once; it only fills `provider_services`, it creates nothing on the storefront). The secret is read from `.env.local` into a variable and never printed:

```powershell
$s = (Select-String -Path .env.local -Pattern '^CRON_SECRET=(.*)$').Matches[0].Groups[1].Value.Trim('"')
curl.exe -sS -X POST "https://<PROJECT REF>.supabase.co/functions/v1/sync-catalog" -H "x-cron-secret: $s" -H "Content-Type: application/json" -d "{}"
```

Expected: `"added":N` with `"status"` not `"skipped"`. (`skipped / no API key configured` means step 1c did not take.)

**2b. Pick the service.** The cheapest stable Telegram post-views service with a small minimum:

```sql
-- live-test: candidates
select ps.id, ps.external_service_id, ps.name, ps.rate_per_1000, ps.min_quantity, ps.max_quantity, ps.cancel_supported
  from public.provider_services ps
 where ps.provider_id = (select id from public.providers where name = '<PROVIDER NAME>')
   and ps.is_active and ps.name ilike '%telegram%' and ps.name ilike '%view%'
 order by ps.rate_per_1000, ps.min_quantity
 limit 15;
```

Prefer: a plain name (no "premium", "instant", "drip" tricks), a `min_quantity` of 100 or less, and a rate of a few cents per 1000. Read its
description at the panel. Note its `id` (`<PROVIDER SERVICE ID>`), `rate_per_1000` and limits.

**2c. The category** (production has none):

```sql
-- live-test: category
insert into public.categories (platform_id, name, slug)
select id, 'Post Views', 'telegram-post-views' from public.platforms where slug = 'telegram'
on conflict (slug) do nothing;
select id, name, slug, is_active from public.categories where slug = 'telegram-post-views';
```

**2d. Create the storefront service with its single offer.** It is created **active**, which is the point of this step. Rules enforced by the function: the customer rate must be at or above the panel's cost (`below_cost`), the limits must fit the panel's. Pick:
`<CUSTOMER RATE PER 1000>` = the panel rate x 2.5 or more; `<MIN QTY>` = the panel minimum; `<MAX QTY>` = a small cap such as `1000`, so no single order can be large.

```sql
-- live-test: create-service
select public.admin_create_service_with_offer(
  (select id from public.users where telegram_id = <YOUR TELEGRAM ID>),
  '<PROVIDER SERVICE ID>'::uuid,
  (select id from public.categories where slug = 'telegram-post-views'),
  'Telegram Post Views (flight test)',
  'Flight test service',
  <CUSTOMER RATE PER 1000>, <MIN QTY>, <MAX QTY>, false);
```

**2e. Verify there is exactly one active service with one active offer:**

```sql
-- live-test: service-state
select s.id, s.name, s.is_active, s.customer_rate_per_1000, s.min_quantity, s.max_quantity,
       o.cost_per_1000, o.is_active as offer_active, o.anomaly_detected, o.routing_score, p.name as provider,
       (select count(*) from public.services where is_active) as active_services
  from public.services s
  join public.provider_service_offers o on o.service_id = s.id
  join public.providers p on p.id = o.provider_id
 order by s.created_at;
```

Expected: one row, `active_services = 1`, `offer_active = true`, `anomaly_detected = false`.
Note: `sync-catalog` runs at 00:00, 06:00, 12:00 and 18:00 UTC and re-prices linked services by your price rules; finish the order before the next run, or check the rate afterwards.

---

## Step 3: Fund the test account

The TON gateway stays off. The wallet is credited with a `manual_adjustment` entry through `process_wallet_transaction`, the same function every
other balance movement goes through: row lock, signed amount, immutable ledger row (`public.wallet_transactions`), `balance_after`. The idempotency key
ties the funding to the user: running the block twice credits once, and running it with a different amount is refused.

Fund **a little more than one order costs** (for example `1.00`):

```sql
-- live-test: fund-wallet
select (public.process_wallet_transaction(
  u.id, 'manual_adjustment', <TEST FUNDS USD>, null,
  'LIVE TEST funding (no TON deposit)', 'live-test-funding-' || u.id::text)).balance_after as balance
  from public.users u where u.telegram_id = <YOUR TELEGRAM ID>;
```

Verify the balance and the ledger entry:

```sql
-- live-test: wallet-state
select t.created_at, t.type::text as type, t.status::text as status, t.amount, t.balance_after, t.description
  from public.wallet_transactions t
  join public.wallets w on w.id = t.wallet_id
  join public.users u on u.id = w.user_id
 where u.telegram_id = <YOUR TELEGRAM ID>
 order by t.created_at desc limit 5;
```

This credit is not backed by a deposit (the treasury is unchanged), so wallet balances now exceed deposits by the test funds. Step 6 reclaims what is unused.

---

## Step 4: Execute the order

**4a. Gate.** `npm run smoke:live -- --stage 1` must show no `[FAIL]`. `npm run observe:live -- --once` must show the provider `healthy`, balance known, breaker closed (`fails 0`).

**4b. Open the order door** (signups stay closed):

```sql
-- live-test: open-orders
update public.platform_settings set global_orders_enabled = true, updated_by = null, updated_at = now() where id = 1;
select global_orders_enabled, global_signups_enabled, maintenance_mode from public.platform_settings where id = 1;
```

**4c. Start the observer in a second terminal** and leave it running. It waits for the first new order and follows it to the end:

```powershell
npm run observe:live -- --timeout 240
```

Read-only: one SELECT every 5 seconds, refused by `assertReadOnly` if it were anything else. It prints each status change, the provider order id,
any error, wallet entries, and a live status line with the sync worker's age, the lease, the provider's health and balance, and the circuit breaker
(`breaker closed (fails 0)` or `BREAKER OPEN until HH:MM:SS`).

**4d. Place the order in the Telegram WebApp** (your account): Services -> *Telegram Post Views (flight test)* -> a link to a **public post in a channel you own**
(`https://t.me/<channel>/<post id>`) -> the minimum quantity -> check the price on screen -> **Order Now**.

**4e. Close the order door again as soon as the observer says `locked on order`:**

```sql
-- live-test: close-orders
update public.platform_settings set global_orders_enabled = false, updated_by = null, updated_at = now() where id = 1;
select global_orders_enabled from public.platform_settings where id = 1;
```

Orders already at the provider keep being synced with the door closed (the workers do not depend on this switch).

**What you should see**

| When | Observer | Meaning |
| --- | --- | --- |
| at once | `STATUS (new) -> draft`, `draft -> awaiting_payment`, `awaiting_payment -> paid`, `WALLET purchase -$X`, `paid -> processing`, `processing -> submitted`, `provider_order_id: ...` | charged, accepted by the panel |
| within 1 to 3 min | `submitted -> in_progress`, `start_count`, `remains` | the sync worker polled the panel (once a minute) |
| minutes to hours | `in_progress -> completed` | delivered; the Telegram bot sends you the "completed" message |
| throughout | `sync ...s ago` under about 90 s, `breaker closed (fails 0)` | the lease worker is polling and the breaker has not tripped |

The observer exits `0` and prints `RESULT CLEAN` when the order completed and the money adds up. If you stop it (Ctrl-C), re-attach later with `npm run observe:live -- --order <ORDER ID>`.

**If something else appears**

| Observer says | Do this |
| --- | --- |
| order `failed`, then a `refund` and `refunded` | The panel refused it; the customer is refunded automatically. Read `error_message`. Not a platform bug unless the refund is missing. |
| `[CRIT] circuit breaker OPEN ... the order is NOT being polled` | The panel failed every status poll. The breaker pauses 1, 2, 4 ... 60 min and retries. Check the panel; if it is down, wait. If it is up, check `provider_health_log`. Do not reset it by hand unless you know why (`update providers set sync_backoff_until = null, sync_failure_count = 0 where name = '<PROVIDER NAME>'`). |
| `[CRIT] sync-order-status last succeeded ... ago` | The worker is not running. Check `cron.job_run_details` (step 5) and the function logs. |
| `[CRIT] the order is held for a human` or an open reconciliation case | The submission outcome is unknown. Do **not** refund or resubmit. Check the panel for the order, then decide in *Admin -> Reconciliation*. |
| `[WARN] the order has not changed for 15m` | Normal for slow services. Check the panel; wait. |
| Anything you do not understand | [Abort](#abort-stop-everything) level 1, then investigate. |

---

## Step 5: Verification

All read-only. Replace `<ORDER ID>` (printed by the observer).

**The order** (cost, profit and the routing facts are only visible to the database owner):

```sql
-- live-test: order-state
select o.id, o.status::text as status, o.quantity, o.charge_amount, o.cost_amount, o.profit_amount, o.provider_order_id,
       o.error_message, o.start_count, o.remains, o.partial_refund_amount, pr.name as provider, o.created_at, o.updated_at
  from public.orders o left join public.providers pr on pr.id = o.provider_id
 where o.id = '<ORDER ID>'::uuid;
```

**Its history** (`order_status_history`): every transition, in order.

```sql
-- live-test: order-history
select h.created_at, h.old_status, h.new_status
  from public.order_status_history h where h.order_id = '<ORDER ID>'::uuid order by h.created_at, h.id;
```

Expected for a clean run: `draft -> awaiting_payment -> paid -> processing -> submitted -> in_progress -> completed` (`in_progress` can be skipped when the panel completes within a minute).

**The money** (the wallet ledger, and the identity that must hold):

```sql
-- live-test: wallet-ledger
select t.created_at, t.type::text as type, t.status::text as status, t.amount, t.balance_after
  from public.wallet_transactions t where t.reference_id = '<ORDER ID>'::uuid order by t.created_at, t.id;
```

```sql
-- live-test: money-identity
select o.status::text as status, o.charge_amount, o.cost_amount, o.profit_amount,
       o.charge_amount - o.cost_amount = o.profit_amount as profit_adds_up,
       (select coalesce(sum(t.amount), 0) from public.wallet_transactions t where t.reference_id = o.id and t.status = 'completed') as net_wallet_effect
  from public.orders o where o.id = '<ORDER ID>'::uuid;
```

Expected for `completed`: `profit_adds_up = true`, `profit_amount >= 0`, `net_wallet_effect = -charge_amount` (one purchase, no refund).
For `refunded`: `net_wallet_effect = 0`. For `partial`: `net_wallet_effect = -(charge_amount - partial_refund_amount)`.

**The workers and the lease** (`worker_locks`, heartbeats; the lease is free between runs and `acquired_at` moves every minute):

```sql
-- live-test: worker-state
select 'lease' as kind, l.name, l.locked_until > now() as held, l.acquired_at as last_at, null::text as detail
  from public.worker_locks l where l.name = 'sync-order-status'
union all
select 'heartbeat', h.worker, null, h.last_success_at,
       'runs ' || h.runs || ', failures ' || h.failures || coalesce(', last error: ' || h.last_error, '')
  from public.worker_heartbeats h where h.worker in ('sync-order-status', 'provider-health-monitor', 'telegram-notifier')
 order by kind, name;
```

```sql
-- live-test: cron-runs
select j.jobname, d.status, d.start_time, left(d.return_message, 60) as message
  from cron.job_run_details d join cron.job j on j.jobid = d.jobid
 where j.jobname in ('sync-order-status', 'provider-health-monitor', 'notify-admin-anomalies')
 order by d.start_time desc limit 12;
```

**The provider: balance and breaker.** There is no balance-sample table; compare `provider_balance` with the panel and with the number you noted before the order (it should have dropped by about `cost_amount`; the cached value refreshes with the health monitor and the catalogue sync):

```sql
-- live-test: provider-balance
select p.name, p.health_status::text as health, p.provider_balance, p.currency, p.last_balance_sync, p.balance_alert_sent,
       p.sync_backoff_until, p.sync_failure_count
  from public.providers p where p.name = '<PROVIDER NAME>';
```

**Side effects: reconciliation and notifications.**

```sql
-- live-test: side-effects
select 'open reconciliation cases' as what, count(*)::text as value
  from public.reconciliation_cases c where c.status = 'open' and c.entity_type = 'order' and c.entity_id = '<ORDER ID>'
union all
select 'notification ' || n.kind, n.status::text || ' (attempt ' || n.attempts || ')'
  from public.notification_outbox n where n.order_id = '<ORDER ID>'::uuid;
```

**Pass criteria (all of them):**

- [ ] status `completed`, a `provider_order_id` that matches the order at the panel
- [ ] one `purchase` of exactly `-charge_amount`, no refund; `profit_adds_up`, profit not negative
- [ ] `net_wallet_effect = -charge_amount`
- [ ] the panel balance dropped by about `cost_amount`
- [ ] the observer printed `RESULT CLEAN` and never printed `[CRIT]`
- [ ] `sync-order-status` heartbeat fresh, lease free, `sync_failure_count = 0`, `sync_backoff_until` empty
- [ ] no open reconciliation case; the "completed" notification is `sent`

Keep the observer's output (`npm run observe:live -- --timeout 240 > flight-test.log` while also watching, or copy the terminal) with the order id and these query results.

---

## Step 6: Close out

```sql
-- live-test: closeout
begin;
-- no further orders on the flight-test service until you decide to open the store
update public.services set is_active = false where name = 'Telegram Post Views (flight test)';
-- registrations back on (orders stay OFF until the next launch stage)
update public.platform_settings set global_orders_enabled = false, global_signups_enabled = true, updated_by = null, updated_at = now() where id = 1;
insert into public.admin_audit_log (admin_id, action, target_id, details)
values (null, 'live_test_closeout', 'platform_settings', jsonb_build_object('by', session_user, 'at', now()));
commit;
select global_orders_enabled, global_signups_enabled, maintenance_mode from public.platform_settings where id = 1;
```

Take back the unused test funds so wallet balances match deposits again (a negative entry in the same ledger; set the amount to what is left, never more than the balance):

```sql
-- live-test: reclaim-funds
select (public.process_wallet_transaction(
  u.id, 'manual_adjustment', -<UNUSED TEST FUNDS USD>, null,
  'LIVE TEST funding reclaimed', 'live-test-reclaim-' || u.id::text)).balance_after as balance
  from public.users u where u.telegram_id = <YOUR TELEGRAM ID>;
```

Then record the result in the `LAUNCH_PLAN.md` gate checklist (stage 1 and stage 3), and decide the next stage.

---

## Abort: stop everything

**Level 1: stop new orders, now (one statement, under a second).** Nothing already at the provider is touched; it keeps syncing and refunding:

```sql
-- live-test: brake
update public.platform_settings
   set global_orders_enabled = false, global_payments_enabled = false, maintenance_mode = true, updated_by = null, updated_at = now()
 where id = 1;
select global_orders_enabled, global_payments_enabled, maintenance_mode from public.platform_settings where id = 1;
```

**Level 2: the emergency quarantine** (everything in level 1, plus tickets, affiliate transfers, new sign-ups, and a payout freeze at the treasury; one transaction, safe to run twice).
Open `supabase/scripts/emergency_quarantine.sql` in your editor, select all, copy, then:

- **Dashboard -> SQL Editor -> paste -> Run** (works from anywhere, no tools), or
- `psql "$DATABASE_URL" -f supabase/scripts/emergency_quarantine.sql`

Lifting it, and what it does and does not stop: `RUNBOOK.md`, "Emergency quarantine".

**Level 3: cut off the provider** (if the panel itself is the problem: wrong prices, stolen key, orders accepted but never delivered). Follow `RUNBOOK.md`, Scenario A
(the `isolate-provider` block), or just stop routing to it:

```sql
-- live-test: stop-routing
update public.providers set routing_enabled = false where name = '<PROVIDER NAME>';
select name, routing_enabled from public.providers where name = '<PROVIDER NAME>';
```

An order that is stuck or ambiguous is never fixed by guessing: *Admin -> Reconciliation* (RUNBOOK) decides refund or retry once the panel confirms what happened.

---

## Placeholders

| Placeholder | What it is |
| --- | --- |
| `<YOUR TELEGRAM ID>` | your numeric Telegram id (the test account; also the admin that signs the audit entries) |
| `<PROVIDER NAME>` | the provider's name as stored in `providers.name` (also what `secrets:rotate --provider` matches) |
| `<PANEL API URL>` | the panel's HTTPS API endpoint |
| `<PROJECT REF>` | the Supabase project ref (`SUPABASE_PROJECT_REF`) |
| `<PROVIDER SERVICE ID>` | `provider_services.id` chosen in step 2b |
| `<CUSTOMER RATE PER 1000>`, `<MIN QTY>`, `<MAX QTY>` | the storefront price and limits from step 2d |
| `<TEST FUNDS USD>` | the amount credited in step 3 (for example `1.00`) |
| `<UNUSED TEST FUNDS USD>` | what is left to reclaim in step 6 |
| `<ORDER ID>` | the order's UUID, printed by `observe:live` |
