-- =============================================================================
-- EMERGENCY QUARANTINE: stop all money movement NOW.
--
-- NOT a migration. Run it by hand: Supabase Dashboard -> SQL Editor -> paste the whole file -> Run
-- (or: psql "$DATABASE_URL" -f supabase/scripts/emergency_quarantine.sql). One transaction: all or nothing.
-- Safe to run twice (the second run changes nothing and keeps the first run's restore point).
--
-- What it does
--   1. Remembers the current switches and the treasury reserve in admin_audit_log ('emergency_quarantine'), so lifting the
--      quarantine restores exactly what was there (docs/RUNBOOK.md, "Lifting the quarantine").
--   2. Kill switches: global_orders_enabled = false, global_payments_enabled = false, maintenance_mode = true.
--      New orders and new deposits are refused (fail closed). Orders already at a provider keep being synced, refunds still
--      happen, deposits already paid on-chain are still credited: refusing those would hurt customers, not attackers.
--   3. Freezes provider payments:
--        * minimum_treasury_reserve = 999999999: validate_provider_payment() (the only way money leaves the treasury)
--          refuses every new payment and every top-up approval, under its row lock;
--        * payments that cannot have been sent yet (PROPOSED / APPROVED / VALIDATED: no transfer instruction exists) are
--          CANCELED and their amount returned to the treasury, once;
--        * payments from PAYMENT_CREATED on are NOT touched: the transfer may already be on its way. They are listed at
--          the end for a human to check against the chain.
--   4. Prints the resulting state.
-- =============================================================================

begin;

-- 1. restore point (only when not already quarantined: a second run must not overwrite the real previous state)
insert into public.admin_audit_log (admin_id, action, target_id, details)
select null, 'emergency_quarantine', 'platform_settings',
       jsonb_build_object(
         'previous', jsonb_build_object(
           'global_orders_enabled', s.global_orders_enabled,
           'global_payments_enabled', s.global_payments_enabled,
           'maintenance_mode', s.maintenance_mode,
           'minimum_treasury_reserve', s.minimum_treasury_reserve),
         'by', session_user,
         'at', now())
  from public.platform_settings s
 where s.id = 1
   and not (s.maintenance_mode and not s.global_orders_enabled and not s.global_payments_enabled and s.minimum_treasury_reserve >= 999999999);

-- 2. kill switches  +  3a. payout freeze (the reserve no balance can satisfy)
update public.platform_settings
   set global_orders_enabled    = false,
       global_payments_enabled  = false,
       maintenance_mode         = true,
       minimum_treasury_reserve = 999999999,
       updated_by               = null,
       updated_at               = now()
 where id = 1;

-- 3b. cancel what cannot have left yet (each call is a guarded transition + a one-time treasury reversal)
select p.id as canceled_payment, p.status as was, p.amount,
       public.cancel_provider_payment(p.id, 'emergency quarantine: canceled before any transfer instruction existed', null) ->> 'status' as now
  from public.provider_payments p
 where p.status in ('PROPOSED', 'APPROVED', 'VALIDATED')
 order by p.created_at;

commit;

-- 4. the result
select global_orders_enabled, global_payments_enabled, maintenance_mode, minimum_treasury_reserve, updated_at
  from public.platform_settings where id = 1;

-- in-flight payments a human must check against the chain (nothing automatic happens to them)
select p.id, pv.name as provider, p.status, p.amount, p.asset, p.network, p.destination_wallet, p.tx_hash, p.updated_at
  from public.provider_payments p
  join public.providers pv on pv.id = p.provider_id
 where p.status not in ('COMPLETED', 'FAILED', 'CANCELED')
 order by p.created_at;
