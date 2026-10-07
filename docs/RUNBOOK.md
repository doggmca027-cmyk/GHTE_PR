# GTHE PR: Disaster Recovery & Incident Runbook

Use this page during an incident. Every command can be copied as is: replace only the values in `<ANGLE BRACKETS>`.
Do things **in the order given**: each step makes the next one safer.

| Scenario | First 2 minutes |
| --- | --- |
| [A. Provider API compromised or rogue](#scenario-a-provider-api-compromised-or-rogue) | A1: isolate the provider |
| [B. Treasury or wallet drain suspected](#scenario-b-treasury-or-wallet-drain-suspected) | B1: run the emergency quarantine |
| [C. Secrets compromised](#scenario-c-secrets-compromised) | Quarantine, then rotate in the order of C1 |
| [D. Database corrupted: point-in-time recovery](#scenario-d-database-corrupted-point-in-time-recovery) | Quarantine, then D1 |

---

## 0. Where to run things

You need **one** of these. Try them in this order: the next one still works when the previous one does not.

1. **Admin screen** (Telegram Mini App -> Admin): *Controls* tab for the kill switches, *Providers* tab for routing.
2. **Supabase SQL Editor**: Dashboard -> your project -> SQL Editor -> New query -> paste -> Run. Runs as the database owner.
3. **Supabase CLI** from the project folder, with `.env.local` loaded:

   ```bash
   set -a; . ./.env.local; set +a
   npx supabase db query --linked -f supabase/scripts/emergency_quarantine.sql   # a file
   npx supabase db query --linked "select * from public.platform_settings"       # one statement
   ```

4. **Plain HTTP** (no CLI installed; `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` exported):

   ```bash
   node -e 'process.stdout.write(JSON.stringify({query: require("fs").readFileSync(process.argv[1], "utf8")}))' supabase/scripts/emergency_quarantine.sql \
     | curl -sS -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
         -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" --data-binary @-
   ```

Each step below writes an `admin_audit_log` row (`admin_id` null means the change was made outside the app), so what was done
and when can be traced afterwards.

---

## Emergency quarantine (stop all money movement)

`supabase/scripts/emergency_quarantine.sql` runs in one transaction. It:

* sets `global_orders_enabled = false`, `global_payments_enabled = false` and `maintenance_mode = true`, so new orders and new
  deposits are refused;
* raises `minimum_treasury_reserve` to 999999999, so every new provider payment and top-up approval is refused under its row
  lock;
* cancels the payments that cannot have been sent yet (`PROPOSED`, `APPROVED`, `VALIDATED`), which returns their amount to the
  treasury once;
* lists the payments already past `PAYMENT_CREATED`, which you must check against the chain.

It does **not** stop the workers. Orders already at a provider keep syncing, refunds still happen, and deposits already paid
on-chain are still credited. Stopping those would hurt customers, not an attacker.

The script records a restore point first. Running it twice is safe.

### Lifting the quarantine

Lift it only when the cause is fixed. This puts back exactly what the quarantine found:

```sql
-- runbook-test: lift-quarantine
begin;
update public.platform_settings s
   set global_orders_enabled    = (q.details -> 'previous' ->> 'global_orders_enabled')::boolean,
       global_payments_enabled  = (q.details -> 'previous' ->> 'global_payments_enabled')::boolean,
       maintenance_mode         = (q.details -> 'previous' ->> 'maintenance_mode')::boolean,
       minimum_treasury_reserve = (q.details -> 'previous' ->> 'minimum_treasury_reserve')::numeric,
       updated_by = null, updated_at = now()
  from (select details from public.admin_audit_log
         where action = 'emergency_quarantine' order by created_at desc limit 1) q
 where s.id = 1;
insert into public.admin_audit_log (admin_id, action, target_id, details)
values (null, 'emergency_quarantine_lifted', 'platform_settings', jsonb_build_object('at', now(), 'by', session_user));
commit;
select * from public.platform_settings;
```

---

## Scenario A: Provider API compromised or rogue

**Signs:**
* the provider's prices jump (catalog anomalies show up in *Pricing*);
* orders are "accepted" but never delivered;
* its panel or API key leaked;
* *System Health* shows it failing or answering strangely.

### A1. Isolate the provider, its catalog and its money (one transaction)

The provider is matched by its exact name, as shown in *Admin -> Providers*.

```sql
-- runbook-test: isolate-provider
begin;
create temp table incident_provider on commit drop as
  select id, name from public.providers where name = '<PROVIDER NAME>';
do $$ begin
  if (select count(*) from incident_provider) <> 1 then raise exception 'provider not found (or not unique): check the name'; end if;
end $$;

-- 1. out of routing and out of every worker: no new orders, no health pings, no catalog sync
update public.providers
   set routing_enabled = false, is_active = false, health_status = 'disabled'
 where id = (select id from incident_provider);

-- 2. lock it out: forget its API key, so no worker talks to that API any more
--    (if the key lives in a function secret instead, also run:  npx supabase secrets unset PROVIDER_<NAME>_API_KEY)
update public.providers set api_key_encrypted = null where id = (select id from incident_provider);

-- 3. isolate its catalog: every offer suspended AND flagged, so nothing reactivates it by accident
update public.provider_service_offers
   set is_active = false, anomaly_detected = true,
       anomaly_reason = 'incident: provider isolated', anomaly_detected_at = coalesce(anomaly_detected_at, now())
 where provider_id = (select id from incident_provider);
update public.provider_services set is_active = false where provider_id = (select id from incident_provider);

-- 4. no treasury money can go to it: payout config cleared (validation fails closed), unsent payments canceled
update public.providers
   set allowed_destination_wallet = null, max_topup_per_tx = null, max_daily_topup = null
 where id = (select id from incident_provider);
select public.cancel_provider_payment(p.id, 'incident: provider isolated', null) ->> 'status' as canceled
  from public.provider_payments p
 where p.provider_id = (select id from incident_provider) and p.status in ('PROPOSED', 'APPROVED', 'VALIDATED');
update public.topup_proposals set status = 'rejected', decided_at = now()
 where provider_id = (select id from incident_provider) and status = 'pending';

insert into public.admin_audit_log (admin_id, action, target_id, details)
select null, 'incident_isolate_provider', id::text, jsonb_build_object('provider', name, 'by', session_user, 'at', now())
  from incident_provider;
commit;
```

**What this does to customers:**
* New orders for services that only this provider sold are refused, and nobody is charged.
* Services that other providers also sell route to them on the very next order.

### A2. Its active orders are now paused

With the key gone, the sync worker skips this provider every minute. Its open orders stay exactly as they are. Nothing is
completed, refunded or re-sent automatically.

See what is in flight:

```sql
-- runbook-test: provider-open-orders
select o.status, count(*) as orders, sum(o.charge_amount) as charged_usd, min(o.created_at) as oldest
  from public.orders o join public.providers p on p.id = o.provider_id
 where p.name = '<PROVIDER NAME>' and o.status in ('processing', 'submitted', 'in_progress')
 group by o.status;
```

Decide them one by one in *Admin -> Reconciliation*, or with the provider's panel open:
* **Delivered:** use *Mark resolved*.
* **Never delivered:** use *Force refund*. The customer is refunded once, from the ledger.
* **Unknown:** leave it. Paying twice is worse than waiting.

Pending provider payments past `VALIDATED` were not touched, because the transfer may already be on-chain. Check each against
the chain in *Treasury -> Provider payments*. Use *Mark as Failed* only when it definitely did not arrive.

### A3. Bring the provider back (only with a NEW API key)

1. Get a new key from the provider.
2. Store it:
   ```bash
   npm run secrets:rotate -- provider-key --provider "<PROVIDER NAME>" --store db --apply
   ```
3. Reactivate its catalog offer by offer, by accepting each anomaly in *Pricing*, after checking the prices.
4. Set `is_active` back, then switch routing on in *Admin -> Providers*.
5. Set the payout wallet and limits again in *Edit Config*. Ask the provider to confirm the wallet out of band.

---

## Scenario B: Treasury or wallet drain suspected

**Signs:**
* the treasury balance drops unexpectedly;
* provider payments you did not approve;
* customer balances that grow without deposits;
* a new admin you do not know.

### B1. Quarantine (first, before investigating)

* **Admin screen works:** *Controls*: switch Orders and Payments off, Maintenance on. Then still run the SQL below for the payout
  freeze.
* **UI not reachable:** use any route from section 0:

  ```bash
  set -a; . ./.env.local; set +a
  npx supabase db query --linked -f supabase/scripts/emergency_quarantine.sql
  ```

* **Only the SQL Editor works:** this is the minimum, and the full script is better:

  ```sql
  update public.platform_settings
     set global_orders_enabled = false, global_payments_enabled = false, maintenance_mode = true,
         minimum_treasury_reserve = 999999999, updated_at = now()
   where id = 1;
  ```

### B2. Cut off the attacker

```sql
-- runbook-test: admins
-- who can act as an admin, and since when
select id, telegram_id, username, is_admin, is_banned, created_at from public.users where is_admin order by created_at;
```

```sql
-- demote and ban an account that should not be an admin (the database re-checks is_admin on every admin call)
update public.users set is_admin = false, is_banned = true where id = '<USER UUID>';
```

Then **rotate `JWT_SECRET`** (Scenario C, step C1.3) so every session token issued so far stops working.

Also remove an unknown Telegram id from the `ADMIN_TELEGRAM_IDS` function secret. That list promotes ids on sign-in.

### B3. Find out what moved

```sql
-- runbook-test: treasury-ledger
-- treasury: every movement in the last 48 hours (append-only journal)
select seq, type, amount, balance_after, description, reference_id, created_at
  from public.treasury_transactions where created_at > now() - interval '48 hours' order by seq desc;
```

```sql
-- runbook-test: wallet-ledger
-- customer wallets: unusual credits in the last 48 hours (deposits, bonuses, manual adjustments)
select w.user_id, t.type, t.amount, t.reference_id, t.description, t.created_at
  from public.wallet_transactions t join public.wallets w on w.id = t.wallet_id
 where t.created_at > now() - interval '48 hours' and t.amount > 0 and t.type <> 'refund'
 order by t.amount desc limit 100;
```

```sql
-- runbook-test: audit-log
-- every admin action and outside-the-app change in the last 48 hours
select created_at, admin_id, action, target_id, details from public.admin_audit_log
 where created_at > now() - interval '48 hours' order by created_at desc;
```

```sql
-- runbook-test: payments-in-flight
-- provider payments not settled, with where they go
select p.id, pv.name, p.status, p.amount, p.destination_wallet, p.tx_hash, p.created_by, p.created_at
  from public.provider_payments p join public.providers pv on pv.id = p.provider_id
 where p.status not in ('COMPLETED', 'FAILED', 'CANCELED') order by p.created_at;
```

Compare each payment's `destination_wallet` with the provider's real wallet, and the tx hashes with a TON explorer.

> The on-chain wallets themselves (the TON deposit wallet, and the wallet you pay providers from) are **outside** this system.
> If their seed phrase may have leaked, move the funds to a fresh wallet first.
> Then set the new deposit address in `TON_RECIPIENT_ADDRESS` (`npm run secrets:push`) and redeploy.

### B4. Back to normal

1. Fix the cause.
2. Rotate whatever may have leaked (Scenario C).
3. Correct balances with a *Manual Adjustment* that has a clear description. The journals are append-only and never edited.
4. Lift the quarantine.

---

## Scenario C: Secrets compromised

Quarantine first (B1). Then rotate **in this order**: each step removes a way back in for the attacker.

### C1. Rotation order

| # | Secret | Where | How |
| --- | --- | --- | --- |
| 1 | Supabase access token (`SUPABASE_ACCESS_TOKEN`) | supabase.com -> Account -> Access Tokens | Revoke the old one, create a new one, put it in `.env.local` and in GitHub -> Settings -> Secrets -> `SUPABASE_ACCESS_TOKEN`. **First**: it controls everything else. |
| 2 | Database password (`SUPABASE_DB_PASSWORD`) | Dashboard -> Project Settings -> Database -> *Reset database password* | Put the new one in `.env.local` and in GitHub secret `SUPABASE_DB_PASSWORD`. Direct `psql` sessions using the old one are refused from now on. |
| 3 | JWT secret (`JWT_SECRET`) | Dashboard -> Project Settings -> JWT Keys -> legacy JWT secret -> generate a new one | See C2. Signs everyone out, invalidates every token and changes the anon / service_role keys. |
| 4 | Cron secret (`CRON_SECRET`) | this repo | `npm run secrets:rotate -- cron --apply` |
| 5 | Provider key master key (`PROVIDER_KEY_SECRET`) | this repo | `npm run secrets:rotate -- provider-key-secret --apply` |
| 6 | Each SMM provider API key | the provider's panel, then this repo | Generate a new key at the panel, then `npm run secrets:rotate -- provider-key --provider "<NAME>" --apply` (new key on stdin). |
| 7 | Telegram bot token | @BotFather -> /revoke | `npm run secrets:rotate -- set TELEGRAM_BOT_TOKEN --apply` (new token on stdin) |

Every `secrets:rotate` command:
* is a **dry run unless `--apply`** is given (it prints the plan, writes nothing);
* never prints a value, only names and a short fingerprint;
* refuses to run if `.env.local` lacks `SUPABASE_ACCESS_TOKEN` or `SUPABASE_PROJECT_REF`;
* writes the new value back into `.env.local`, so a later `npm run secrets:push` cannot restore the leaked one.

Pass a new value **through stdin**, never as an argument:

```bash
# bash / Git Bash: paste, then Enter, then Ctrl+D
npm run secrets:rotate -- provider-key --provider "<PROVIDER NAME>" --apply
# or from the clipboard on Windows PowerShell
Get-Clipboard | npm run secrets:rotate -- set TELEGRAM_BOT_TOKEN --apply
```

How each rotation stays safe:
* **`cron`** updates the Vault copy that pg_cron sends and the Edge Function secret together. At most one worker tick in between
  is refused (401). The next tick runs normally, and the workers are idempotent.
* **`provider-key-secret`** decrypts every stored provider key with the old master key **before writing anything**. One key it
  cannot read aborts with no change. It then rewrites all of them in a single compare-and-set statement and sets the new master
  key. For the second in between, a provider call fails to decrypt and is refused **before charging anyone**.

### C2. The JWT secret in detail

1. Generate the new secret: Dashboard -> Project Settings -> JWT Keys -> *legacy JWT secret*.
2. Copy it and give it to the Edge Functions. telegram-auth signs app sessions with it, and the database checks them with it:

   ```bash
   Get-Clipboard | npm run secrets:rotate -- set JWT_SECRET --apply
   ```

3. Copy the new **anon** key, from Project Settings -> API, into:
   * `VITE_SUPABASE_ANON_KEY` in `.env.local`;
   * Vercel -> Project -> Settings -> Environment Variables. Then redeploy the app.
4. `SUPABASE_SERVICE_ROLE_KEY` is injected into the Edge Functions by Supabase, so there is nothing to do there.
5. The pg_cron jobs authenticate with `x-cron-secret`, not with a JWT, so they keep running.

Users simply reopen the Mini App: their next sign-in gets a new token.

### C3. After any rotation

Two minutes later:

```bash
set -a; . ./.env.local; set +a
npx supabase secrets list --project-ref "$SUPABASE_PROJECT_REF"     # names and digests: the rotated ones changed
```

```sql
-- runbook-test: after-rotation
-- the workers still get through (worker heartbeats written in the last 5 minutes)
select worker, last_success_at, last_error_at, last_error from public.worker_heartbeats order by worker;
```

```sql
-- the scheduler still fires (production only: pg_cron)
select j.jobname, d.status, d.start_time from cron.job_run_details d join cron.job j using (jobid)
 order by d.start_time desc limit 8;
```

Finally:
* run `npm run smoke -- --env-file .env.local --secrets-file .env.local`;
* open *Admin -> System Health*: it must show no failing jobs.

---

## Scenario D: Database corrupted: point-in-time recovery

**Signs:**
* rows that are wrong in bulk (balances, orders);
* a destructive statement run by mistake;
* migrations that half-applied.

> PITR is a paid Supabase add-on: Project Settings -> Add-ons -> Point in Time Recovery, on the Pro plan or above.
> Without it, the Pro plan keeps **daily** backups for 7 days (Database -> Backups -> Scheduled backups).
> These steps then work the same, with a coarser restore point.
> **Check today whether PITR is enabled**, not during the incident.

### D1. Before restoring

1. **Quarantine** (B1), so nothing new is written while you decide.
2. **Keep the evidence.** Dump the current, damaged state. The restore replaces it:

   ```bash
   set -a; . ./.env.local; set +a
   npx supabase db dump --linked --data-only -f incident-$(date +%Y%m%d-%H%M).sql
   ```

   The dump holds customer data. Keep it out of git, and delete it when the incident is closed.
3. **Pick the restore time.** It is the last moment the data was right. These queries help:

   ```sql
   -- runbook-test: pitr-timeline
   select created_at, action, target_id from public.admin_audit_log order by created_at desc limit 50;
   select seq, type, amount, created_at from public.treasury_transactions order by seq desc limit 50;
   ```

### D2. Restore

1. Dashboard -> Database -> Backups -> **Point in time**.
2. Choose the date and time: UTC, to the second, **just before** the damage. Then confirm.
3. The project is unavailable while it restores, from minutes to an hour depending on size. Everything after the chosen
   time is gone from the database.

Where the dashboard offers *restore to a new project*, prefer it: restore into a new project, compare, then decide.

### D3. After the restore: things the database no longer knows

The outside world kept going after the restore point. Reconcile these **before** lifting the quarantine:

| What | Why | How |
| --- | --- | --- |
| TON deposits paid after the restore point | The chain has them, the database does not | Check the deposit wallet's transactions in an explorer. Credit each one once with a *Manual Adjustment* that names the tx hash. A tx hash can only ever credit one deposit. |
| Orders sent to providers after the restore point | The provider has them, the database does not | Compare with the provider's order history. Customers charged before the point but delivered after are fine. |
| Provider payments after the restore point | Money may have left the payout wallet | Compare the payout wallet's transactions with *Treasury -> Provider payments*. |
| Migrations applied after the restore point | The schema went back too | `npx supabase db push --dry-run`, then `npx supabase db push`. |
| Secrets rotated after the restore point | The Vault copy of `cron_secret` went back too | `npm run secrets:rotate -- cron --apply` (also brings the function secret back in line). |
| Cron jobs created or changed after the restore point | They live in the database | `select jobname, schedule, active from cron.job;`, then compare with `supabase/cron.example.sql` and migration `20261027000000`. |

Then:
1. Run the smoke test.
2. Check that *System Health* is green.
3. Lift the quarantine.

---

## Afterwards (every incident)

* Write down what happened, the timeline from `admin_audit_log`, what was rotated, and what money was corrected and why.
* If a step in this runbook was wrong or missing, fix it in the same pull request as the incident fix.
