# Production deployment guide

Telegram Mini App (React + Vite) on **Vercel**, backend on **Supabase** (Postgres + Edge Functions),
payments on **TON** (TON Connect + Toncenter), notifications through your **Telegram bot**.

Every command below is copy-paste ready. Anything in `<angle brackets>` is yours to fill in.
**Do the steps in order**: later steps need values produced by earlier ones.

| # | Step | You get |
|---|------|---------|
| 0 | Prerequisites | accounts + tools |
| 1 | Supabase: database, secrets, functions, schedulers | the backend |
| 2 | Telegram bot (@BotFather) | bot token, menu button |
| 3 | Vercel: frontend | the public URL |
| 4 | Close the loop (CORS, manifest, menu button) | everything points at everything |
| 5 | Verify: `npm run smoke` | a green report |
| 6 | Go-live rehearsal on testnet, then mainnet | confidence |

> **How the pieces trust each other** (read once, it explains most failures)
>
> 1. The browser sends Telegram's signed `initData` to the `telegram-auth` function.
> 2. The function verifies the signature with `TELEGRAM_BOT_TOKEN` and returns a JWT **signed with `JWT_SECRET`**.
> 3. The browser sends that JWT to Supabase REST (RLS) **and** to the other functions.
>
> So `JWT_SECRET` must be the **project's own JWT secret**: Supabase must accept the tokens too.
> Getting this wrong is the single most common production problem; `npm run smoke` tests it.

---

## 0. Prerequisites

* A Supabase account and a **new, empty** Supabase project (paid plan recommended: free projects pause when idle).
* A Vercel account and a GitHub account.
* A Telegram account, and a TON wallet you control (Tonkeeper) to **receive** deposits.
* A live SMM panel account that speaks the standard "SMM v2" API (`key`, `action=services|add|status|balance`), with its API URL and key.
* On your machine: **Node 22.18+** (24 recommended) and npm.

```bash
node -v                      # v22.18+ (type-stripping is used by the deployment scripts)
npm ci                       # install exactly what package-lock.json says
npx supabase --version       # the CLI is run through npx; or: npm i -g supabase
```

> This folder is not a git repository yet. Before step 3 (and for CI/CD, section 7):
> ```bash
> git init -b main && git add . && git commit -m "Initial commit"
> ```
> `.gitignore` already excludes every real env file. `npm run scan:secrets` proves nothing secret is about to be committed.

Run the full local gate once before you start. It must be green:

```bash
npm run check        # secret scan + Supabase audit + 400+ tests + production build
```

---

## 1. Supabase

### 1.1 Collect the project values

In the Supabase dashboard open your project and note:

| Value | Where | Used for |
|-------|-------|----------|
| **Reference ID** (`<PROJECT_REF>`, 20 letters) | Project Settings → General | CLI, URLs |
| **Project URL** `https://<PROJECT_REF>.supabase.co` | Project Settings → API | `VITE_SUPABASE_URL` |
| **anon / publishable key** | Project Settings → API Keys | `VITE_SUPABASE_ANON_KEY` (public) |
| **JWT secret** (legacy HS256 secret) | Project Settings → API (or "JWT Keys") | the `JWT_SECRET` function secret |
| **Database password** | the one you chose at creation (reset it under Project Settings → Database if lost) | `supabase link`, CI |

> **Never use the `service_role` / secret key in the frontend.** Supabase injects it into Edge Functions by itself.
>
> If your dashboard only shows the newer *asymmetric* signing keys, keep the **legacy JWT secret** enabled
> (do **not** revoke it): this app signs HS256 tokens with it. `npm run smoke` fails with
> `postgrest-accepts-jwt` if Supabase rejects them.

### 1.2 Link the project

```bash
npx supabase login                                    # opens the browser once
npx supabase link --project-ref <PROJECT_REF>         # asks for the database password
```

### 1.3 Apply the database migrations

```bash
npx supabase db push --dry-run     # shows exactly what will run
npx supabase db push               # applies supabase/migrations/*.sql in order
```

* Applies 6 migrations: schema + ledger + state machine, refill flag, TON deposits, partial refunds,
  admin + notifications, and a lock-down of helper functions.
* **Never run `supabase/seed.sql` in production** (and `db push` does not). It creates a fake provider, fake services and
  a fake price rule for local development only.
* The migrations are **forward-only**. To change the schema later, add a new migration file; never edit an applied one.

Before pushing you can audit them without touching your project (CI does this too):

```bash
npm run check:supabase     # applies every migration to a throw-away Postgres and verifies RLS / grants / function exposure
```

### 1.4 Secrets (Edge Function environment)

**Required**

| Secret | What it is | How to produce it |
|--------|------------|-------------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather (step 2). Verifies sign-in, sends notifications. | BotFather → `/newbot` |
| `JWT_SECRET` | The project's JWT secret (1.1). | Dashboard → Project Settings → API |
| `CRON_SECRET` | Protects the worker functions from outside callers. | `openssl rand -hex 32` |
| `TON_RECIPIENT_ADDRESS` | **Your** wallet that receives deposits, user-friendly form `UQ…`/`EQ…`. Never accepted from clients. | Tonkeeper → Receive |
| `TON_NETWORK` | Exactly `mainnet` or `testnet` (anything else silently means mainnet). | type it |
| `PROVIDER_<NAME>_API_KEY` | API key of your live SMM provider (see rule below). At least one. | provider dashboard |

**Strongly recommended**

| Secret | What it is |
|--------|------------|
| `ADMIN_TELEGRAM_IDS` | Comma-separated Telegram user ids that become admins on their next sign-in, e.g. `123456789,987654321`. Get yours from @userinfobot. Bootstrap only: it never *removes* an admin. |
| `ALLOWED_ORIGIN` | Your app origin, e.g. `https://your-app.vercel.app` (no path, no trailing slash). Without it the functions answer any website. |
| `TONCENTER_API_KEY` | Free key from <https://t.me/tonapibot>. Without it Toncenter allows about 1 request/second and deposit verification can be throttled. |

**Optional**: `SYNC_BATCH_SIZE` (default 50), `RECONCILE_AFTER_MINUTES` (default 60), `TONCENTER_URL`,
`PROVIDER_KEY_SECRET` (only if you store provider keys AES-encrypted in `providers.api_key_encrypted`).

**Injected by Supabase, do not set:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (names starting with `SUPABASE_` are rejected).

**Must NOT exist in production:** `MOCK_MODE`, `TON_USD_FALLBACK_RATE`. With `MOCK_MODE=true` the platform would accept orders
without ever calling the provider.

**Provider key naming rule.** Take the provider's `name` as stored in the `providers` table, upper-case it, replace
every run of non-alphanumeric characters with a single `_`, and wrap it as `PROVIDER_<NAME>_API_KEY`:

| `providers.name` | Secret name |
|------------------|-------------|
| `Secsers` | `PROVIDER_SECSERS_API_KEY` |
| `My Panel.io` | `PROVIDER_MY_PANEL_IO_API_KEY` |

Everything lives in **one git-ignored file, `.env.local`** (a template with every name is `.env.example`):
the Supabase CLI block, the Edge Function secrets block and the frontend block. Fill in the values, **validate**, then upload:

```bash
cp .env.example .env.local        # first time only; then fill in the values (empty value = "not set")

npm run verify:secrets            # checks formats, TON address vs network, MOCK_MODE, naming... (never prints values)
npm run secrets:push              # validates again, then uploads ONLY the function secrets to your project
npx supabase secrets list --project-ref <PROJECT_REF>   # names + digests (values are never shown)
```

`secrets:push` sends only the Edge Function secrets from the file: never `VITE_*`, the CLI token or the DB password.
`npm run secrets:push -- --dry-run` validates and lists the names without uploading. To run the Supabase CLI by hand with the token from
the file: `set -a; . ./.env.local; set +a`. The file is git-ignored; keep a copy in your password manager.

### 1.5 Deploy the Edge Functions

```bash
npx supabase functions deploy          # deploys all six; reads verify_jwt = false from supabase/config.toml
npx supabase functions list
```

The functions: `telegram-auth`, `place-order`, `create-deposit`, `verify-deposit` (called by the app) and
`sync-catalog`, `sync-order-status` (called by the scheduler, protected by `CRON_SECRET`).
`verify_jwt = false` is intentional: each function authenticates itself (Telegram signature, our JWT, or the cron secret).
`npm run check:supabase` fails if a function is missing from `config.toml`.

Changing a secret later (`supabase secrets set …`) takes effect on the next invocation; no redeploy needed.

### 1.6 Register your provider, pricing, first catalogue

Open **SQL Editor** and run (adjust the name and URL; the name decides the secret name from 1.4):

```sql
-- your live SMM provider (the API key is NOT stored here, it comes from the PROVIDER_<NAME>_API_KEY secret)
insert into providers (name, api_url, is_active, priority)
values ('Secsers', 'https://<panel-domain>/api/v2', true, 10);

-- default markup: customer price = provider cost +150% (x2.5). Without a rule you only earn the 1-cent minimum margin.
insert into price_rules (name, type, value, priority)
values ('Default +150%', 'percentage', 150, 0);
```

Import the catalogue (one-off now, then the scheduler keeps it fresh). Use the `CRON_SECRET` from 1.4:

```bash
curl -sS -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/sync-catalog" \
  -H "x-cron-secret: <CRON_SECRET>" -H "Content-Type: application/json" -d '{}'
```

**Switch routing on for the provider.** Orders are routed through `provider_service_offers` and only to providers that are
`routing_enabled` **and** `health_status = 'healthy'`. A new provider starts as `routing_enabled = false`, `health_status = 'disabled'`
(nothing sets health automatically yet), so until you run this every order answers "temporarily unavailable" and nobody is charged:

```sql
update providers set routing_enabled = true, health_status = 'healthy' where name = 'Secsers';
-- take a provider out of rotation again: update providers set routing_enabled = false where name = 'Secsers';
```

The catalogue sync creates a service's offer automatically and keeps its cost in step with the provider's price.
Each order stores which offer served it (`orders.provider_offer_id`, `cost_amount`, `profit_amount`, `routing_score_snapshot`).

You get `{"added":N,"updated":0,"deactivated":0,"providers":[…]}`. A provider with `"status":"skipped"` and
`no API key configured` means the secret name does not match the rule in 1.4.
Review prices in the app's **Admin → Price rules** and the services in the SQL editor
(`select name, customer_rate_per_1000 from services order by 1;`) before opening to users.

### 1.7 Schedule the workers

Two jobs must run on a timer: **`sync-order-status` every minute** (progress, refunds, partial refunds, stuck orders)
and **`sync-catalog` every 6 hours** (prices, catalogue, cached provider balance).

**Option A: inside Supabase (recommended).**
Dashboard → Database → Extensions: enable **`pg_cron`** and **`pg_net`**. Then open
[`supabase/cron.example.sql`](supabase/cron.example.sql), replace `<PROJECT_REF>` and `<CRON_SECRET>`, and run it once in the SQL editor.
Check it works a minute later:

```sql
select * from cron.job;
select status, start_time, return_message from cron.job_run_details order by start_time desc limit 5;
select status_code, content::text from net._http_response order by created desc limit 5;   -- must show 200
```

**Option B: any external scheduler** (GitHub Actions cron, cron-job.org, a VPS): send
`POST https://<PROJECT_REF>.supabase.co/functions/v1/sync-order-status` with header `x-cron-secret: <CRON_SECRET>` every minute
and the same for `sync-catalog` every 6 hours. Overlapping runs are safe: money movement is idempotent in the database.

> There is **no Telegram webhook** to configure: the bot only *sends* messages. Users must have opened the bot at least once
> (they have, if they launch the Mini App from the bot). Users who blocked the bot are skipped silently.

### 1.8 Make yourself admin

If you set `ADMIN_TELEGRAM_IDS`, sign in once through the bot (step 4) and the **Admin** tab appears. Otherwise, by SQL:

```sql
update users set is_admin = true where telegram_id = <YOUR_TELEGRAM_ID>;   -- the user row exists after the first sign-in
-- revoke:  update users set is_admin = false where telegram_id = <ID>;
```

Both ways are written to `admin_audit_log`. The database re-checks `is_admin` on **every** admin call;
nothing in the browser can grant it.

---

## 2. Telegram bot (@BotFather)

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) → `/newbot` → choose a name and a username ending in `bot`.
   Copy the token it prints into `TELEGRAM_BOT_TOKEN` (1.4). Treat it like a password.
   Optional polish: `/setdescription`, `/setabouttext`, `/setuserpic`.
2. **Menu button** (opens the Mini App from the chat): you need the Vercel URL from step 3, so do this in **step 4.3**.
   Path: `/mybots` → your bot → **Bot Settings → Menu Button → Configure menu button** → send the URL → send a title (e.g. `Open`).
3. **Direct link** (recommended, shareable `t.me/<bot>/<app>`): `/newapp` → pick the bot → title, description, 640×360 photo →
   Web App URL = your Vercel URL → short name (e.g. `app`). Your link is `https://t.me/<bot_username>/<short_name>`;
   this is the value for `VITE_TWA_RETURN_URL` (step 3).
4. **Inline mode / `/setinline`, `/setdomain`**: not used by this app. Leave them off.

The app asks Telegram to expand to full height and sets header colours itself; no extra permissions are required.
Wallet approvals use the TON Connect deep link and return through `VITE_TWA_RETURN_URL`.

---

## 3. Vercel (frontend)

### 3.1 Import the project

1. Push the repository to GitHub (`git remote add origin <url> && git push -u origin main`).
2. Vercel → **Add New… → Project** → import the repo.
3. Check the settings Vercel detected (all come from [`vercel.json`](vercel.json), nothing to type):

| Setting | Value |
|---------|-------|
| Framework Preset | Vite |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Node.js Version | 22.x or 24.x |
| *Automatically expose System Environment Variables* | **on** (default) |

### 3.2 Environment variables

Project → **Settings → Environment Variables**. Add these for **Production** (and Preview if you use previews):

| Variable | Value | Required |
|----------|-------|----------|
| `VITE_SUPABASE_URL` | `https://<PROJECT_REF>.supabase.co` | **yes** |
| `VITE_SUPABASE_ANON_KEY` | the **anon / publishable** key (public) | **yes** |
| `VITE_TWA_RETURN_URL` | `https://t.me/<bot_username>/<short_name>` | recommended |
| `APP_URL` | your public origin, **only if you use a custom domain**, e.g. `https://app.example.com` | custom domain only |
| `TERMS_URL`, `PRIVACY_URL` | only to override the built-in pages (default: `<site>/terms`, `<site>/privacy`) | optional |

> * **Everything prefixed `VITE_` is published in the browser bundle.** Never put a secret there.
>   The build **fails** if it finds a service-role key, a bot token, or a `VITE_…SECRET`-style name.
> * **Do not set `VITE_MOCK_MODE`.** It serves *fake* data. The production build fails if it is `true`
>   (`.env.production` pins it to `false`).
> * There is **no `VITE_TON_NETWORK`**: the network (`mainnet`/`testnet`) is decided server-side by `TON_NETWORK`,
>   returned with every deposit quote, and the app shows a "Testnet: no real funds" notice when it is `testnet`.
> * `VITE_TONCONNECT_MANIFEST_URL` is only for hosting the manifest elsewhere; leave it unset.

Then **Deploy**.

### 3.3 What the build checks for you

`npm run build` runs three guards automatically (on Vercel too):

1. **`prebuild`**: `scripts/verify-env.ts`. In a Vercel *production* build it **fails** on a missing/invalid
   `VITE_SUPABASE_*`, a privileged key in the browser variable, a key from a different project, `VITE_MOCK_MODE=true`,
   a secret-looking `VITE_` variable, or an unknown public URL. Locally it only **warns**. Run it by hand with
   `npm run verify:env`, or `STRICT_ENV=1 npm run verify:env` to apply production rules.
2. `tsc --noEmit` (strict TypeScript) and `vite build` (no source maps; chunks over 500 kB are flagged).
3. **`postbuild`**: `scripts/postbuild.ts` scans the finished bundle and **fails** if it contains any server-only name
   (`JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, …) or credential, and publishes the TON Connect manifest (4.2).

### 3.4 Security headers

[`vercel.json`](vercel.json) sets `nosniff`, a strict referrer policy, a `Permissions-Policy`, a `frame-ancestors` CSP that lets
**Telegram Web embed the app** (and nobody else), long-lived caching for hashed assets, and the CORS header the TON Connect
manifest needs. Do not add `X-Frame-Options: DENY`: it would break the Mini App in Telegram Web.

---

## 4. Close the loop

### 4.1 Tell Supabase where the app lives (CORS)

```bash
npx supabase secrets set ALLOWED_ORIGIN=https://<your-app-domain>      # e.g. https://your-app.vercel.app, no trailing slash
```

(Put it in `.env.local` as well and run `npm run secrets:push`, so the file stays the source of truth.)

### 4.2 TON Connect manifest

Wallets fetch `https://<your-app-domain>/tonconnect-manifest.json` to learn who is asking for a connection. It needs your real
origin, an absolute **PNG** icon URL, and a public CORS header (already in `vercel.json`).

* The repository keeps a placeholder in `public/tonconnect-manifest.json`. **You do not edit it.**
  At build time `postbuild` publishes `dist/tonconnect-manifest.json` with every URL rewritten to `APP_URL`
  (or Vercel's production domain, detected automatically). The production build fails if it cannot determine the origin.
* Custom domain? Set `APP_URL` in Vercel (3.2) and redeploy.
* Verify in a browser: open `https://<your-app-domain>/tonconnect-manifest.json` →
  `{"url":"https://<your-app-domain>", "name":"SMM Mini App", "iconUrl":"https://<your-app-domain>/tonconnect-icon.png"}`.
* To rebrand, change `name` in `public/tonconnect-manifest.json` and replace `public/tonconnect-icon.png` (180×180 PNG).

### 4.3 Point the bot at the app

BotFather → `/mybots` → your bot → **Bot Settings → Menu Button → Configure menu button** → URL = `https://<your-app-domain>`.
(`/newapp` from step 2.3 uses the same URL.) After any domain change, repeat both.

---

## 5. Verify the deployment: `npm run smoke`

The smoke test probes the live system: DB migrations applied, anonymous access locked down, admin gate, JWT secret agreement
between Supabase and the functions, every function deployed with its secrets, CORS, the site, manifest, bundle,
Telegram bot and menu button, TON address and the Toncenter response shape. It only reads or sends deliberately invalid
requests; it never creates orders or moves money.

The smoke test reads the same `.env.local`: it needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public key only: the script refuses a service-role key)
and `APP_URL`, and uses `JWT_SECRET` (authentication checks, strongly recommended), `CRON_SECRET` (for `--run-workers`),
`TELEGRAM_BOT_TOKEN`, `TON_RECIPIENT_ADDRESS`, `TON_NETWORK` and `TONCENTER_API_KEY` when they are filled in. Anything missing is skipped, not failed.

```bash
npm run smoke -- --env-file .env.local --secrets-file .env.local --run-workers
```

Reading the report:

* **`0 failed`** (exit code 0) is the bar. **`WARN`** items are advice (for example `ALLOWED_ORIGIN` still `*`).
* Any `CRITICAL` line is a data-exposure problem: stop and fix it before sending users.
* **`toncenter`** failing with *"Do NOT go live"* means Toncenter's response is not what `verify-deposit` parses, so deposits
  would never confirm. That parser follows Toncenter's v3 documentation but could not be exercised against the live API during
  development: this check, plus the testnet rehearsal in step 6, is how you confirm it.

Run it again after every deployment. CI-friendly: it exits `1` on any failure.

---

## 6. Go-live rehearsal

**6.1 Testnet first (strongly recommended).** Temporarily set `TON_NETWORK=testnet` and `TON_RECIPIENT_ADDRESS=<testnet address>`
(Tonkeeper → Settings → Developer mode → testnet wallet; faucet: <https://t.me/testgiver_ton_bot>), re-run `npm run smoke`, then in the real
Telegram app:

1. Open the bot → **Open**. You land signed in, with a $0.00 balance.
2. **Wallet → Top Up** → $5 → *Connect Tonkeeper* → *Pay*. Approve in Tonkeeper.
   Within roughly 10–60 seconds the step bar reaches **Credited**, the balance increases, a **Telegram message** arrives.
   If it stays on *Verifying*: open Dashboard → Edge Functions → `verify-deposit` → Logs, and re-run the `toncenter` smoke check.
3. **Services** → pick the cheapest → paste a real link → minimum quantity → **Order Now**. It appears in **Orders**, moves to
   *In progress* then *Completed* (the minute-by-minute scheduler at work), and you get a "completed" message.
4. Try a deliberately bad link: the provider rejects it and you are **refunded automatically**.
5. With your admin account: **Admin → Overview** shows revenue/profit, **Reconciliation** is empty, **Price rules** edits persist.

**6.2 Switch to mainnet.**

```bash
# in .env.local set TON_NETWORK=mainnet and the real TON_RECIPIENT_ADDRESS, then:
npm run verify:secrets
npm run secrets:push
npm run smoke -- --env-file .env.local --secrets-file .env.local
```

Repeat the deposit with the smallest amount ($1) and one real order. Only then announce the bot.

---

## 7. Continuous deployment (GitHub → Vercel + Supabase)

| Trigger | What happens |
|---------|--------------|
| Any push / pull request | `.github/workflows/ci.yml`: secret scan, Supabase audit, all tests, production build |
| Push to `main` touching `supabase/**` | `.github/workflows/deploy-supabase.yml`: audit + tests, then `db push` and `functions deploy` |
| Push to `main` (anything) | Vercel's GitHub integration builds and deploys the frontend |

Add these **GitHub → Settings → Secrets and variables → Actions → Repository secrets** (used only by the Supabase deploy job):

| GitHub secret | Value |
|---------------|-------|
| `SUPABASE_ACCESS_TOKEN` | personal access token: <https://supabase.com/dashboard/account/tokens> |
| `SUPABASE_DB_PASSWORD` | the database password |
| `SUPABASE_PROJECT_ID` | `<PROJECT_REF>` |

Optional but wise: GitHub → Settings → Environments → create **`production`** and add *required reviewers*, so a person approves every backend deploy.
In Vercel enable *Settings → Git → Protected previews* if previews should not be public.

Function **secrets are never touched by CI**. Rotating or adding one is always a deliberate manual `supabase secrets set`.
A backend change that needs a new secret must set the secret **before** merging.

---

## 8. Security checklist

* [ ] `npm run scan:secrets` is green; `git ls-files | grep -E '(^|/)\.env'` lists only `.env.example`, `.env.production`, `supabase/functions/.env.example` (never `.env.local`).
* [ ] `VITE_SUPABASE_ANON_KEY` is the anon/publishable key. The service-role key exists only inside Supabase.
* [ ] `MOCK_MODE` and `VITE_MOCK_MODE` are **not set** anywhere in production.
* [ ] `JWT_SECRET`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN` are unique to this project and stored in a password manager.
* [ ] `ALLOWED_ORIGIN` is your origin, not `*`.
* [ ] `ADMIN_TELEGRAM_IDS` lists only people you trust; each admin action is in `admin_audit_log`.
* [ ] `npm run smoke` is green, in particular `anon-lockdown`, `admin-gate`, `forged-token-rejected`, `bundle-secrets`.
* [ ] The TON wallet behind `TON_RECIPIENT_ADDRESS` is yours, backed up, and ideally a dedicated cold-ish wallet you sweep regularly.
* [ ] Database backups: Supabase → Database → Backups (daily on paid plans; enable Point-in-Time Recovery for a financial ledger).

**Rotation**

| Secret | How |
|--------|-----|
| `TELEGRAM_BOT_TOKEN` | BotFather → `/revoke`, then `supabase secrets set TELEGRAM_BOT_TOKEN=…` |
| `CRON_SECRET` | `supabase secrets set CRON_SECRET=…` **and** in Vault: `select vault.update_secret((select id from vault.secrets where name='cron_secret'), '<new>');` |
| `JWT_SECRET` | rotating the project JWT secret signs everyone out; update the secret and ask users to reopen the app |
| `PROVIDER_*_API_KEY` | `supabase secrets set …`, then `npm run smoke -- --run-workers` |

---

## 9. Operating it

* **Logs**: Dashboard → Edge Functions → *function* → Logs. Worker output lines start with `sync-order-status:` / `sync-catalog:`.
* **Orders that need a human** appear in **Admin → Reconciliation** (held in `processing` for 10+ minutes, or a refund still owed).
  *Force refund* returns the money; *Mark resolved* needs the provider order id from the provider's panel. The worker also
  auto-refunds anything unconfirmed after `RECONCILE_AFTER_MINUTES` (60).
* **Provider balance** is shown (cached) in Admin → Overview. Top it up before it runs dry: an empty provider means rejected orders and automatic refunds.
* **Price changes**: edit in Admin → Price rules; they reach customers on the next catalogue sync (≤ 6 h), or trigger it now with the `curl` from 1.6.
* **Rolling back**: Vercel → Deployments → *Promote* a previous build. Edge Functions: `git revert` and let CI redeploy.
  Migrations are forward-only: fix with a new migration (never `db reset` on production).
* **USDT** deposits are intentionally disabled (the app shows "Soon"). TON only.

---

## 10. Troubleshooting (smoke check id → fix)

| Smoke check / symptom | Cause | Fix |
|-----------------------|-------|-----|
| `reachable` fails | wrong URL, paused project, wrong anon key | check `SUPABASE_URL`/key; un-pause the project |
| `migrations-applied` / `anon-lockdown` "not found" | migrations not applied | `npx supabase db push` |
| `anon-lockdown` **CRITICAL** | a table is readable by anon | do not launch; run `npm run check:supabase` and inspect grants/RLS |
| `postgrest-accepts-jwt` fails | `JWT_SECRET` is not the project's (legacy) JWT secret | copy it from Project Settings → API; do not revoke the legacy secret |
| `jwt-secret-matches` fails | the **function** secret differs from the one you tested with | `supabase secrets set JWT_SECRET=…` |
| any function: "not deployed" | functions not deployed | `npx supabase functions deploy` |
| any function: 500/503 "secret is missing" | a required secret is unset or misnamed | `npm run verify:secrets`, then `npm run secrets:push` |
| `create-deposit` 503 | `TON_RECIPIENT_ADDRESS` missing/invalid | fix and re-set the secret |
| `cors` fails | `ALLOWED_ORIGIN` ≠ the app origin | set it to the exact origin |
| `manifest`, `manifest-cors`, `manifest-icon` | placeholder URL, missing icon, CORS | confirm `APP_URL`; keep `vercel.json` headers |
| `menu-button` | BotFather still points at the old URL | step 4.3 |
| `toncenter` shape / HTTP error | API change or wrong network/key | see the note in step 5; run the testnet rehearsal |
| Build fails with `verify-env` errors | the message names the variable | fix the Vercel variable and redeploy |
| Wallet "Connect" does nothing / wallet shows wrong app | manifest URL or origin mismatch | 4.2 |
| Deposit stuck on "Verifying" | payment not found by memo/amount/recipient, or Toncenter throttled | check the deposit in `deposits`; add `TONCENTER_API_KEY`; the payment is on-chain and can be credited by support after review |
| No Telegram messages | user blocked/never opened the bot, or `TELEGRAM_BOT_TOKEN` wrong | the `bot-token` smoke check; messages to blocked users are skipped by design |
| Orders never leave "Submitted" | the scheduler is not running | 1.7 and `select * from cron.job_run_details …` |

---

## Reference

### Scripts

| Command | Purpose |
|---------|---------|
| `npm run check` | everything CI runs: `scan:secrets` → `check:supabase` → `test` → `build` |
| `npm run verify:env` | what the client build will see (`STRICT_ENV=1` = production rules) |
| `npm run verify:secrets [-- file]` | validate the Edge Function secrets in `.env.local` before uploading |
| `npm run secrets:push [-- --dry-run]` | validate, then upload the function secrets from `.env.local` to Supabase |
| `npm run scan:secrets` | hard-coded secret scan + `.gitignore` guard |
| `npm run check:supabase` | migrations on a fresh database + RLS / grants / function-exposure audit |
| `npm run smoke -- --env-file .env.local …` | live production smoke test |
| `npm run build` | `verify-env` → typecheck → bundle → `postbuild` (manifest + bundle leak scan) |

### Everything in one place

**Supabase secrets**: `TELEGRAM_BOT_TOKEN`, `JWT_SECRET`, `CRON_SECRET`, `TON_RECIPIENT_ADDRESS`, `TON_NETWORK`,
`PROVIDER_<NAME>_API_KEY` (required) · `ADMIN_TELEGRAM_IDS`, `ALLOWED_ORIGIN`, `TONCENTER_API_KEY` (recommended) ·
`SYNC_BATCH_SIZE`, `RECONCILE_AFTER_MINUTES`, `TONCENTER_URL`, `PROVIDER_KEY_SECRET` (optional).

**Vercel variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required) · `VITE_TWA_RETURN_URL` (recommended) ·
`APP_URL` (custom domain), `TERMS_URL`, `PRIVACY_URL` (optional).

**GitHub secrets**: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`.
