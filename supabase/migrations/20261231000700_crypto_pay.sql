-- Deposits through Crypto Pay (@CryptoBot): the customer asks for an amount in US dollars, we create a fiat (USD) invoice there, CryptoBot converts it to
-- USDT / TON at its own rate, and when the invoice is paid its webhook credits the wallet.
--
--   crypto_pay_invoices          one row per invoice we asked for: who, how many dollars, CryptoBot's invoice_id, the link to pay. Private: no client role
--                                reads it (the link goes back to the customer from the function that created it).
--   create_crypto_pay_invoice()  writes the pending row first, with a cap on open invoices per customer (the API is called after it, so a paid invoice
--                                always has a row to land on).
--   complete_crypto_pay_invoice() the ONLY place that credits: one transaction that locks the invoice, books the deposit in the ledger under the key
--                                'cryptopay:<invoice_id>' (a second webhook, a retry or a status poll finds it booked and changes nothing), marks the
--                                invoice paid and queues the Telegram message in the outbox. What is credited is what WE asked for (amount_usd); a paid
--                                invoice that reports another currency or amount is put in 'review' and credits nothing.
-- Service role only.

create table public.crypto_pay_invoices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete restrict,
  -- what the customer is credited, in USD (the ledger currency); the invoice is made for exactly this amount
  amount_usd    numeric(14,4) not null check (amount_usd > 0 and amount_usd <= 100000),
  network       text not null default 'mainnet' check (network in ('mainnet', 'testnet')),
  -- CryptoBot's id of the invoice: set once it has been created there; unique, so one invoice is one row
  invoice_id    bigint unique check (invoice_id is null or invoice_id > 0),
  status        text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'failed', 'review')),
  pay_url       text check (pay_url is null or length(pay_url) <= 500),
  mini_app_url  text check (mini_app_url is null or length(mini_app_url) <= 500),
  web_app_url   text check (web_app_url is null or length(web_app_url) <= 500),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  -- what was paid, as CryptoBot reports it (for the records: the credit is amount_usd)
  paid_asset    text check (paid_asset is null or paid_asset ~ '^[A-Z0-9]{2,10}$'),
  paid_amount   numeric(30,9),
  paid_at       timestamptz,
  review_reason text check (review_reason is null or length(review_reason) <= 200),
  constraint crypto_pay_paid_has_proof check ((status = 'paid') = (invoice_id is not null and paid_at is not null))
);
create index idx_crypto_pay_user_created on public.crypto_pay_invoices (user_id, created_at desc);
create index idx_crypto_pay_open on public.crypto_pay_invoices (expires_at) where status = 'pending';
alter table public.crypto_pay_invoices enable row level security;
revoke all on public.crypto_pay_invoices from public, anon, authenticated;

-- A paid invoice is final, and what an invoice is for never changes.
create function public.guard_crypto_pay_invoice()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if old.status = 'paid' then
    raise exception 'invoice % is paid and immutable', old.id using errcode = 'restrict_violation';
  end if;
  if new.user_id <> old.user_id or new.amount_usd <> old.amount_usd or new.network <> old.network then
    raise exception 'invoice terms are immutable' using errcode = 'restrict_violation';
  end if;
  if old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    raise exception 'the invoice id of an invoice cannot change' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger trg_crypto_pay_guard before update or delete on public.crypto_pay_invoices
  for each row execute function public.guard_crypto_pay_invoice();

-- ---- 1. a new invoice ------------------------------------------------------------------------------------------------------------------------
-- Raises 'banned' (a suspended customer cannot start a deposit) or 'too_many_pending' (the cap on unpaid invoices). One caller at a time per customer:
-- the row of the customer is locked, so two requests sent together cannot both take the last place.
create function public.create_crypto_pay_invoice(p_user_id uuid, p_amount_usd numeric, p_network text default 'mainnet', p_ttl_seconds integer default 3600, p_max_pending integer default 5)
returns public.crypto_pay_invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u public.users%rowtype;
  r public.crypto_pay_invoices%rowtype;
  v_open integer;
begin
  if p_amount_usd is null or p_amount_usd <= 0 or round(p_amount_usd, 2) <> p_amount_usd then
    raise exception 'invalid_parameter_value: the amount is a positive number of dollars with at most 2 decimals' using errcode = 'invalid_parameter_value';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 or p_max_pending is null or p_max_pending < 1 then
    raise exception 'invalid_parameter_value: ttl 60..86400 seconds and a positive cap' using errcode = 'invalid_parameter_value';
  end if;
  select * into u from users where id = p_user_id for update;
  if not found then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;
  if u.is_banned then
    raise exception 'banned: the account is suspended' using errcode = 'insufficient_privilege';
  end if;

  update crypto_pay_invoices set status = 'expired' where user_id = p_user_id and status = 'pending' and expires_at < now() - interval '1 hour';
  select count(*) into v_open from crypto_pay_invoices where user_id = p_user_id and status = 'pending' and expires_at > now();
  if v_open >= p_max_pending then
    raise exception 'too_many_pending: % unpaid invoices are open', v_open using errcode = 'check_violation';
  end if;

  insert into crypto_pay_invoices (user_id, amount_usd, network, expires_at)
  values (p_user_id, p_amount_usd, p_network, now() + make_interval(secs => p_ttl_seconds))
  returning * into r;
  return r;
end;
$$;

-- ---- 2. the credit -------------------------------------------------------------------------------------------------------------------------------
-- p_fiat / p_fiat_amount: what CryptoBot says the invoice was for (null when it does not say). Answers
--   { result: 'credited' | 'already_credited' | 'review', amount_usd, balance? }
-- and raises no_data_found 'unknown_invoice' for an invoice id we never created.
-- An invoice we had marked expired is still credited when it turns out to be paid: the money has arrived.
create function public.complete_crypto_pay_invoice(
  p_invoice_id  bigint,
  p_paid_asset  text default null,
  p_paid_amount numeric default null,
  p_fiat        text default null,
  p_fiat_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        public.crypto_pay_invoices%rowtype;
  v_tx     public.wallet_transactions%rowtype;
  v_asset  text := nullif(upper(btrim(coalesce(p_paid_asset, ''))), '');
begin
  if p_invoice_id is null or p_invoice_id <= 0 then
    raise exception 'invalid_parameter_value: the invoice id is required' using errcode = 'invalid_parameter_value';
  end if;
  if v_asset is not null and v_asset !~ '^[A-Z0-9]{2,10}$' then v_asset := null; end if;

  -- Everything that touches this invoice waits here: a webhook, its retry and a status poll arriving together are credited once.
  select * into r from crypto_pay_invoices where invoice_id = p_invoice_id for update;
  if not found then
    raise exception 'unknown_invoice: no invoice % was created here', p_invoice_id using errcode = 'no_data_found';
  end if;

  if r.status = 'paid' then
    return jsonb_build_object('result', 'already_credited', 'amount_usd', r.amount_usd);
  end if;

  -- The invoice was made for amount_usd dollars. If CryptoBot reports something else, a person looks at it; nothing is credited.
  if (p_fiat is not null and upper(btrim(p_fiat)) <> 'USD') or (p_fiat_amount is not null and abs(p_fiat_amount - r.amount_usd) > 0.0001) then
    update crypto_pay_invoices
       set status = 'review', review_reason = left(format('paid, but reported as %s %s; expected USD %s', p_fiat, p_fiat_amount, r.amount_usd), 200)
     where id = r.id;
    return jsonb_build_object('result', 'review', 'amount_usd', r.amount_usd);
  end if;

  v_tx := process_wallet_transaction(
    r.user_id, 'deposit', r.amount_usd, r.id,
    'Deposit via CryptoBot' || coalesce(' (' || v_asset || ')', ''), 'cryptopay:' || p_invoice_id);

  update crypto_pay_invoices
     set status = 'paid', paid_at = now(), paid_asset = v_asset, paid_amount = p_paid_amount, review_reason = null
   where id = r.id;

  -- The message to the customer, in the same transaction as the credit (an INSERT into the outbox, no network): the notifier sends it with retries.
  -- It is the lesser matter: a failure here never undoes the credit.
  begin
    insert into notification_outbox (user_id, kind, dedupe_key, payload)
    values (r.user_id, 'deposit', 'cryptopay:' || p_invoice_id || ':deposit',
            jsonb_build_object('amount_usd', r.amount_usd, 'asset', v_asset, 'balance', v_tx.balance_after))
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'crypto pay: the message for invoice % was not queued: %', p_invoice_id, sqlerrm;
  end;

  return jsonb_build_object('result', 'credited', 'amount_usd', r.amount_usd, 'balance', v_tx.balance_after);
end;
$$;

-- ---- 3. the outbox carries deposit messages --------------------------------------------------------------------------------------------------
-- Like the admin messages they have no order behind them: a payload and the customer.
alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox drop constraint if exists notification_outbox_shape;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check check (kind in ('started', 'completed', 'partial', 'canceled', 'admin_alert', 'admin_hub', 'deposit')),
  add constraint notification_outbox_shape check (
    (kind in ('admin_alert', 'admin_hub', 'deposit') and payload is not null and order_id is null)
    or (kind not in ('admin_alert', 'admin_hub', 'deposit') and payload is null and order_id is not null));

-- ---- 4. who may call them --------------------------------------------------------------------------------------------------------------------
revoke all on function public.create_crypto_pay_invoice(uuid, numeric, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_crypto_pay_invoice(bigint, text, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.create_crypto_pay_invoice(uuid, numeric, text, integer, integer) to service_role;
grant execute on function public.complete_crypto_pay_invoice(bigint, text, numeric, text, numeric) to service_role;
