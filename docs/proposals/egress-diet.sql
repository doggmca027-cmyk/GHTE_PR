-- =============================================================================
-- EGRESS DIET: the scheduled workers made ~95% of the project's API requests. Approved by the owner on 2026-11-06, together with item 4 (sync-catalog
-- every 15 minutes); the fill-storefront-gaps job was left as it was.
--
-- WHY. The free plan of Supabase allows 5 GB of egress a month; on 2026-11-06 the project was restricted (HTTP 402 exceed_egress_quota on REST, Auth and
-- the sign-in function). pg_stat_statements since 2026-10-06 shows 1.58 million REST requests, ~65 000 a day, and what they were:
--
--     UPDATE providers                    421 470   26.6 %   the health monitor: two updates per provider per minute
--     INSERT provider_health_log          208 722   13.2 %   the health monitor: one row per provider per minute
--     worker locks + heartbeats           300 450   19.0 %   record_worker_heartbeat, try_acquire_worker_lock, release_worker_lock
--     reads of offers / services / ...    ~420 000  26   %   sync-catalog (every 5 min), the arbitrage and the chat
--     order sync + notifier polling       ~160 000  10   %   get_order_sync_batch, unfunded_orders_summary, expire_stale_paid_orders, claim_notification_batch
--     the app of the customers (platforms, categories, orders)  ~9 000  < 1 %
--
-- WHAT THIS CHANGES (the work that is really there is still done, as fast as before):
--   1. provider-health-monitor      every minute -> every 5 minutes.                                        (-80 % of its ~680 000 requests a month)
--   2. sync-order-status            every minute -> every minute ONLY when an order needs it (in flight, a refund owed, paid and waiting), otherwise
--                                   once in 10 minutes (that run is also its heartbeat and does the hub / stale-order stages).   (-85 % when idle)
--   3. telegram-notifier            every minute -> every minute ONLY when a notification is due, otherwise once in 10 minutes.   (-85 % when idle)
--   4. sync-catalog                 every 5 minutes -> every 15 minutes (one provider per run). The rotation hands out a provider that was last synced over
--                                   50 minutes ago (claim_catalog_sync_provider), so with 5 providers each is synced about every 65-75 minutes instead of ~50.
--   Expected: ~65 000 -> ~12 000 requests a day (-80 %); without item 4 ~23 000 (-65 %).
--
-- ORDER OF WORK. 1) deploy the function admin-observability (supabase/functions/_shared/observability.ts has the new "late" thresholds: 15 min for the
-- monitor and the order sync, 25 min for the notifier, 75 min for the catalog sync). 2) run this file. In the other order System Health would call the
-- slower workers "late".
-- The gates below test exactly what the workers would look for, so a skipped run is a run that would have found nothing.
--
-- ROLLBACK: the last block of this file.
-- =============================================================================

begin;

-- 1. the health monitor: every 5 minutes
select cron.alter_job(
  (select jobid from cron.job where jobname = 'provider-health-monitor'),
  schedule => '*/5 * * * *');

-- 2. the order sync: a minute-run only when get_order_sync_batch / unfunded_orders_summary / expire_stale_paid_orders would find an order
--    (status in flight, a refund owed, or paid = waiting for funds or for the 1-hour expiry); the 10th minute always runs (heartbeat, provider balances)
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-order-status'),
  command => $cmd$ select net.http_post(url := 'https://btvbedplxsqkxlzgygvh.supabase.co/functions/v1/sync-order-status', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{}'::jsonb, timeout_milliseconds := 120000)
    where exists (select 1 from public.orders o where o.status in ('paid', 'submitted', 'in_progress', 'processing') or (o.status in ('canceled', 'failed') and o.error_message like 'needs_refund%'))
       or extract(minute from now())::int % 10 = 0; $cmd$);

-- 3. the notifier: a minute-run only when claim_notification_batch would find a due row; the 10th minute always runs (heartbeat)
select cron.alter_job(
  (select jobid from cron.job where jobname = 'telegram-notifier'),
  command => $cmd$ select net.http_post(url := 'https://btvbedplxsqkxlzgygvh.supabase.co/functions/v1/telegram-notifier', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{}'::jsonb, timeout_milliseconds := 60000)
    where exists (select 1 from public.notification_outbox where status = 'pending' and next_attempt_at <= now())
       or extract(minute from now())::int % 10 = 0; $cmd$);

-- 4. the catalog sync: one provider per run, every 15 minutes (the owner's decision of 2026-11-06)
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-catalog'),
  schedule => '*/15 * * * *');

commit;

-- check: select jobname, schedule from cron.job where jobname in ('provider-health-monitor', 'sync-order-status', 'telegram-notifier', 'sync-catalog');

-- =============================================================================
-- NOT DONE (the owner did not ask for it): fill-storefront-gaps stays at 2-59/15 (96 runs a day, a small share of the requests).
--
-- select cron.alter_job((select jobid from cron.job where jobname = 'fill-storefront-gaps'), schedule => '2-59/30 * * * *');
-- =============================================================================

-- =============================================================================
-- ROLLBACK (back to what ran on 2026-11-06)
--
-- begin;
-- select cron.alter_job((select jobid from cron.job where jobname = 'provider-health-monitor'), schedule => '* * * * *');
-- select cron.alter_job((select jobid from cron.job where jobname = 'sync-order-status'),
--   command => $cmd$ select net.http_post(url := 'https://btvbedplxsqkxlzgygvh.supabase.co/functions/v1/sync-order-status', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{}'::jsonb, timeout_milliseconds := 120000); $cmd$);
-- select cron.alter_job((select jobid from cron.job where jobname = 'telegram-notifier'),
--   command => $cmd$ select net.http_post(url := 'https://btvbedplxsqkxlzgygvh.supabase.co/functions/v1/telegram-notifier', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')), body := '{}'::jsonb, timeout_milliseconds := 60000); $cmd$);
-- select cron.alter_job((select jobid from cron.job where jobname = 'sync-catalog'), schedule => '*/5 * * * *');
-- select cron.alter_job((select jobid from cron.job where jobname = 'fill-storefront-gaps'), schedule => '2-59/15 * * * *');
-- commit;
-- =============================================================================
