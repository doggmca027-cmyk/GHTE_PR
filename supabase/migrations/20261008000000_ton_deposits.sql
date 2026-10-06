-- =============================================================================
-- Crypto deposits (TON / Tonkeeper)
--
-- A deposit is an *intent* created by create-deposit (unique memo + quoted amount). It is only
-- credited by complete_deposit(), called by verify-deposit AFTER the transaction was found on
-- chain. Clients can read their own rows and nothing else.
-- =============================================================================

create table public.deposits (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users(id) on delete restrict,
  -- What the user is credited (USD, ledger currency) and what they must send.
  amount_usd        numeric(14,4) not null check (amount_usd > 0),
  amount_crypto     numeric(20,9) not null check (amount_crypto > 0),
  asset             varchar(10) not null default 'TON' check (asset in ('TON', 'USDT')),
  -- USD per 1 unit of asset, locked at quote time (audit trail).
  rate_usd          numeric(20,9) not null check (rate_usd > 0),
  network           varchar(10) not null default 'mainnet' check (network in ('mainnet', 'testnet')),
  -- Unique comment the user must attach; the only link between a chain tx and this row.
  memo              text not null unique check (memo ~ '^dep_[0-9a-f]{32}$'),
  recipient_address text not null,
  sender_address    text,
  -- One on-chain transaction can fund at most one deposit (replay protection).
  tx_hash           text unique,
  status            varchar(10) not null default 'pending' check (status in ('pending', 'completed', 'failed', 'expired')),
  valid_until       timestamptz not null,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint deposits_completed_has_proof check (
    (status = 'completed') = (tx_hash is not null and completed_at is not null)
  )
);

create index idx_deposits_user_created on public.deposits (user_id, created_at desc);
create index idx_deposits_pending on public.deposits (valid_until) where status = 'pending';

-- Completed deposits are final.
create function public.guard_deposit_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'deposits cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if old.status = 'completed' then
    raise exception 'deposit % is completed and immutable', old.id using errcode = 'restrict_violation';
  end if;
  if new.user_id <> old.user_id or new.amount_usd <> old.amount_usd or new.amount_crypto <> old.amount_crypto
     or new.memo <> old.memo or new.recipient_address <> old.recipient_address or new.asset <> old.asset then
    raise exception 'deposit terms are immutable' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger trg_deposits_guard before update or delete on public.deposits
  for each row execute function public.guard_deposit_mutation();

-- -----------------------------------------------------------------------------
-- Atomic completion: lock -> claim tx_hash -> mark completed -> credit ledger.
-- Idempotent; any failure rolls back all of it.
-- -----------------------------------------------------------------------------
create function public.complete_deposit(
  p_deposit_id     uuid,
  p_tx_hash        text,
  p_sender_address text default null
) returns public.deposits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.deposits%rowtype;
begin
  if p_tx_hash is null or length(p_tx_hash) = 0 then
    raise exception 'tx hash is required' using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;

  if d.status = 'completed' then
    return d; -- already credited: idempotent
  end if;
  if d.status = 'failed' then
    raise exception 'deposit % has failed and cannot be completed', d.id using errcode = 'check_violation';
  end if;

  -- Explicit check for a friendly error; the UNIQUE constraint is the real guarantee.
  if exists (select 1 from deposits where tx_hash = p_tx_hash and id <> d.id) then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end if;

  update deposits
     set status = 'completed', tx_hash = p_tx_hash, sender_address = p_sender_address, completed_at = now()
   where id = d.id
  returning * into d;

  perform process_wallet_transaction(
    d.user_id, 'deposit', d.amount_usd, d.id,
    'Deposit via Tonkeeper (' || d.asset || ')', 'deposit:' || d.id);

  return d;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS / privileges: clients may only read their own deposits.
-- -----------------------------------------------------------------------------
alter table public.deposits enable row level security;
revoke all on table public.deposits from anon, authenticated;
grant select on public.deposits to authenticated;

create policy deposits_select_own on public.deposits
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on function public.complete_deposit(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_deposit(uuid, text, text) to service_role;
