-- Deposits go through TON Connect (Tonkeeper) and verify-deposit only. The Crypto Pay (@CryptoBot) channel of 20261231000700 was never switched on (no
-- token was ever set, both functions answered 503, no invoice was ever made), so there is nothing to keep: its table, its two functions and the
-- 'deposit' kind of the notification outbox go. wallet_transactions and the deposits table are not touched.
--
-- The earlier migration stays in the history (it has been applied; a migration that is already applied is never deleted), this one undoes it.

drop function if exists public.complete_crypto_pay_invoice(bigint, text, numeric, text, numeric);
drop function if exists public.create_crypto_pay_invoice(uuid, numeric, text, integer, integer);
drop table if exists public.crypto_pay_invoices;
drop function if exists public.guard_crypto_pay_invoice();

-- A deposit row cannot exist in the outbox now; if one did, it goes (the customer's balance is in the ledger, the message is only a message).
delete from public.notification_outbox where kind = 'deposit';
alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox drop constraint if exists notification_outbox_shape;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check check (kind in ('started', 'completed', 'partial', 'canceled', 'admin_alert', 'admin_hub')),
  add constraint notification_outbox_shape check (
    (kind in ('admin_alert', 'admin_hub') and payload is not null and order_id is null)
    or (kind not in ('admin_alert', 'admin_hub') and payload is null and order_id is not null));
