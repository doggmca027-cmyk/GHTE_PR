-- =============================================================================
-- Phase 1H: provider top-up proposals (approval mode)
--
-- When a provider's balance reaches its low-balance threshold the health monitor files ONE pending proposal for
-- the amount needed to reach target_topup_balance. An admin approves or rejects it in the dashboard:
--   approve -> the treasury is debited (process_treasury_transaction, type provider_topup) and the proposal is marked
--              approved in the SAME transaction; if the treasury cannot cover it nothing changes.
--   reject  -> status only, no treasury impact.
-- The external transfer to the provider is not automated yet: approval books the internal ledger movement only.
-- Service role only; admins go through the admin-treasury Edge Function.
-- =============================================================================

create type public.topup_proposal_status_enum as enum ('pending', 'approved', 'rejected');

create table public.topup_proposals (
  id          uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.providers(id) on delete cascade,
  amount      numeric(14,4) not null check (amount > 0),
  -- providers.currency at proposal time. The treasury has no FX: only USD proposals can be approved.
  currency    varchar(10) not null default 'USD',
  status      public.topup_proposal_status_enum not null default 'pending',
  decided_by  uuid references public.users(id) on delete set null,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- A provider can have at most one pending proposal.
create unique index uq_topup_pending_per_provider on public.topup_proposals (provider_id) where status = 'pending';
create index idx_topup_status_created on public.topup_proposals (status, created_at desc);
create trigger trg_topup_updated_at before update on public.topup_proposals
  for each row execute function public.set_updated_at();

alter table public.topup_proposals enable row level security;
revoke all on table public.topup_proposals from anon, authenticated;

-- -----------------------------------------------------------------------------
-- File a proposal. Idempotent: if the provider already has a pending one it is returned untouched.
-- -----------------------------------------------------------------------------
create function public.create_topup_proposal(p_provider_id uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount   numeric(14,4);
  v_currency varchar(10);
  v_row      topup_proposals%rowtype;
begin
  if p_amount is null or p_amount <= 0 or p_amount >= 1000000000 then
    raise exception 'amount must be positive' using errcode = 'invalid_parameter_value';
  end if;
  v_amount := round(p_amount, 4);
  if v_amount <= 0 then
    raise exception 'amount must be positive' using errcode = 'invalid_parameter_value';
  end if;
  select currency into v_currency from providers where id = p_provider_id;
  if not found then
    raise exception 'provider % not found', p_provider_id using errcode = 'no_data_found';
  end if;

  insert into topup_proposals (provider_id, amount, currency)
  values (p_provider_id, v_amount, v_currency)
  on conflict (provider_id) where status = 'pending' do nothing
  returning * into v_row;

  if found then
    return jsonb_build_object('id', v_row.id, 'amount', v_row.amount, 'currency', v_row.currency, 'created', true);
  end if;
  select * into v_row from topup_proposals where provider_id = p_provider_id and status = 'pending';
  return jsonb_build_object('id', v_row.id, 'amount', v_row.amount, 'currency', v_row.currency, 'created', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Approve: lock the proposal, debit the treasury, mark approved: all or nothing.
-- Lock order is always proposal -> treasury_state (nothing else takes both), so approvals cannot deadlock.
-- The treasury entry uses reference_id = proposal id, so even a hypothetical replay cannot debit twice.
-- -----------------------------------------------------------------------------
create function public.approve_topup_proposal(p_proposal_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p    topup_proposals%rowtype;
  v_name text;
  v_tx   treasury_transactions%rowtype;
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

  select name into v_name from providers where id = v_p.provider_id;
  -- Raises insufficient_treasury_funds when the treasury cannot cover it: the proposal then stays pending.
  v_tx := process_treasury_transaction('provider_topup', -v_p.amount, 'Top-up of ' || coalesce(v_name, 'provider'), v_p.id::text, p_actor);

  update topup_proposals set status = 'approved', decided_by = p_actor, decided_at = now() where id = v_p.id;
  return jsonb_build_object('id', v_p.id, 'status', 'approved', 'amount', v_p.amount, 'balance_after', v_tx.balance_after);
end;
$$;

create function public.reject_topup_proposal(p_proposal_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p topup_proposals%rowtype;
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
  update topup_proposals set status = 'rejected', decided_by = p_actor, decided_at = now() where id = v_p.id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'reject_topup_proposal', v_p.id::text, jsonb_build_object('provider_id', v_p.provider_id, 'amount', v_p.amount));
  return jsonb_build_object('id', v_p.id, 'status', 'rejected');
end;
$$;

revoke all on function public.create_topup_proposal(uuid, numeric), public.approve_topup_proposal(uuid, uuid), public.reject_topup_proposal(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_topup_proposal(uuid, numeric), public.approve_topup_proposal(uuid, uuid), public.reject_topup_proposal(uuid, uuid)
  to service_role;
