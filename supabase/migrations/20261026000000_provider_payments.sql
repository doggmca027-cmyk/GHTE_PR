-- =============================================================================
-- Phase 6: provider payments (outbound transfers) state machine + hard limits
--
-- Approving a top-up proposal no longer just books the treasury: it creates a provider_payment that moves through
--
--   PROPOSED -> APPROVED -> VALIDATED -> PAYMENT_CREATED -> BROADCASTED -> CONFIRMING -> CONFIRMED
--            -> PROVIDER_BALANCE_VERIFIED -> COMPLETED
--   with FAILED / CANCELED (money returned to the treasury) and UNKNOWN -> RECONCILIATION_REQUIRED (outcome unknown:
--   nothing is returned, a human decides).
--
-- VALIDATED is the money gate. One transaction, under row locks, checks every hard limit and debits the treasury:
--   * destination wallet = the provider's allowed_destination_wallet (server config, never the client)
--   * network / asset    = the provider's payout config
--   * amount <= max_topup_per_tx
--   * today's committed top-ups of this provider + amount <= max_daily_topup   (provider row locked FOR UPDATE)
--   * treasury balance - amount >= platform_settings.minimum_treasury_reserve   (treasury row locked FOR UPDATE)
-- Limits that are not configured REFUSE the payment (fail closed), they never mean "unlimited".
-- Service role only, except the two admin configuration RPCs.
-- =============================================================================

create type public.provider_payment_status_enum as enum (
  'PROPOSED', 'VALIDATED', 'APPROVED', 'PAYMENT_CREATED', 'BROADCASTED', 'CONFIRMING', 'CONFIRMED',
  'PROVIDER_BALANCE_VERIFIED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'RECONCILIATION_REQUIRED', 'CANCELED'
);

-- -----------------------------------------------------------------------------
-- Limits and payout configuration
-- -----------------------------------------------------------------------------
alter table public.providers
  add column allowed_destination_wallet text check (allowed_destination_wallet is null or length(trim(allowed_destination_wallet)) between 10 and 200),
  add column payout_network varchar(10) not null default 'mainnet' check (payout_network in ('mainnet', 'testnet')),
  add column payout_asset   varchar(10) not null default 'TON' check (payout_asset in ('TON', 'USDT')),
  add column max_topup_per_tx numeric(14,4) check (max_topup_per_tx is null or max_topup_per_tx > 0),
  add column max_daily_topup  numeric(14,4) check (max_daily_topup is null or max_daily_topup > 0),
  add constraint providers_daily_covers_tx check (max_daily_topup is null or max_topup_per_tx is null or max_daily_topup >= max_topup_per_tx);

alter table public.platform_settings
  add column minimum_treasury_reserve numeric(14,4) not null default 0 check (minimum_treasury_reserve >= 0);

-- -----------------------------------------------------------------------------
-- The payments
-- -----------------------------------------------------------------------------
create table public.provider_payments (
  id                 uuid primary key default gen_random_uuid(),
  provider_id        uuid not null references public.providers(id) on delete restrict,
  proposal_id        uuid unique references public.topup_proposals(id) on delete restrict,
  amount             numeric(14,4) not null check (amount > 0),
  currency           varchar(10) not null default 'USD',
  asset              varchar(10) not null,
  network            varchar(10) not null check (network in ('mainnet', 'testnet')),
  destination_wallet text not null,
  tx_hash            text unique check (tx_hash is null or (length(tx_hash) between 1 and 200 and tx_hash !~ '\s')),
  status             public.provider_payment_status_enum not null default 'PROPOSED',
  idempotency_key    text not null unique,
  treasury_debited   boolean not null default false,
  treasury_reversed  boolean not null default false,
  failure_reason     text check (failure_reason is null or length(failure_reason) <= 500),
  created_by         uuid references public.users(id) on delete set null,
  validated_at       timestamptz,
  broadcasted_at     timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint pp_reversal_needs_debit check (not treasury_reversed or treasury_debited)
);
create index idx_pp_provider_validated on public.provider_payments (provider_id, validated_at) where treasury_debited and not treasury_reversed;
create index idx_pp_status on public.provider_payments (status, created_at);
create trigger trg_pp_updated_at before update on public.provider_payments
  for each row execute function public.set_updated_at();

create function public.is_valid_provider_payment_transition(p_old public.provider_payment_status_enum, p_new public.provider_payment_status_enum)
returns boolean
language sql
immutable
as $$
  select case p_old
    when 'PROPOSED'                  then p_new in ('APPROVED', 'CANCELED')
    when 'APPROVED'                  then p_new in ('VALIDATED', 'FAILED', 'CANCELED')
    when 'VALIDATED'                 then p_new in ('PAYMENT_CREATED', 'FAILED', 'CANCELED')
    when 'PAYMENT_CREATED'           then p_new in ('BROADCASTED', 'FAILED', 'UNKNOWN', 'CANCELED')
    when 'BROADCASTED'               then p_new in ('CONFIRMING', 'FAILED', 'UNKNOWN')
    when 'CONFIRMING'                then p_new in ('CONFIRMED', 'FAILED', 'UNKNOWN')
    when 'CONFIRMED'                 then p_new in ('PROVIDER_BALANCE_VERIFIED', 'RECONCILIATION_REQUIRED')
    when 'PROVIDER_BALANCE_VERIFIED' then p_new in ('COMPLETED')
    when 'UNKNOWN'                   then p_new in ('RECONCILIATION_REQUIRED')
    when 'RECONCILIATION_REQUIRED'   then p_new in ('BROADCASTED', 'COMPLETED', 'FAILED')
    else false  -- COMPLETED, FAILED, CANCELED are terminal
  end
$$;

-- Valid transitions only; the payment's terms and a recorded tx hash never change; rows are never deleted.
create function public.guard_provider_payment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'provider payments cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status and not is_valid_provider_payment_transition(old.status, new.status) then
    raise exception 'invalid provider payment transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.provider_id <> old.provider_id or new.amount <> old.amount or new.currency <> old.currency or new.asset <> old.asset
     or new.network <> old.network or new.destination_wallet <> old.destination_wallet or new.idempotency_key <> old.idempotency_key
     or new.proposal_id is distinct from old.proposal_id then
    raise exception 'provider payment terms are immutable' using errcode = 'restrict_violation';
  end if;
  if old.tx_hash is not null and new.tx_hash is distinct from old.tx_hash then
    raise exception 'a recorded transaction hash cannot change' using errcode = 'restrict_violation';
  end if;
  if old.treasury_reversed and not new.treasury_reversed or old.treasury_debited and not new.treasury_debited then
    raise exception 'treasury flags only move forward' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
create trigger trg_pp_guard before update or delete on public.provider_payments
  for each row execute function public.guard_provider_payment();

alter table public.provider_payments enable row level security;
revoke all on table public.provider_payments from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create function public.assert_payment_actor(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- NULL = the system (service role worker); otherwise it must be a live admin
  if p_actor is not null and not exists (select 1 from users where id = p_actor and is_admin and not is_banned) then
    raise exception 'forbidden: actor is not an admin' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Gives the money back to the treasury once (reference = payment), for payments that definitively never left.
create function public.reverse_provider_payment(p_payment_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  select * into pay from provider_payments where id = p_payment_id for update;
  if not pay.treasury_debited or pay.treasury_reversed then
    return;
  end if;
  perform process_treasury_transaction('manual_adjustment', pay.amount, 'Reversal of provider payment ' || pay.id, 'payment-reversal:' || pay.id, p_actor);
  update provider_payments set treasury_reversed = true where id = pay.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- The money gate: APPROVED -> VALIDATED with every hard limit checked under locks, treasury debited
-- -----------------------------------------------------------------------------
create function public.validate_provider_payment(p_payment_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay       provider_payments%rowtype;
  prov      providers%rowtype;
  v_state   treasury_state%rowtype;
  v_reserve numeric(14,4);
  v_today   numeric(14,4);
  v_tx      treasury_transactions%rowtype;
begin
  perform assert_payment_actor(p_actor);

  -- Lock order everywhere: payment -> provider -> treasury_state.
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found';
  end if;
  if pay.status = 'VALIDATED' then
    return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true);
  end if;
  if pay.status <> 'APPROVED' then
    raise exception 'payment_not_approved: payment is %', pay.status using errcode = 'check_violation';
  end if;

  -- (1) per-provider budget: the provider row is the lock every validation of this provider queues on
  select * into prov from providers where id = pay.provider_id for update;
  if prov.allowed_destination_wallet is null then
    raise exception 'payout_not_configured: provider has no allowed destination wallet' using errcode = 'check_violation';
  end if;
  if pay.destination_wallet <> prov.allowed_destination_wallet then
    raise exception 'destination_not_allowed: the destination is not the provider''s allowed wallet' using errcode = 'check_violation';
  end if;
  if pay.network <> prov.payout_network or pay.asset <> prov.payout_asset then
    raise exception 'payout_config_mismatch: network or asset differs from the provider configuration' using errcode = 'check_violation';
  end if;
  if prov.max_topup_per_tx is null or prov.max_daily_topup is null then
    raise exception 'payout_limits_not_configured: set max_topup_per_tx and max_daily_topup first' using errcode = 'check_violation';
  end if;
  if pay.amount > prov.max_topup_per_tx then
    raise exception 'max_topup_per_tx_exceeded: requested %, limit %', pay.amount, prov.max_topup_per_tx using errcode = 'check_violation';
  end if;
  -- everything committed today (UTC) and not given back: validated, created, broadcast, confirming, unknown, done
  select coalesce(sum(amount), 0) into v_today
    from provider_payments
   where provider_id = prov.id and id <> pay.id and treasury_debited and not treasury_reversed
     and validated_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');
  if v_today + pay.amount > prov.max_daily_topup then
    raise exception 'max_daily_topup_exceeded: used today %, requested %, limit %', v_today, pay.amount, prov.max_daily_topup
      using errcode = 'check_violation';
  end if;

  -- (2) treasury reserve: the single treasury row is locked before its balance is read
  select * into v_state from treasury_state where id = 1 for update;
  select minimum_treasury_reserve into v_reserve from platform_settings where id = 1;
  if v_state.balance < pay.amount then
    raise exception 'insufficient_treasury_funds: available %, required %', v_state.balance, pay.amount using errcode = 'check_violation';
  end if;
  if v_state.balance - pay.amount < coalesce(v_reserve, 0) then
    raise exception 'treasury_reserve_breached: balance %, requested %, minimum reserve %', v_state.balance, pay.amount, v_reserve
      using errcode = 'check_violation';
  end if;

  -- (3) debit (same transaction; the reference makes a replay impossible)
  v_tx := process_treasury_transaction('provider_topup', -pay.amount, 'Top-up of ' || prov.name,
                                       coalesce(pay.proposal_id, pay.id)::text, p_actor);
  update provider_payments set status = 'VALIDATED', treasury_debited = true, validated_at = now() where id = pay.id;
  return jsonb_build_object('payment_id', pay.id, 'status', 'VALIDATED', 'balance_after', v_tx.balance_after, 'used_today', v_today + pay.amount);
end;
$$;

-- -----------------------------------------------------------------------------
-- Approving a proposal now creates the payment (destination, network and asset from the provider's server-side
-- config) and validates it, all in one transaction: if any limit refuses, nothing happens and the proposal stays
-- pending.
-- -----------------------------------------------------------------------------
create or replace function public.approve_topup_proposal(p_proposal_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p    topup_proposals%rowtype;
  prov   providers%rowtype;
  v_pay  uuid;
  v_res  jsonb;
begin
  if p_actor is null or not exists (select 1 from users where id = p_actor and is_admin and not is_banned) then
    raise exception 'forbidden: actor is not an admin' using errcode = 'insufficient_privilege';
  end if;

  select * into v_p from topup_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal % not found', p_proposal_id using errcode = 'no_data_found';
  end if;
  if v_p.status <> 'pending' then
    raise exception 'proposal_not_pending: already %', v_p.status using errcode = 'check_violation';
  end if;
  if v_p.currency <> 'USD' then
    raise exception 'unsupported_currency: the treasury is held in USD, the proposal is in %', v_p.currency using errcode = 'check_violation';
  end if;

  select * into prov from providers where id = v_p.provider_id;
  if prov.allowed_destination_wallet is null then
    raise exception 'payout_not_configured: provider has no allowed destination wallet' using errcode = 'check_violation';
  end if;

  insert into provider_payments (provider_id, proposal_id, amount, currency, asset, network, destination_wallet, status, idempotency_key, created_by)
  values (prov.id, v_p.id, v_p.amount, 'USD', prov.payout_asset, prov.payout_network, prov.allowed_destination_wallet, 'PROPOSED',
          'proposal:' || v_p.id, p_actor)
  returning id into v_pay;
  update provider_payments set status = 'APPROVED' where id = v_pay;

  v_res := validate_provider_payment(v_pay, p_actor); -- raises (and rolls everything back) when a limit refuses

  update topup_proposals set status = 'approved', decided_by = p_actor, decided_at = now() where id = v_p.id;
  return jsonb_build_object('id', v_p.id, 'status', 'approved', 'amount', v_p.amount, 'balance_after', v_res -> 'balance_after',
                            'payment_id', v_pay, 'payment_status', 'VALIDATED');
end;
$$;

-- -----------------------------------------------------------------------------
-- Later steps (each one a guarded transition)
-- -----------------------------------------------------------------------------
-- VALIDATED -> PAYMENT_CREATED: the transfer instruction exists (destination / amount / network fixed above)
create function public.create_provider_payment_instruction(p_payment_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  perform assert_payment_actor(p_actor);
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found'; end if;
  if pay.status = 'PAYMENT_CREATED' then return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true); end if;
  update provider_payments set status = 'PAYMENT_CREATED' where id = pay.id;
  return jsonb_build_object('payment_id', pay.id, 'status', 'PAYMENT_CREATED', 'destination_wallet', pay.destination_wallet,
                            'amount', pay.amount, 'asset', pay.asset, 'network', pay.network, 'idempotency_key', pay.idempotency_key);
end;
$$;

-- PAYMENT_CREATED (or a reconciliation that found the transfer) -> BROADCASTED with its hash
create function public.record_provider_payment_broadcast(p_payment_id uuid, p_tx_hash text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  perform assert_payment_actor(p_actor);
  if p_tx_hash is null or length(trim(p_tx_hash)) = 0 then
    raise exception 'the transaction hash is required' using errcode = 'invalid_parameter_value';
  end if;
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found'; end if;
  if pay.status = 'BROADCASTED' and pay.tx_hash = trim(p_tx_hash) then
    return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true);
  end if;
  begin
    update provider_payments set status = 'BROADCASTED', tx_hash = trim(p_tx_hash), broadcasted_at = now() where id = pay.id;
  exception when unique_violation then
    raise exception 'tx_already_used: this transaction is recorded on another payment' using errcode = 'unique_violation';
  end;
  return jsonb_build_object('payment_id', pay.id, 'status', 'BROADCASTED');
end;
$$;

-- BROADCASTED -> CONFIRMING -> CONFIRMED -> PROVIDER_BALANCE_VERIFIED -> COMPLETED, and RECONCILIATION_REQUIRED -> COMPLETED
create function public.advance_provider_payment(p_payment_id uuid, p_to public.provider_payment_status_enum, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  perform assert_payment_actor(p_actor);
  if p_to not in ('CONFIRMING', 'CONFIRMED', 'PROVIDER_BALANCE_VERIFIED', 'COMPLETED') then
    raise exception 'use the dedicated function for %', p_to using errcode = 'invalid_parameter_value';
  end if;
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found'; end if;
  if pay.status = p_to then return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true); end if;
  if p_to = 'COMPLETED' and pay.tx_hash is null then
    raise exception 'a payment cannot complete without a transaction hash' using errcode = 'check_violation';
  end if;
  update provider_payments set status = p_to, completed_at = case when p_to = 'COMPLETED' then now() else completed_at end where id = pay.id;
  if p_to = 'COMPLETED' then
    update reconciliation_cases set status = 'resolved', resolution = 'manual', resolution_note = 'payment completed', resolved_by = p_actor, resolved_at = now()
     where entity_type = 'provider_payment' and entity_id = pay.id::text and status = 'open';
  end if;
  return jsonb_build_object('payment_id', pay.id, 'status', p_to);
end;
$$;

-- Outcome unknown (timeout after sending, chain lookup lost...): never refunded, a human decides.
create function public.mark_provider_payment_unknown(p_payment_id uuid, p_reason text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  perform assert_payment_actor(p_actor);
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found'; end if;
  if pay.status = 'RECONCILIATION_REQUIRED' then return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true); end if;
  update provider_payments set status = 'UNKNOWN', failure_reason = left(p_reason, 500) where id = pay.id;
  update provider_payments set status = 'RECONCILIATION_REQUIRED' where id = pay.id;
  insert into reconciliation_cases (entity_type, entity_id, reason)
  values ('provider_payment', pay.id::text, left('outcome unknown: ' || coalesce(p_reason, ''), 500))
  on conflict (entity_type, entity_id) where status = 'open' do update set reason = excluded.reason;
  return jsonb_build_object('payment_id', pay.id, 'status', 'RECONCILIATION_REQUIRED');
end;
$$;

-- The transfer definitively did not happen: FAILED, treasury money returned (once).
create function public.fail_provider_payment(p_payment_id uuid, p_reason text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  perform assert_payment_actor(p_actor);
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found'; end if;
  if pay.status = 'FAILED' then return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true); end if;
  update provider_payments set status = 'FAILED', failure_reason = left(p_reason, 500) where id = pay.id;
  perform reverse_provider_payment(pay.id, p_actor);
  update reconciliation_cases set status = 'resolved', resolution = 'manual', resolution_note = 'payment failed, treasury reversed', resolved_by = p_actor, resolved_at = now()
   where entity_type = 'provider_payment' and entity_id = pay.id::text and status = 'open';
  return jsonb_build_object('payment_id', pay.id, 'status', 'FAILED', 'reversed', pay.treasury_debited);
end;
$$;

-- Stopped before anything was sent: CANCELED, treasury money returned (once).
create function public.cancel_provider_payment(p_payment_id uuid, p_reason text, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pay provider_payments%rowtype;
begin
  perform assert_payment_actor(p_actor);
  select * into pay from provider_payments where id = p_payment_id for update;
  if not found then raise exception 'payment % not found', p_payment_id using errcode = 'no_data_found'; end if;
  if pay.status = 'CANCELED' then return jsonb_build_object('payment_id', pay.id, 'status', pay.status, 'already', true); end if;
  update provider_payments set status = 'CANCELED', failure_reason = left(p_reason, 500) where id = pay.id;
  perform reverse_provider_payment(pay.id, p_actor);
  return jsonb_build_object('payment_id', pay.id, 'status', 'CANCELED', 'reversed', pay.treasury_debited);
end;
$$;

-- -----------------------------------------------------------------------------
-- Admin configuration RPCs (callable by signed-in admins; audited)
-- -----------------------------------------------------------------------------
create function public.admin_set_provider_payout(
  p_provider_id      uuid,
  p_wallet           text,
  p_network          text,
  p_asset            text,
  p_max_topup_per_tx numeric,
  p_max_daily_topup  numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  old_p   providers%rowtype;
begin
  select * into old_p from providers where id = p_provider_id for update;
  if not found then raise exception 'provider % not found', p_provider_id using errcode = 'no_data_found'; end if;
  update providers
     set allowed_destination_wallet = nullif(trim(p_wallet), ''), payout_network = p_network, payout_asset = p_asset,
         max_topup_per_tx = p_max_topup_per_tx, max_daily_topup = p_max_daily_topup
   where id = p_provider_id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'set_provider_payout', p_provider_id::text, jsonb_build_object(
    'wallet', jsonb_build_array(old_p.allowed_destination_wallet, nullif(trim(p_wallet), '')),
    'network', p_network, 'asset', p_asset, 'max_topup_per_tx', p_max_topup_per_tx, 'max_daily_topup', p_max_daily_topup));
  return jsonb_build_object('id', p_provider_id, 'allowed_destination_wallet', nullif(trim(p_wallet), ''), 'payout_network', p_network,
                            'payout_asset', p_asset, 'max_topup_per_tx', p_max_topup_per_tx, 'max_daily_topup', p_max_daily_topup);
end;
$$;

create function public.admin_set_treasury_reserve(p_minimum numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  v_old   numeric;
begin
  if p_minimum is null or p_minimum < 0 or p_minimum >= 1000000000 then
    raise exception 'the minimum reserve must be between 0 and 1000000000' using errcode = 'invalid_parameter_value';
  end if;
  select minimum_treasury_reserve into v_old from platform_settings where id = 1 for update;
  update platform_settings set minimum_treasury_reserve = round(p_minimum, 4), updated_by = v_admin, updated_at = now() where id = 1;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'set_treasury_reserve', '1', jsonb_build_object('minimum_treasury_reserve', jsonb_build_array(v_old, round(p_minimum, 4))));
  return jsonb_build_object('minimum_treasury_reserve', round(p_minimum, 4));
end;
$$;

-- -----------------------------------------------------------------------------
-- Access
-- -----------------------------------------------------------------------------
revoke all on function
  public.is_valid_provider_payment_transition(public.provider_payment_status_enum, public.provider_payment_status_enum),
  public.guard_provider_payment(), public.assert_payment_actor(uuid), public.reverse_provider_payment(uuid, uuid),
  public.validate_provider_payment(uuid, uuid), public.create_provider_payment_instruction(uuid, uuid),
  public.record_provider_payment_broadcast(uuid, text, uuid),
  public.advance_provider_payment(uuid, public.provider_payment_status_enum, uuid),
  public.mark_provider_payment_unknown(uuid, text, uuid), public.fail_provider_payment(uuid, text, uuid),
  public.cancel_provider_payment(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.validate_provider_payment(uuid, uuid), public.create_provider_payment_instruction(uuid, uuid),
  public.record_provider_payment_broadcast(uuid, text, uuid),
  public.advance_provider_payment(uuid, public.provider_payment_status_enum, uuid),
  public.mark_provider_payment_unknown(uuid, text, uuid), public.fail_provider_payment(uuid, text, uuid),
  public.cancel_provider_payment(uuid, text, uuid)
  to service_role;

revoke all on function public.admin_set_provider_payout(uuid, text, text, text, numeric, numeric), public.admin_set_treasury_reserve(numeric) from public, anon;
grant execute on function public.admin_set_provider_payout(uuid, text, text, text, numeric, numeric), public.admin_set_treasury_reserve(numeric) to authenticated, service_role;
