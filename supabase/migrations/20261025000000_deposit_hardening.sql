-- =============================================================================
-- Phase 5: deposit verification hardening
--
-- 1. complete_deposit() re-checks the amount itself: the caller passes what the chain transfer actually carried
--    (p_received_nano) and anything below the quoted amount is refused, whatever the caller decided. The transaction
--    hash is validated (non-blank, no whitespace, at most 128 characters). Existing 3-argument calls keep working.
-- 2. flag_deposit_issue(): a payment that reached our wallet but cannot be credited (underpaid, paid too late, its
--    transaction already used) opens a reconciliation case for the deposit, so the money is never silently stuck.
-- =============================================================================

drop function public.complete_deposit(uuid, text, text);

create function public.complete_deposit(
  p_deposit_id     uuid,
  p_tx_hash        text,
  p_sender_address text default null,
  p_received_nano  numeric default null
) returns public.deposits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.deposits%rowtype;
begin
  if p_tx_hash is null or length(p_tx_hash) = 0 or length(p_tx_hash) > 128 or p_tx_hash ~ '\s' then
    raise exception 'tx hash is required and must be a single token of at most 128 characters' using errcode = 'invalid_parameter_value';
  end if;

  -- Serialises every verification of this deposit: concurrent callers queue here.
  select * into d from deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;

  if d.status = 'completed' then
    return d; -- already credited: idempotent (the ledger key below would refuse a second credit anyway)
  end if;
  if d.status = 'failed' then
    raise exception 'deposit % has failed and cannot be completed', d.id using errcode = 'check_violation';
  end if;

  if p_received_nano is not null and p_received_nano < round(d.amount_crypto * 1000000000) then
    raise exception 'underpaid: received % nanoton, required %', p_received_nano, round(d.amount_crypto * 1000000000)
      using errcode = 'check_violation';
  end if;

  -- Explicit check for a friendly error; the UNIQUE constraint on tx_hash is the real guarantee.
  if exists (select 1 from deposits where tx_hash = p_tx_hash and id <> d.id) then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end if;

  -- Two DIFFERENT deposits racing for the same hash both pass the check above (neither sees the other's uncommitted
  -- claim); the UNIQUE index then makes the second one wait and fail. Report that as the same business error.
  begin
    update deposits
       set status = 'completed', tx_hash = p_tx_hash, sender_address = p_sender_address, completed_at = now()
     where id = d.id
    returning * into d;
  exception when unique_violation then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end;

  perform process_wallet_transaction(
    d.user_id, 'deposit', d.amount_usd, d.id,
    'Deposit via Tonkeeper (' || d.asset || ')', 'deposit:' || d.id);

  return d;
end;
$$;

create function public.flag_deposit_issue(p_deposit_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from deposits where id = p_deposit_id) then
    raise exception 'deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;
  insert into reconciliation_cases (entity_type, entity_id, reason)
  values ('deposit', p_deposit_id::text, left(coalesce(nullif(trim(p_reason), ''), 'deposit needs attention'), 500))
  on conflict (entity_type, entity_id) where status = 'open'
  do update set reason = excluded.reason;
end;
$$;

revoke all on function public.complete_deposit(uuid, text, text, numeric), public.flag_deposit_issue(uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_deposit(uuid, text, text, numeric), public.flag_deposit_issue(uuid, text)
  to service_role;
