-- =============================================================================
-- Phase 1G: Project Treasury ledger
--
-- The third financial pillar, kept strictly apart from the other two:
--   user wallets      (wallets / wallet_transactions)   what we OWE customers
--   provider balances (providers.provider_balance)       what we hold at suppliers
--   project treasury  (treasury_state / treasury_*)      our own liquid funds, used to fund providers
--
-- Money moves only through process_treasury_transaction(): it locks the single treasury_state row, checks the
-- balance cannot go negative, appends an immutable ledger row and updates the balance in one transaction.
-- Service role only; admins reach it through the admin-treasury Edge Function (JWT + users.is_admin).
-- =============================================================================

create type public.treasury_transaction_type_enum as enum
  ('deposit', 'withdrawal', 'provider_topup', 'fee', 'manual_adjustment');

-- Exactly one row, ever.
create table public.treasury_state (
  id         integer primary key default 1 check (id = 1),
  balance    numeric(14,4) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);
insert into public.treasury_state (id) values (1);

create trigger trg_treasury_state_no_delete before delete on public.treasury_state
  for each row execute function public.forbid_mutation();
create trigger trg_treasury_state_no_truncate before truncate on public.treasury_state
  for each statement execute function public.forbid_mutation();

-- Append-only ledger. `amount` is signed (credit > 0, debit < 0); balance_after is the balance right after this row.
create table public.treasury_transactions (
  id            uuid primary key default gen_random_uuid(),
  seq           bigint generated always as identity unique,   -- stable ordering and pagination cursor
  type          public.treasury_transaction_type_enum not null,
  amount        numeric(14,4) not null check (amount <> 0),
  balance_after numeric(14,4) not null check (balance_after >= 0),
  description   text check (description is null or length(description) <= 500),
  reference_id  text check (reference_id is null or length(reference_id) between 1 and 200),
  created_at    timestamptz not null default now(),
  constraint treasury_tx_sign check (
    (type = 'deposit' and amount > 0)
    or (type in ('withdrawal', 'provider_topup', 'fee') and amount < 0)
    or type = 'manual_adjustment')
);
create index idx_treasury_tx_created on public.treasury_transactions (created_at desc);
-- One ledger entry per (type, reference): makes retries of an automated top-up or a double-clicked form idempotent.
create unique index uq_treasury_tx_reference on public.treasury_transactions (type, reference_id) where reference_id is not null;

create trigger trg_treasury_tx_no_update before update on public.treasury_transactions
  for each row execute function public.forbid_mutation();
create trigger trg_treasury_tx_no_delete before delete on public.treasury_transactions
  for each row execute function public.forbid_mutation();
create trigger trg_treasury_tx_no_truncate before truncate on public.treasury_transactions
  for each statement execute function public.forbid_mutation();

-- -----------------------------------------------------------------------------
-- The only way to change the treasury balance.
--   p_actor: the admin on whose behalf this runs; when given, an audit entry is written in the SAME transaction.
--   Replays: the same (type, reference_id) with the same amount returns the original row; with a different amount it is an error.
-- -----------------------------------------------------------------------------
create function public.process_treasury_transaction(
  p_type         public.treasury_transaction_type_enum,
  p_amount       numeric,
  p_description  text default null,
  p_reference_id text default null,
  p_actor        uuid default null
) returns public.treasury_transactions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state  treasury_state%rowtype;
  v_tx     treasury_transactions%rowtype;
  v_amount numeric(14,4);
  v_new    numeric(14,4);
begin
  if p_amount is null then
    raise exception 'amount is required' using errcode = 'invalid_parameter_value';
  end if;
  if abs(p_amount) >= 1000000000 then
    raise exception 'amount is out of range' using errcode = 'invalid_parameter_value';
  end if;
  v_amount := round(p_amount, 4);
  if v_amount = 0 then
    raise exception 'amount must be non-zero' using errcode = 'invalid_parameter_value';
  end if;
  if (p_type = 'deposit' and v_amount < 0)
     or (p_type in ('withdrawal', 'provider_topup', 'fee') and v_amount > 0) then
    raise exception 'amount sign does not match transaction type %', p_type using errcode = 'invalid_parameter_value';
  end if;
  if p_actor is not null and not exists (select 1 from users where id = p_actor and is_admin and not is_banned) then
    raise exception 'forbidden: actor is not an admin' using errcode = 'insufficient_privilege';
  end if;

  -- Serialise every treasury movement on the single state row.
  select * into v_state from treasury_state where id = 1 for update;

  if p_reference_id is not null then
    select * into v_tx from treasury_transactions where type = p_type and reference_id = p_reference_id;
    if found then
      if v_tx.amount <> v_amount then
        raise exception 'reference % was already used with a different amount', p_reference_id using errcode = 'unique_violation';
      end if;
      return v_tx;
    end if;
  end if;

  v_new := v_state.balance + v_amount;
  if v_new < 0 then
    raise exception 'insufficient_treasury_funds: available %, required %', v_state.balance, -v_amount
      using errcode = 'check_violation';
  end if;

  insert into treasury_transactions (type, amount, balance_after, description, reference_id)
  values (p_type, v_amount, v_new, p_description, p_reference_id)
  returning * into v_tx;

  update treasury_state set balance = v_new, updated_at = now() where id = 1;

  if p_actor is not null then
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'treasury_' || p_type::text, v_tx.id::text,
            jsonb_build_object('amount', v_amount, 'balance_after', v_new, 'description', p_description));
  end if;
  return v_tx;
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only. No client grants, no policies.
-- -----------------------------------------------------------------------------
alter table public.treasury_state enable row level security;
alter table public.treasury_transactions enable row level security;
revoke all on table public.treasury_state, public.treasury_transactions from anon, authenticated;
revoke all on function public.process_treasury_transaction(public.treasury_transaction_type_enum, numeric, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.process_treasury_transaction(public.treasury_transaction_type_enum, numeric, text, text, uuid)
  to service_role;
