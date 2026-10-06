-- =============================================================================
-- SMM reselling platform - initial schema (Supabase / PostgreSQL 15+)
--
-- Principles
--   * Money is NUMERIC(14,4) only. Never float/real.
--   * wallet_transactions is an append-only ledger; wallets.balance is a
--     materialised total that can only change through process_wallet_transaction()
--     / settle_wallet_transaction() (enforced by a trigger, even for service_role).
--   * orders follow a strict state machine; every change lands in
--     order_status_history.
--   * Auth model: users.id is the identity placed in the JWT `sub` claim by the
--     backend that validates Telegram initData, so auth.uid() = users.id.
--     Clients get read-only access to their own rows; all writes go through
--     service_role / SECURITY DEFINER functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ENUMS
-- -----------------------------------------------------------------------------
create type public.order_status_enum as enum (
  'draft', 'awaiting_payment', 'paid', 'processing', 'submitted',
  'in_progress', 'completed', 'partial', 'canceled', 'refunded', 'failed'
);
create type public.transaction_type_enum as enum (
  'deposit', 'purchase', 'refund', 'bonus', 'manual_adjustment'
);
create type public.transaction_status_enum as enum (
  'pending', 'completed', 'failed', 'canceled'
);
create type public.platform_enum as enum (
  'telegram', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'other'
);
create type public.price_rule_type_enum as enum ('percentage', 'fixed', 'tier');

-- -----------------------------------------------------------------------------
-- GENERIC HELPERS
-- -----------------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function public.forbid_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% on % is not allowed: table is append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- -----------------------------------------------------------------------------
-- USERS & WALLETS
-- -----------------------------------------------------------------------------
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  telegram_id   bigint not null unique check (telegram_id > 0),
  username      text,
  first_name    text,
  language_code text,
  is_banned     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_users_updated_at before update on public.users
  for each row execute function public.set_updated_at();

create table public.wallets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references public.users(id) on delete restrict,
  currency       text not null default 'USD' check (currency ~ '^[A-Z]{3,10}$'),
  balance        numeric(14,4) not null default 0 check (balance >= 0),
  locked_balance numeric(14,4) not null default 0 check (locked_balance >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint wallets_locked_lte_balance check (locked_balance <= balance)
);
create trigger trg_wallets_updated_at before update on public.wallets
  for each row execute function public.set_updated_at();

-- Balance/locked_balance may only change inside the wallet functions below,
-- which raise the transaction-local flag app.wallet_op. This blocks accidental
-- (or malicious) direct UPDATEs even from service_role.
create function public.guard_wallet_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.balance <> 0 or new.locked_balance <> 0 then
      raise exception 'wallets must be created with zero balance'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'wallets.user_id is immutable' using errcode = 'restrict_violation';
  end if;
  if (new.balance is distinct from old.balance
      or new.locked_balance is distinct from old.locked_balance
      or new.currency is distinct from old.currency)
     and coalesce(current_setting('app.wallet_op', true), 'off') <> 'on' then
    raise exception 'wallet balance can only be changed via process_wallet_transaction()'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger trg_wallets_guard before insert or update on public.wallets
  for each row execute function public.guard_wallet_mutation();

-- Every user gets exactly one wallet (clients cannot insert wallets).
create function public.create_wallet_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.wallets (user_id) values (new.id);
  return new;
end;
$$;
create trigger trg_users_create_wallet after insert on public.users
  for each row execute function public.create_wallet_for_new_user();

-- -----------------------------------------------------------------------------
-- LEDGER
-- amount is a SIGNED delta: > 0 credits the wallet, < 0 debits it.
-- balance_after is set only once the transaction is completed.
-- -----------------------------------------------------------------------------
create table public.wallet_transactions (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references public.wallets(id) on delete restrict,
  type            public.transaction_type_enum not null,
  status          public.transaction_status_enum not null default 'pending',
  amount          numeric(14,4) not null check (amount <> 0),
  balance_after   numeric(14,4) check (balance_after >= 0),
  reference_id    uuid,
  description     text,
  idempotency_key text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint wtx_balance_after_iff_completed
    check ((status = 'completed') = (balance_after is not null)),
  constraint wtx_amount_sign_by_type check (
    case type
      when 'deposit'  then amount > 0
      when 'bonus'    then amount > 0
      when 'refund'   then amount > 0
      when 'purchase' then amount < 0
      else true
    end
  )
);
create index idx_wtx_wallet_created on public.wallet_transactions (wallet_id, created_at desc);
create index idx_wtx_reference      on public.wallet_transactions (reference_id) where reference_id is not null;
create index idx_wtx_status         on public.wallet_transactions (status) where status = 'pending';

-- Ledger rows are immutable, except a pending row may be settled exactly once.
create function public.guard_wallet_transaction_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'pending' then
    raise exception 'ledger entry % is already % and immutable', old.id, old.status
      using errcode = 'restrict_violation';
  end if;
  if new.status = 'pending' then
    raise exception 'ledger entry % is still pending: only settlement is allowed', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.wallet_id <> old.wallet_id or new.type <> old.type
     or new.amount <> old.amount
     or new.reference_id is distinct from old.reference_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at <> old.created_at then
    raise exception 'only status and balance_after of a pending ledger entry may change'
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger trg_wtx_guard_update before update on public.wallet_transactions
  for each row execute function public.guard_wallet_transaction_update();
create trigger trg_wtx_no_delete before delete on public.wallet_transactions
  for each row execute function public.forbid_mutation();
create trigger trg_wtx_no_truncate before truncate on public.wallet_transactions
  for each statement execute function public.forbid_mutation();

-- -----------------------------------------------------------------------------
-- PROVIDERS & CATALOG
-- -----------------------------------------------------------------------------
create table public.providers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  api_url           text not null,
  -- Ciphertext only (e.g. Supabase Vault / pgsodium / app-level envelope
  -- encryption). Never store the raw key.
  api_key_encrypted text,
  is_active         boolean not null default true,
  balance           numeric(14,4) not null default 0,
  priority          integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger trg_providers_updated_at before update on public.providers
  for each row execute function public.set_updated_at();

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  platform   public.platform_enum not null,
  name       text not null,
  slug       text not null unique,
  icon_url   text,
  sort_order integer not null default 0,
  is_active  boolean not null default true
);
create index idx_categories_platform_active on public.categories (platform, sort_order) where is_active;

create table public.provider_services (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references public.providers(id) on delete cascade,
  external_service_id text not null,
  name                text not null,
  category_raw        text,
  rate_per_1000       numeric(14,4) not null check (rate_per_1000 >= 0),
  min_quantity        integer not null check (min_quantity > 0),
  max_quantity        integer not null,
  refill_supported    boolean not null default false,
  cancel_supported    boolean not null default false,
  is_active           boolean not null default true,
  last_synced_at      timestamptz,
  constraint ps_qty_range check (max_quantity >= min_quantity),
  constraint ps_provider_external_unique unique (provider_id, external_service_id)
);

create table public.services (
  id                           uuid primary key default gen_random_uuid(),
  category_id                  uuid not null references public.categories(id) on delete restrict,
  name                         text not null,
  description                  text,
  primary_provider_service_id  uuid not null references public.provider_services(id) on delete restrict,
  fallback_provider_service_id uuid references public.provider_services(id) on delete set null,
  customer_rate_per_1000       numeric(14,4) not null check (customer_rate_per_1000 > 0),
  min_quantity                 integer not null check (min_quantity > 0),
  max_quantity                 integer not null,
  is_active                    boolean not null default true,
  sort_order                   integer not null default 0,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint services_qty_range check (max_quantity >= min_quantity),
  constraint services_fallback_differs
    check (fallback_provider_service_id is distinct from primary_provider_service_id)
);
create index idx_services_category on public.services (category_id, sort_order) where is_active;
create index idx_services_primary  on public.services (primary_provider_service_id);
create index idx_services_fallback on public.services (fallback_provider_service_id)
  where fallback_provider_service_id is not null;
create trigger trg_services_updated_at before update on public.services
  for each row execute function public.set_updated_at();

-- Markup rules. A rule targets at most one scope (platform | category | service);
-- no scope = global. `tier` rules apply when the provider rate lies in
-- [min_rate, max_rate] (extension to the spec so "tier" is well defined).
create table public.price_rules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        public.price_rule_type_enum not null,
  value       numeric(10,2) not null check (value >= 0),
  platform    public.platform_enum,
  category_id uuid references public.categories(id) on delete cascade,
  service_id  uuid references public.services(id) on delete cascade,
  min_rate    numeric(14,4) check (min_rate >= 0),
  max_rate    numeric(14,4),
  priority    integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint price_rules_single_scope check (num_nonnulls(platform, category_id, service_id) <= 1),
  constraint price_rules_rate_range   check (max_rate is null or min_rate is null or max_rate >= min_rate),
  constraint price_rules_tier_needs_range check (type <> 'tier' or min_rate is not null)
);
create index idx_price_rules_category on public.price_rules (category_id) where category_id is not null;
create index idx_price_rules_service  on public.price_rules (service_id)  where service_id is not null;
create index idx_price_rules_lookup   on public.price_rules (platform, priority desc) where is_active;

-- -----------------------------------------------------------------------------
-- ORDERS & HISTORY
-- -----------------------------------------------------------------------------
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete restrict,
  service_id        uuid not null references public.services(id) on delete restrict,
  target_url        text not null check (length(target_url) between 1 and 2048),
  quantity          integer not null check (quantity > 0),
  charge_amount     numeric(14,4) not null check (charge_amount >= 0),
  cost_amount       numeric(14,4) not null default 0 check (cost_amount >= 0),
  status            public.order_status_enum not null default 'draft',
  provider_id       uuid references public.providers(id) on delete restrict,
  provider_order_id text,
  start_count       integer,
  remains           integer,
  error_message     text,
  idempotency_key   text unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_orders_user_created on public.orders (user_id, created_at desc);
create index idx_orders_status       on public.orders (status);
create index idx_orders_service      on public.orders (service_id);
create index idx_orders_provider     on public.orders (provider_id) where provider_id is not null;
create unique index uq_orders_provider_order
  on public.orders (provider_id, provider_order_id) where provider_order_id is not null;
create trigger trg_orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_status_history (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete restrict,
  old_status public.order_status_enum,
  new_status public.order_status_enum not null,
  comment    text,
  created_at timestamptz not null default now()
);
create index idx_osh_order on public.order_status_history (order_id, created_at);
create trigger trg_osh_no_update before update on public.order_status_history
  for each row execute function public.forbid_mutation();
create trigger trg_osh_no_delete before delete on public.order_status_history
  for each row execute function public.forbid_mutation();
create trigger trg_osh_no_truncate before truncate on public.order_status_history
  for each statement execute function public.forbid_mutation();

-- -----------------------------------------------------------------------------
-- ORDER STATE MACHINE
--
--   draft -> awaiting_payment -> paid -> processing -> submitted -> in_progress
--                                                          \             |
--                                                           +--> completed | partial
--   Any non-final state may also go to canceled / failed (see table below).
--   completed | partial | canceled | failed | paid -> refunded.  refunded is terminal.
-- -----------------------------------------------------------------------------
create function public.is_valid_order_transition(
  p_old public.order_status_enum,
  p_new public.order_status_enum
) returns boolean
language sql
immutable
as $$
  select case p_old
    when 'draft'            then p_new in ('awaiting_payment', 'canceled')
    when 'awaiting_payment' then p_new in ('paid', 'canceled', 'failed')
    when 'paid'             then p_new in ('processing', 'submitted', 'canceled', 'failed', 'refunded')
    when 'processing'       then p_new in ('submitted', 'canceled', 'failed')
    when 'submitted'        then p_new in ('in_progress', 'completed', 'partial', 'canceled', 'failed')
    when 'in_progress'      then p_new in ('completed', 'partial', 'canceled', 'failed')
    when 'completed'        then p_new in ('refunded')
    when 'partial'          then p_new in ('refunded')
    when 'canceled'         then p_new in ('refunded')
    when 'failed'           then p_new in ('refunded')
    when 'refunded'         then false
    else false
  end;
$$;

-- BEFORE trigger: validates inserts/updates.
create function public.guard_order_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'orders must be created in draft status (got %)', new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status
     and not public.is_valid_order_transition(old.status, new.status) then
    raise exception 'illegal order status transition: % -> % (order %)',
      old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  -- Commercial terms are frozen once the order leaves draft.
  if old.status <> 'draft'
     and (new.user_id <> old.user_id
          or new.service_id <> old.service_id
          or new.target_url <> old.target_url
          or new.quantity <> old.quantity
          or new.charge_amount <> old.charge_amount) then
    raise exception 'order % commercial terms are immutable after draft', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger trg_orders_guard_state before insert or update on public.orders
  for each row execute function public.guard_order_state();

-- AFTER trigger: audit trail. A reason can be passed with
--   select set_config('app.status_comment', 'why', true);
create function public.log_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment text := nullif(current_setting('app.status_comment', true), '');
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_history (order_id, old_status, new_status, comment)
    values (new.id, null, new.status, coalesce(v_comment, 'order created'));
  elsif new.status is distinct from old.status then
    insert into public.order_status_history (order_id, old_status, new_status, comment)
    values (new.id, old.status, new.status, coalesce(v_comment, new.error_message));
    perform set_config('app.status_comment', '', true);
  end if;
  return new;
end;
$$;
create trigger trg_orders_log_status after insert or update on public.orders
  for each row execute function public.log_order_status_change();

-- -----------------------------------------------------------------------------
-- WALLET FUNCTIONS
-- -----------------------------------------------------------------------------

-- Atomically applies a signed amount to a user's wallet.
--   p_amount > 0 credits, p_amount < 0 debits (sign must match p_type).
--   p_status 'completed' (default) moves the balance now;
--   p_status 'pending' only records an intent (credits only, e.g. awaiting
--   payment) and is settled later by settle_wallet_transaction().
-- Concurrency: the wallet row is locked FOR UPDATE, so concurrent calls for the
-- same wallet execute one after another and always see the latest balance.
-- Idempotency: replaying the same p_idempotency_key returns the original row.
create function public.process_wallet_transaction(
  p_user_id         uuid,
  p_type            public.transaction_type_enum,
  p_amount          numeric,
  p_reference_id    uuid default null,
  p_description     text default null,
  p_idempotency_key text default null,
  p_status          public.transaction_status_enum default 'completed'
) returns public.wallet_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet wallets%rowtype;
  v_tx     wallet_transactions%rowtype;
  v_new    numeric(14,4);
  v_amount numeric(14,4);
begin
  if p_amount is null then
    raise exception 'amount is required' using errcode = 'invalid_parameter_value';
  end if;
  v_amount := round(p_amount, 4);
  if v_amount = 0 then
    raise exception 'amount must be non-zero' using errcode = 'invalid_parameter_value';
  end if;
  if p_status not in ('completed', 'pending') then
    raise exception 'new ledger entries must be completed or pending' using errcode = 'invalid_parameter_value';
  end if;
  if p_status = 'pending' and v_amount < 0 then
    raise exception 'pending entries are only supported for credits' using errcode = 'invalid_parameter_value';
  end if;
  if (p_type = 'purchase' and v_amount >= 0)
     or (p_type in ('deposit', 'bonus', 'refund') and v_amount <= 0) then
    raise exception 'amount sign does not match transaction type %', p_type
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serialise on the wallet row.
  select * into v_wallet from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  -- Idempotent replay.
  if p_idempotency_key is not null then
    select * into v_tx from wallet_transactions where idempotency_key = p_idempotency_key;
    if found then
      if v_tx.wallet_id <> v_wallet.id or v_tx.type <> p_type or v_tx.amount <> v_amount then
        raise exception 'idempotency key % was already used with different parameters', p_idempotency_key
          using errcode = 'unique_violation';
      end if;
      return v_tx;
    end if;
  end if;

  if p_type = 'purchase'
     and exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user is banned' using errcode = 'insufficient_privilege';
  end if;

  if p_status = 'pending' then
    insert into wallet_transactions
      (wallet_id, type, status, amount, balance_after, reference_id, description, idempotency_key)
    values
      (v_wallet.id, p_type, 'pending', v_amount, null, p_reference_id, p_description, p_idempotency_key)
    returning * into v_tx;
    return v_tx;
  end if;

  v_new := v_wallet.balance + v_amount;
  if v_new < v_wallet.locked_balance then
    raise exception 'insufficient_funds: available %, required %',
      v_wallet.balance - v_wallet.locked_balance, -v_amount
      using errcode = 'check_violation';
  end if;

  perform set_config('app.wallet_op', 'on', true);
  update wallets set balance = v_new where id = v_wallet.id;
  perform set_config('app.wallet_op', 'off', true);

  insert into wallet_transactions
    (wallet_id, type, status, amount, balance_after, reference_id, description, idempotency_key)
  values
    (v_wallet.id, p_type, 'completed', v_amount, v_new, p_reference_id, p_description, p_idempotency_key)
  returning * into v_tx;
  return v_tx;
end;
$$;

-- Settles a pending ledger entry (e.g. payment webhook confirmed / failed).
-- Safe to call repeatedly with the same outcome.
create function public.settle_wallet_transaction(
  p_transaction_id uuid,
  p_status         public.transaction_status_enum
) returns public.wallet_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet_id uuid;
  v_wallet    wallets%rowtype;
  v_tx        wallet_transactions%rowtype;
  v_new       numeric(14,4);
begin
  if p_status = 'pending' then
    raise exception 'cannot settle to pending' using errcode = 'invalid_parameter_value';
  end if;

  select wallet_id into v_wallet_id from wallet_transactions where id = p_transaction_id;
  if not found then
    raise exception 'transaction % not found', p_transaction_id using errcode = 'no_data_found';
  end if;

  -- Lock order is always wallet -> transaction, matching process_wallet_transaction().
  select * into v_wallet from wallets where id = v_wallet_id for update;
  select * into v_tx from wallet_transactions where id = p_transaction_id for update;

  if v_tx.status <> 'pending' then
    if v_tx.status = p_status then
      return v_tx;
    end if;
    raise exception 'transaction % is already %', v_tx.id, v_tx.status
      using errcode = 'check_violation';
  end if;

  if p_status = 'completed' then
    v_new := v_wallet.balance + v_tx.amount;
    if v_new < v_wallet.locked_balance then
      raise exception 'insufficient_funds' using errcode = 'check_violation';
    end if;
    perform set_config('app.wallet_op', 'on', true);
    update wallets set balance = v_new where id = v_wallet.id;
    perform set_config('app.wallet_op', 'off', true);
    update wallet_transactions set status = 'completed', balance_after = v_new
      where id = v_tx.id returning * into v_tx;
  else
    update wallet_transactions set status = p_status
      where id = v_tx.id returning * into v_tx;
  end if;
  return v_tx;
end;
$$;

-- -----------------------------------------------------------------------------
-- ORDER FUNCTIONS
-- -----------------------------------------------------------------------------

-- Creates an order and pays for it from the wallet in ONE transaction:
-- draft -> awaiting_payment -> (debit) -> paid. Any failure rolls everything back.
create function public.place_order(
  p_user_id         uuid,
  p_service_id      uuid,
  p_target_url      text,
  p_quantity        integer,
  p_idempotency_key text default null
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_svc    services%rowtype;
  v_ps     provider_services%rowtype;
  v_order  orders%rowtype;
  v_charge numeric(14,4);
  v_cost   numeric(14,4);
begin
  -- Serialise all purchases of this user; also makes the idempotency lookup race-free.
  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  if p_idempotency_key is not null then
    select * into v_order from orders where idempotency_key = p_idempotency_key;
    if found then
      if v_order.user_id <> p_user_id or v_order.service_id <> p_service_id
         or v_order.quantity <> p_quantity or v_order.target_url <> p_target_url then
        raise exception 'idempotency key % was already used with different parameters', p_idempotency_key
          using errcode = 'unique_violation';
      end if;
      return v_order;
    end if;
  end if;

  select * into v_svc from services where id = p_service_id and is_active;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  if p_quantity < v_svc.min_quantity or p_quantity > v_svc.max_quantity then
    raise exception 'quantity must be between % and %', v_svc.min_quantity, v_svc.max_quantity
      using errcode = 'check_violation';
  end if;

  select * into v_ps from provider_services where id = v_svc.primary_provider_service_id;

  v_charge := round(v_svc.customer_rate_per_1000 * p_quantity / 1000, 4);
  v_cost   := round(v_ps.rate_per_1000 * p_quantity / 1000, 4);
  if v_charge <= 0 then
    raise exception 'order total is too small' using errcode = 'check_violation';
  end if;

  insert into orders (user_id, service_id, target_url, quantity, charge_amount, cost_amount,
                      provider_id, idempotency_key)
  values (p_user_id, p_service_id, p_target_url, p_quantity, v_charge, v_cost,
          v_ps.provider_id, p_idempotency_key)
  returning * into v_order;

  update orders set status = 'awaiting_payment' where id = v_order.id;

  perform process_wallet_transaction(
    p_user_id, 'purchase', -v_charge, v_order.id,
    'Order ' || v_order.id, 'purchase:' || v_order.id);

  update orders set status = 'paid' where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

-- Refunds a finished/failed/canceled order back to the wallet (once) and moves it
-- to `refunded`. p_amount defaults to the full charge (partial refunds allowed).
create function public.refund_order(
  p_order_id uuid,
  p_amount   numeric default null,
  p_comment  text default null
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  orders%rowtype;
  v_amount numeric(14,4);
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.status = 'refunded' then
    return v_order;  -- idempotent
  end if;

  if not exists (select 1 from wallet_transactions
                 where reference_id = v_order.id and type = 'purchase' and status = 'completed') then
    raise exception 'order % was never paid; nothing to refund', v_order.id
      using errcode = 'check_violation';
  end if;

  v_amount := round(coalesce(p_amount, v_order.charge_amount), 4);
  if v_amount <= 0 or v_amount > v_order.charge_amount then
    raise exception 'refund amount must be in (0, %]', v_order.charge_amount
      using errcode = 'invalid_parameter_value';
  end if;

  -- Validates the transition (raises for e.g. in_progress -> refunded).
  perform set_config('app.status_comment', coalesce(p_comment, 'refund'), true);
  update orders set status = 'refunded' where id = v_order.id returning * into v_order;

  perform process_wallet_transaction(
    v_order.user_id, 'refund', v_amount, v_order.id,
    'Refund for order ' || v_order.id, 'refund:' || v_order.id);

  return v_order;
end;
$$;

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
alter table public.users                enable row level security;
alter table public.wallets              enable row level security;
alter table public.wallet_transactions  enable row level security;
alter table public.providers            enable row level security;
alter table public.categories           enable row level security;
alter table public.provider_services    enable row level security;
alter table public.services             enable row level security;
alter table public.price_rules          enable row level security;
alter table public.orders               enable row level security;
alter table public.order_status_history enable row level security;

-- Start from zero privileges for client roles; grant back read-only access below.
revoke all on table
  public.users, public.wallets, public.wallet_transactions, public.providers,
  public.categories, public.provider_services, public.services, public.price_rules,
  public.orders, public.order_status_history
from anon, authenticated;

grant select on public.users, public.wallets, public.wallet_transactions,
                public.orders, public.order_status_history to authenticated;
grant select on public.categories, public.services to anon, authenticated;

-- Own data only.
create policy users_select_own on public.users
  for select to authenticated using (id = (select auth.uid()));

create policy wallets_select_own on public.wallets
  for select to authenticated using (user_id = (select auth.uid()));

create policy wallet_tx_select_own on public.wallet_transactions
  for select to authenticated using (
    exists (select 1 from public.wallets w
            where w.id = wallet_transactions.wallet_id and w.user_id = (select auth.uid())));

create policy orders_select_own on public.orders
  for select to authenticated using (user_id = (select auth.uid()));

create policy order_history_select_own on public.order_status_history
  for select to authenticated using (
    exists (select 1 from public.orders o
            where o.id = order_status_history.order_id and o.user_id = (select auth.uid())));

-- Public catalog.
create policy categories_select_active on public.categories
  for select to anon, authenticated using (is_active);

create policy services_select_active on public.services
  for select to anon, authenticated using (is_active);

-- providers, provider_services, price_rules: RLS on, no policies, no grants
-- => reachable only by service_role (which bypasses RLS).
-- No INSERT/UPDATE/DELETE policy or grant exists for clients on any table.

-- -----------------------------------------------------------------------------
-- FUNCTION PRIVILEGES: callable by the backend (service_role) only
-- -----------------------------------------------------------------------------
revoke all on function
  public.process_wallet_transaction(uuid, public.transaction_type_enum, numeric, uuid, text, text, public.transaction_status_enum),
  public.settle_wallet_transaction(uuid, public.transaction_status_enum),
  public.place_order(uuid, uuid, text, integer, text),
  public.refund_order(uuid, numeric, text),
  public.create_wallet_for_new_user(),
  public.log_order_status_change()
from public, anon, authenticated;

grant execute on function
  public.process_wallet_transaction(uuid, public.transaction_type_enum, numeric, uuid, text, text, public.transaction_status_enum),
  public.settle_wallet_transaction(uuid, public.transaction_status_enum),
  public.place_order(uuid, uuid, text, integer, text),
  public.refund_order(uuid, numeric, text)
to service_role;
