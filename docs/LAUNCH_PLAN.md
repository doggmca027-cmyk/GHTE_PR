# GTHE PR: Controlled Live (Staged Rollout)

Production does not open in one move. Each stage proves one more real capability, with the least money possible at risk.
Move to the next stage only when the current one meets its **exit criteria**. If anything is off, **roll back one stage**
rather than fix forward under traffic.

The tool for every gate is the read-only live smoke test:

```bash
npm run smoke:live -- --stage <N>      # exit 0 = ready for stage N, 1 = something stage N needs is missing
```

* Checks that stage N **needs** show `[FAIL]`. Gaps that only matter for a later stage show `[WARN]`.
* The test never writes anything. It runs SELECTs, lists secret names only, and sends one unauthenticated request per function,
  which the function must refuse.
* For incidents, use [`RUNBOOK.md`](RUNBOOK.md). The emergency quarantine stops everything at any stage in one step.

| Stage | What becomes real | Money at risk | Smoke gate |
| --- | --- | --- | --- |
| 0 | Nothing (mock) | none | `--stage 0` |
| 1 | The SMM provider API (read calls only) | none | `--stage 1` |
| 2 | One TON deposit | one micro-deposit ($1-2) | `--stage 2` |
| 3 | One customer order at the provider | the cheapest order (cents) | `--stage 3` |
| 4 | Treasury pays the provider | at most $1 per payment and $1 per day | `--stage 4` |
| 5 | Everything, public | normal limits | `--stage 5` |

Owner of every step: the admin (you). Write down in the incident notes when each stage started and passed.

---

## STAGE 0: Internal MOCK (current state)

The app and the database are live. No provider is connected, no deposits are configured, and the treasury is empty. Every
customer action that would need a real counterpart is refused before anyone is charged.

**Entry criteria:**
* Migrations up to date: `npx supabase db push --dry-run` reports nothing to push.
* All Edge Functions deployed.
* CI green on `main`.

**Verification:**
* `npm run smoke:live -- --stage 0`: database, functions, core secrets and the cron heartbeats pass.
* *Admin -> System Health* loads, and every scheduled job shows *OK*.
* Dev mock mode (`npm run dev` without backend variables) shows every screen, including Treasury and System Health.

**Exit criteria:**
* The smoke test exits 0 for stage 0.
* *System Health* shows no critical alert other than "No provider is configured".

**Rollback:** nothing to roll back. This is the floor.

---

## STAGE 1: Real provider connected (MOCK_MODE=false), no real deposits

**Goal:** the platform talks to the real SMM panel and gets health, balance and the catalog. No customer can spend money yet.

**Entry criteria:**
* Stage 0 passed.
* A provider account exists at the panel, funded with the smallest amount the panel accepts.
* `MOCK_MODE` is not set as a function secret. The smoke test recognises `MOCK_MODE=true` from its digest.

**Steps:**
1. Add the provider row with its API URL: *Admin -> Providers*, or SQL as in `DEPLOYMENT.md` 1.6.
2. Store its key without it ever appearing in a terminal:
   ```bash
   Get-Clipboard | npm run secrets:rotate -- provider-key --provider "<PROVIDER NAME>" --store db --apply
   ```
3. Keep **Global Orders OFF** in *Admin -> Controls*.
4. Enable routing for the provider. The health monitor pings it within a minute.
5. Trigger one catalog sync (`DEPLOYMENT.md` 1.6). Check prices and margins in *Pricing & Margins*.

**Verification:**
* `npm run smoke:live -- --stage 1`:
  * `provider.routing` passes: active, routing, healthy, keyed, and checked in the last 15 minutes;
  * `secrets.mock-mode` passes;
  * the cron checks pass.
* *System Health -> Provider API health*: check error rate 0 %, latency plausible, balance read.
* *Pricing & Margins*: no service sells at a loss, and no catalog anomaly is left unexplained.

**Exit criteria:**
* The smoke test exits 0 for stage 1.
* The provider has stayed *Healthy* for at least 1 hour.
* No catalog anomaly is pending.

**Rollback:** run Scenario A1 of `RUNBOOK.md` (isolate the provider). Nothing else has changed. It takes 1 minute.

---

## STAGE 2: Real micro-deposit

**Goal:** prove that a real TON payment is matched, credited once, and shows in the wallet. Use your own Telegram account.

**Entry criteria:**
* Stage 1 passed.
* The deposit wallet is a fresh wallet that you control. Its seed phrase is written down offline.

**Steps:**
1. Set `TON_RECIPIENT_ADDRESS` and `TON_NETWORK` in `.env.local`. Use `testnet` first if you can, otherwise `mainnet` with
   the minimum amount. Then run `npm run secrets:push`.
2. Turn **Global Payments ON** and **Maintenance OFF** (*Admin -> Controls*). Global Orders stay **OFF**.
3. In the app: deposit the minimum (`MIN_DEPOSIT_USD`, $1), pay with your wallet, and wait for the credit.

**Verification:**
* `npm run smoke:live -- --stage 2`: `infra.deposit-functions`, `secrets.ton` and the switches pass.
* In the app, the wallet balance rose by exactly the deposit amount.
* In SQL, exactly one completed deposit carries the transaction hash:

  ```sql
  select id, status, amount_usd, tx_hash, completed_at from public.deposits order by created_at desc limit 3;
  ```

* Pressing *Check payment* again changes nothing. The deposit credits once.

**Exit criteria:**
* One real deposit credited exactly once.
* The transaction hash matches the explorer.
* No reconciliation case was opened.

**Rollback:**
* Turn Global Payments OFF.
* To disable deposits at the server, remove the TON secrets:
  ```bash
  npx supabase secrets unset TON_RECIPIENT_ADDRESS TON_NETWORK --project-ref <ref>
  ```
* A deposit already paid on-chain is still credited by `verify-deposit` as long as the secrets are set. Credit a stuck one by
  hand with a *Manual Adjustment* that names the transaction hash.

---

## STAGE 3: One real micro-order

**Goal:** one order goes all the way: charged, routed, accepted by the provider, delivered, and synced to *completed*.

**Entry criteria:**
* Stage 2 passed. Your wallet holds the micro-deposit.
* Pick the cheapest service the provider sells, at its minimum quantity, sent to a target you own.

**Steps:**
1. Turn **Global Orders ON**. Payments stay on, maintenance stays off. Only you know the bot link at this point.
2. Place the order in the app.

**Verification:**
* `npm run smoke:live -- --stage 3` passes.
* The order goes `paid -> processing -> submitted` immediately. Then `in_progress` and `completed` follow as the sync worker
  sees them, one tick per minute.
* *System Health*:
  * no stuck order;
  * *Orders in window* on the provider card is 1, with 0 failed;
  * the logs for the order's correlation id show one `order processed` line with `outcome: submitted`.
* The provider panel shows the same order id. The provider balance dropped by the order's cost, and the cached balance agrees
  within one sync.

**Exit criteria:**
* The order is delivered and *completed*.
* The margin matches *Pricing & Margins*.
* No reconciliation case was opened.

**Rollback:**
* Turn Global Orders OFF.
* If the order is stuck, decide it in *Reconciliation*. *Force refund* only once the provider confirms it will not deliver.

---

## STAGE 4: Provider payments enabled, $1 limits

**Goal:** the treasury pays the provider for real, through every state:

`VALIDATED -> PAYMENT_CREATED -> BROADCASTED -> CONFIRMING -> CONFIRMED -> PROVIDER_BALANCE_VERIFIED -> COMPLETED`

The hard limits make the worst case $1.

**Entry criteria:**
* Stage 3 passed.
* In the provider's *Edit Config*:
  * the payout wallet is set, after confirming it with the provider out of band;
  * **max per top-up = 1**;
  * **max per day = 1**.
* Treasury: set a reserve (*Set reserve*, for example $5). Fund the treasury above it with a *Manual Adjustment* that has a
  clear description.

**Steps:**
1. Get a $1 proposal. In *Edit Config*, set the low-balance threshold at or above the current balance and the top-up target
   about $1 above it. The health monitor files the proposal (target minus balance) within a minute.
2. Approve it. The payment goes to *Ready to send*.
3. Send exactly the instructed amount from the payout wallet. Then use *Record Broadcast* and paste the transaction hash.
4. Advance it: *Confirming*, then *Confirmed* (after checking the explorer), then *Balance Verified* (after checking the
   provider panel), then *Complete*.

**Verification:**
* `npm run smoke:live -- --stage 4`:
  * `provider.payout-limits` and `provider.stage4-limits` pass (every limit at most $1);
  * `treasury.reserve` and `treasury.balance` pass.
* A second approval the same day is refused with `max_daily_topup_exceeded`. That shows the hard limit works.
* The treasury ledger shows exactly one `provider_topup` of $1.
* No `provider_payment` reconciliation case is open. If one opens (Rule A: confirmed but not credited after 30 minutes), resolve
  it before going on.

**Exit criteria:**
* One payment reached `COMPLETED`.
* The limit refusal was observed.
* Treasury balance plus provider payments add up to the ledger.

**Rollback:**
* Clear the payout config (empty wallet). This refuses all top-ups and fails closed.
* Payments that were not sent can be cancelled (money back).
* Payments that were sent go to *Reconciliation*, never to *Mark as Failed* without proof.
* In doubt: `supabase/scripts/emergency_quarantine.sql`.

---

## STAGE 5: Full production

**Entry criteria:**
* Stages 1-4 passed.
* `RUNBOOK.md` read, and the quarantine rehearsed once on a test project or in dev.
* PITR or daily backups confirmed active (RUNBOOK D).
* `ALLOWED_ORIGIN` set to the app URL.
* `TONCENTER_API_KEY` set.

**Steps:**
1. Raise the payout limits to normal values (*Edit Config*): what the provider really needs per top-up and per day. Keep the
   daily limit as low as operations allow.
2. Set the treasury reserve to your real safety margin.
3. Open the bot to the public: menu button, announcement.
4. Watch *System Health* closely for the first 24 hours.

**Verification:** `npm run smoke:live` (stage 5 is the default) exits 0, with no `[WARN]` left.

**Exit criteria:**
* 24 hours with *System Health* green.
* Every reconciliation case resolved within a day.
* No unexplained treasury movement.

**Rollback:**
* Partial: switch off just the failing capability (Orders, Payments, a provider's routing).
* Total: the emergency quarantine (`RUNBOOK.md`, B1). After the fix, lift it and re-enter at the stage that failed.

---

## Gate checklist (copy per stage)

```
Stage __  started ____-__-__ __:__ UTC   by ______
[ ] entry criteria met
[ ] npm run smoke:live -- --stage __  -> exit 0   (paste the summary line)
[ ] verification steps done (notes / ids / tx hashes)
[ ] exit criteria met at ____-__-__ __:__ UTC
[ ] rollback procedure known and the switch/command at hand
```
