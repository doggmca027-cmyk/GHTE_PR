-- Schedules the two background workers inside Supabase (pg_cron + pg_net).
-- NOT a migration: it contains your project URL and must be run ONCE by hand in the SQL editor.
--
-- Prerequisites: Dashboard -> Database -> Extensions: enable "pg_cron" and "pg_net".
--
-- 1. Replace <PROJECT_REF> below (Project Settings -> General -> Reference ID).
-- 2. Replace <CRON_SECRET> with the SAME value you set in the CRON_SECRET function secret.
--    It is stored in Supabase Vault, so it is not visible in the cron job definitions.

select vault.create_secret('<CRON_SECRET>', 'cron_secret');

-- Every minute: poll providers for order progress, refunds, partial refunds, stuck orders.
select cron.schedule(
  'sync-order-status',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-order-status',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Every 6 hours: refresh the provider catalogue, prices and cached provider balances.
select cron.schedule(
  'sync-catalog',
  '0 */6 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-catalog',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Inspect / pause / remove:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
--   select * from net._http_response order by created desc limit 10;     -- what the functions answered
--   select cron.unschedule('sync-order-status');
