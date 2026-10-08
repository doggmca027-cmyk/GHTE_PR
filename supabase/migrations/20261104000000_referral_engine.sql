-- =============================================================================
-- Phase 12: referral engine and affiliate ledger
--
--   users.referred_by            who invited the user. Set once, never changed, never circular, never self (trigger).
--   users.referral_code          the user's own invite code (deep link: ?startapp=ref_<code>)
--   referral_ledger              APPEND-ONLY earnings of referrers. The affiliate balance is the SUM of this table, nowhere else:
--                                  reward              + a share of an invitee's final order charge
--                                  clawback            - the reward of an order that was refunded afterwards (once per reward)
--                                  transfer_to_wallet  - earnings moved into the main wallet
--   platform_settings            referral_reward_percentage (global) and referral_hold_days
--   users.referral_reward_percentage  optional per-referrer override
--
-- When rewards happen: a trigger on orders.status, in the SAME transaction as the status change (and therefore as the money
-- refund that comes with it), so a refund can never be committed without its clawback. Reward on `completed` / `partial`,
-- computed from the FINAL charge (charge - partial refund); clawback on `refunded` / `canceled` / `failed`. A failure inside the
-- reward logic never blocks an order (it is reported as a warning); reconcile_referral_rewards() repairs anything missed.
--
-- Money rules: amounts are numeric(14,4), rounded half away from zero at 1e-4. A reward never exceeds the order's profit.
-- Rewards are withdrawable after referral_hold_days (a late provider failure can still claw them back).
-- All functions are service-role only; the `referrals` Edge Function is the only caller.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Settings and user columns
-- -----------------------------------------------------------------------------
alter table public.platform_settings
  add column referral_reward_percentage numeric(5,2) not null default 5 check (referral_reward_percentage between 0 and 50),
  add column referral_hold_days         integer     not null default 7 check (referral_hold_days between 0 and 365);

alter table public.users
  add column referred_by                uuid references public.users(id) on delete restrict,
  add column referred_at                timestamptz,
  add column referral_code              text not null default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  add column referral_reward_percentage numeric(5,2) check (referral_reward_percentage between 0 and 50),
  add constraint users_not_self_referred check (referred_by is null or referred_by <> id),
  add constraint users_referral_code_unique unique (referral_code),
  add constraint users_referral_code_format check (referral_code ~ '^[a-z0-9]{6,32}$'),
  add constraint users_referred_pair check ((referred_by is null) = (referred_at is null));
create index idx_users_referred_by on public.users (referred_by) where referred_by is not null;

-- The referrer is set once, never changed and never forms a cycle. One global advisory lock serialises attributions, so two
-- concurrent "A refers B" / "B refers A" cannot both pass the cycle check (write skew). Attribution is rare.
create function public.guard_user_referral()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_cursor uuid;
  v_depth  integer := 0;
begin
  if tg_op = 'UPDATE' and old.referred_by is not null and new.referred_by is distinct from old.referred_by then
    raise exception 'referrer_locked: a referrer cannot be changed or removed' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and new.referral_code is distinct from old.referral_code then
    raise exception 'the referral code cannot be changed' using errcode = 'restrict_violation';
  end if;
  if new.referred_by is not null and (tg_op = 'INSERT' or old.referred_by is null) then
    perform pg_advisory_xact_lock(hashtext('referral_attribution'));
    if new.referred_by = new.id then
      raise exception 'self_referral: a user cannot refer themselves' using errcode = 'check_violation';
    end if;
    v_cursor := new.referred_by;
    while v_cursor is not null loop
      v_depth := v_depth + 1;
      if v_cursor = new.id or v_depth > 100 then
        raise exception 'circular_referral: this referral would form a loop' using errcode = 'check_violation';
      end if;
      select referred_by into v_cursor from users where id = v_cursor;
    end loop;
    new.referred_at := coalesce(new.referred_at, now());
  end if;
  return new;
end;
$$;
create trigger trg_users_guard_referral before insert or update of referred_by, referral_code on public.users
  for each row execute function public.guard_user_referral();

-- -----------------------------------------------------------------------------
-- 2. The append-only affiliate ledger
-- -----------------------------------------------------------------------------
create type public.referral_entry_type as enum ('reward', 'clawback', 'transfer_to_wallet');

create table public.referral_ledger (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users(id) on delete restrict,   -- the referrer who earns
  referred_user_id      uuid references public.users(id) on delete restrict,
  order_id              uuid references public.orders(id) on delete restrict,
  transaction_type      public.referral_entry_type not null,
  amount                numeric(14,4) not null check (amount <> 0),
  base_amount           numeric(14,4),          -- the final charge the reward was computed from
  percentage            numeric(5,2),           -- the rate applied (snapshot)
  available_at          timestamptz,            -- rewards: when they can be withdrawn
  reverses_id           uuid references public.referral_ledger(id) on delete restrict,
  wallet_transaction_id uuid references public.wallet_transactions(id) on delete restrict,
  idempotency_key       text not null unique,
  created_at            timestamptz not null default now(),
  constraint referral_ledger_shape check (
    (transaction_type = 'reward'             and amount > 0 and order_id is not null and referred_user_id is not null and available_at is not null and reverses_id is null)
 or (transaction_type = 'clawback'           and amount < 0 and order_id is not null and reverses_id is not null)
 or (transaction_type = 'transfer_to_wallet' and amount < 0 and wallet_transaction_id is not null and order_id is null))
);
create index idx_referral_ledger_user on public.referral_ledger (user_id, created_at);
create unique index uq_referral_one_reward_per_order on public.referral_ledger (order_id) where transaction_type = 'reward';
create unique index uq_referral_one_clawback_per_reward on public.referral_ledger (reverses_id) where reverses_id is not null;

create trigger trg_referral_ledger_no_update before update on public.referral_ledger
  for each row execute function public.forbid_mutation();
create trigger trg_referral_ledger_no_delete before delete on public.referral_ledger
  for each row execute function public.forbid_mutation();
create trigger trg_referral_ledger_no_truncate before truncate on public.referral_ledger
  for each statement execute function public.forbid_mutation();

alter table public.referral_ledger enable row level security;
revoke all on table public.referral_ledger from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Balance: always a sum of the ledger
-- -----------------------------------------------------------------------------
create function public.referral_balance(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'total',     coalesce(sum(l.amount), 0),
    -- rewards still inside the hold period that have not been clawed back
    'pending',   coalesce(sum(l.amount) filter (where l.transaction_type = 'reward' and l.available_at > now()
                                                 and not exists (select 1 from referral_ledger c where c.reverses_id = l.id)), 0),
    'available', greatest(coalesce(sum(l.amount), 0)
                          - coalesce(sum(l.amount) filter (where l.transaction_type = 'reward' and l.available_at > now()
                                                            and not exists (select 1 from referral_ledger c where c.reverses_id = l.id)), 0), 0))
  from referral_ledger l
 where l.user_id = p_user_id
$$;

-- -----------------------------------------------------------------------------
-- 4. Reward maths (one place)
-- -----------------------------------------------------------------------------
-- reward = round(final charge x percentage / 100, 4), never more than the profit that is left on the final charge.
-- final charge = charge - partial refund; the provider cost shrinks in the same proportion.
create function public.referral_reward_for_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o        orders%rowtype;
  v_ref    users%rowtype;
  v_pct    numeric(5,2);
  v_final  numeric(14,4);
  v_cost   numeric(14,4);
  v_reward numeric(14,4);
begin
  select * into o from orders where id = p_order_id;
  if not found then return null; end if;
  select r.* into v_ref from users u join users r on r.id = u.referred_by where u.id = o.user_id;
  if not found then return null; end if;

  v_pct := coalesce(v_ref.referral_reward_percentage, (select referral_reward_percentage from platform_settings where id = 1));
  v_final := o.charge_amount - o.partial_refund_amount;
  if v_final <= 0 or v_pct <= 0 then return null; end if;

  v_cost := case when o.charge_amount > 0 then round(o.cost_amount * v_final / o.charge_amount, 4) else 0 end;
  v_reward := least(round(v_final * v_pct / 100, 4), greatest(v_final - v_cost, 0));
  if v_reward <= 0 then return null; end if;

  return jsonb_build_object('referrer_id', v_ref.id, 'referred_user_id', o.user_id, 'reward', v_reward, 'base', v_final, 'percentage', v_pct);
end;
$$;

-- Serialises everything that moves one referrer's affiliate money (rewards, clawbacks, transfers): the referrer's wallet row.
-- Lock order is always buyer wallet -> referrer wallet (an invite chain is acyclic), so this cannot deadlock.
create function public.grant_order_reward(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc jsonb := referral_reward_for_order(p_order_id);
  v_hold integer;
begin
  if v_calc is null then return false; end if;
  perform 1 from wallets where user_id = (v_calc->>'referrer_id')::uuid for update;
  select referral_hold_days into v_hold from platform_settings where id = 1;
  insert into referral_ledger (user_id, referred_user_id, order_id, transaction_type, amount, base_amount, percentage, available_at, idempotency_key)
  values ((v_calc->>'referrer_id')::uuid, (v_calc->>'referred_user_id')::uuid, p_order_id, 'reward', (v_calc->>'reward')::numeric,
          (v_calc->>'base')::numeric, (v_calc->>'percentage')::numeric, now() + make_interval(days => v_hold), 'reward:' || p_order_id)
  on conflict (idempotency_key) do nothing;
  return found;
end;
$$;

create function public.claw_back_order_reward(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r referral_ledger%rowtype;
begin
  select * into r from referral_ledger where order_id = p_order_id and transaction_type = 'reward';
  if not found then return false; end if;
  perform 1 from wallets where user_id = r.user_id for update;
  insert into referral_ledger (user_id, referred_user_id, order_id, transaction_type, amount, base_amount, percentage, reverses_id, idempotency_key)
  values (r.user_id, r.referred_user_id, p_order_id, 'clawback', -r.amount, r.base_amount, r.percentage, r.id, 'clawback:' || p_order_id)
  on conflict (idempotency_key) do nothing;
  return found;
end;
$$;

-- The hook. AFTER the status change, same transaction. A bug here must never stop an order from completing or refunding.
create function public.trg_orders_referral()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    if new.status in ('completed', 'partial') then
      perform grant_order_reward(new.id);
    elsif new.status in ('refunded', 'canceled', 'failed') then
      perform claw_back_order_reward(new.id);
    end if;
  exception when others then
    raise warning 'referral reward for order % skipped: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
create trigger trg_orders_referral after update of status on public.orders
  for each row when (old.status is distinct from new.status)
  execute function public.trg_orders_referral();

-- Repairs rewards and clawbacks the hook could not write (idempotent; safe to run by hand or from a scheduler).
create function public.reconcile_referral_rewards(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o       record;
  v_new   integer := 0;
  v_claw  integer := 0;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
begin
  for o in
    select ord.id, ord.status from orders ord
      join users u on u.id = ord.user_id and u.referred_by is not null and ord.created_at >= u.referred_at
     where (ord.status in ('completed', 'partial') and not exists (select 1 from referral_ledger l where l.order_id = ord.id and l.transaction_type = 'reward'))
        or (ord.status in ('refunded', 'canceled', 'failed')
            and exists (select 1 from referral_ledger l where l.order_id = ord.id and l.transaction_type = 'reward')
            and not exists (select 1 from referral_ledger c where c.order_id = ord.id and c.transaction_type = 'clawback'))
     order by ord.updated_at
     limit v_limit
  loop
    if o.status in ('completed', 'partial') then
      if grant_order_reward(o.id) then v_new := v_new + 1; end if;
    elsif claw_back_order_reward(o.id) then
      v_claw := v_claw + 1;
    end if;
  end loop;
  return jsonb_build_object('rewards_created', v_new, 'clawbacks_created', v_claw);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Attribution
-- -----------------------------------------------------------------------------
create function public.apply_referral(p_user_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     users%rowtype;
  v_referrer users%rowtype;
  v_code     text := lower(btrim(coalesce(p_code, '')));
begin
  if v_code !~ '^[a-z0-9]{6,32}$' then
    raise exception 'referral_code_not_found: unknown referral code' using errcode = 'no_data_found';
  end if;
  select * into v_referrer from users where referral_code = v_code;
  if not found then
    raise exception 'referral_code_not_found: unknown referral code' using errcode = 'no_data_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('referral_attribution'));
  select * into v_user from users where id = p_user_id for update;
  if not found then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;

  if v_user.referred_by is not null then
    if v_user.referred_by = v_referrer.id then
      return jsonb_build_object('referrer_id', v_referrer.id, 'already_applied', true);
    end if;
    raise exception 'already_referred: the referrer cannot be changed' using errcode = 'restrict_violation';
  end if;
  if v_referrer.id = v_user.id then
    raise exception 'self_referral: a user cannot refer themselves' using errcode = 'check_violation';
  end if;
  if v_referrer.is_banned or v_user.is_banned then
    raise exception 'referrer_unavailable: this referral link cannot be used' using errcode = 'check_violation';
  end if;
  -- A referral must come with the first visit: once someone has ordered, they cannot attach themselves to a friend afterwards.
  if exists (select 1 from orders where user_id = v_user.id) then
    raise exception 'referral_too_late: referrals can only be applied before the first order' using errcode = 'check_violation';
  end if;

  update users set referred_by = v_referrer.id where id = v_user.id;   -- the trigger re-checks self / loop / lock
  return jsonb_build_object('referrer_id', v_referrer.id, 'already_applied', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Withdrawal to the main wallet
-- -----------------------------------------------------------------------------
-- Moves cleared earnings into the wallet (as a 'bonus' credit). The referrer's wallet row is locked first (the same row every
-- reward, clawback and wallet movement of this user serialises on), then the balance is recomputed from the ledger: two
-- concurrent transfers cannot both see the same money. p_amount null = everything available.
create function public.transfer_affiliate_balance_to_wallet(
  p_user_id         uuid,
  p_amount          numeric default null,
  p_idempotency_key text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key       text := coalesce(nullif(btrim(p_idempotency_key), ''), 'transfer:' || gen_random_uuid());
  v_existing  referral_ledger%rowtype;
  v_available numeric(14,4);
  v_amount    numeric(14,4);
  v_tx        wallet_transactions%rowtype;
  v_ledger    referral_ledger%rowtype;
begin
  if length(v_key) > 100 then
    raise exception 'invalid_parameter_value: idempotency key is too long' using errcode = 'invalid_parameter_value';
  end if;
  if p_amount is not null and round(p_amount, 4) <= 0 then
    raise exception 'invalid_parameter_value: amount must be greater than zero' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;

  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  -- replay of a finished transfer: answer with it, move nothing
  select * into v_existing from referral_ledger where idempotency_key = 'transfer:' || v_key and user_id = p_user_id;
  if found then
    return jsonb_build_object('transferred', -v_existing.amount, 'replayed', true, 'balance', referral_balance(p_user_id));
  end if;
  if exists (select 1 from referral_ledger where idempotency_key = 'transfer:' || v_key) then
    raise exception 'idempotency_conflict: this key belongs to another user' using errcode = 'unique_violation';
  end if;

  v_available := (referral_balance(p_user_id)->>'available')::numeric;
  v_amount := round(coalesce(p_amount, v_available), 4);
  if v_amount <= 0 then
    raise exception 'insufficient_affiliate_balance: nothing is available to transfer' using errcode = 'check_violation';
  end if;
  if v_amount > v_available then
    raise exception 'insufficient_affiliate_balance: available %, requested %', v_available, v_amount using errcode = 'check_violation';
  end if;

  v_tx := process_wallet_transaction(p_user_id, 'bonus', v_amount, null, 'Affiliate earnings transferred to the wallet', 'affiliate:' || v_key);
  insert into referral_ledger (user_id, transaction_type, amount, wallet_transaction_id, idempotency_key)
  values (p_user_id, 'transfer_to_wallet', -v_amount, v_tx.id, 'transfer:' || v_key)
  returning * into v_ledger;

  return jsonb_build_object('transferred', v_amount, 'replayed', false, 'wallet_balance', v_tx.balance_after, 'balance', referral_balance(p_user_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Read model for the Edge Function and the admin rate switch
-- -----------------------------------------------------------------------------
create function public.referral_summary(p_user_id uuid, p_recent integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  u users%rowtype;
begin
  select * into u from users where id = p_user_id;
  if not found then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;
  return jsonb_build_object(
    'code', u.referral_code,
    'referred', u.referred_by is not null,
    'percentage', coalesce(u.referral_reward_percentage, (select referral_reward_percentage from platform_settings where id = 1)),
    'hold_days', (select referral_hold_days from platform_settings where id = 1),
    'invitees', (select count(*) from users where referred_by = p_user_id),
    'balance', referral_balance(p_user_id),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.transaction_type, 'amount', e.amount, 'order_id', e.order_id,
                                                           'available_at', e.available_at, 'created_at', e.created_at) order by e.created_at desc, e.id)
                          from (select * from referral_ledger where user_id = p_user_id order by created_at desc, id limit least(greatest(coalesce(p_recent, 20), 1), 100)) e), '[]'::jsonb));
end;
$$;

-- Sets the global reward rate (p_user_id null) or one referrer's override (p_percentage null removes the override). Audited.
create function public.admin_set_referral_rate(p_actor uuid, p_percentage numeric, p_user_id uuid default null, p_hold_days integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_catalog_admin(p_actor);
  if p_percentage is not null and (p_percentage < 0 or p_percentage > 50) then
    raise exception 'invalid_parameter_value: percentage must be between 0 and 50' using errcode = 'invalid_parameter_value';
  end if;
  if p_hold_days is not null and (p_hold_days < 0 or p_hold_days > 365) then
    raise exception 'invalid_parameter_value: hold days must be between 0 and 365' using errcode = 'invalid_parameter_value';
  end if;
  if p_user_id is null then
    if p_percentage is null and p_hold_days is null then
      raise exception 'invalid_parameter_value: nothing to update' using errcode = 'invalid_parameter_value';
    end if;
    update platform_settings set referral_reward_percentage = coalesce(round(p_percentage, 2), referral_reward_percentage),
                                 referral_hold_days = coalesce(p_hold_days, referral_hold_days), updated_by = p_actor, updated_at = now() where id = 1;
  else
    update users set referral_reward_percentage = round(p_percentage, 2) where id = p_user_id;
    if not found then
      raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
    end if;
  end if;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'set_referral_rate', coalesce(p_user_id::text, 'global'), jsonb_build_object('percentage', p_percentage, 'hold_days', p_hold_days));
  return jsonb_build_object('percentage', p_percentage, 'hold_days', p_hold_days, 'user_id', p_user_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Backfill the codes of existing users happened through the column default; lock everything down.
-- -----------------------------------------------------------------------------
revoke all on function public.guard_user_referral() from public, anon, authenticated;
revoke all on function public.trg_orders_referral() from public, anon, authenticated;
revoke all on function public.referral_balance(uuid) from public, anon, authenticated;
revoke all on function public.referral_reward_for_order(uuid) from public, anon, authenticated;
revoke all on function public.grant_order_reward(uuid) from public, anon, authenticated;
revoke all on function public.claw_back_order_reward(uuid) from public, anon, authenticated;
revoke all on function public.reconcile_referral_rewards(integer) from public, anon, authenticated;
revoke all on function public.apply_referral(uuid, text) from public, anon, authenticated;
revoke all on function public.transfer_affiliate_balance_to_wallet(uuid, numeric, text) from public, anon, authenticated;
revoke all on function public.referral_summary(uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_set_referral_rate(uuid, numeric, uuid, integer) from public, anon, authenticated;

grant execute on function public.referral_balance(uuid) to service_role;
grant execute on function public.reconcile_referral_rewards(integer) to service_role;
grant execute on function public.apply_referral(uuid, text) to service_role;
grant execute on function public.transfer_affiliate_balance_to_wallet(uuid, numeric, text) to service_role;
grant execute on function public.referral_summary(uuid, integer) to service_role;
grant execute on function public.admin_set_referral_rate(uuid, numeric, uuid, integer) to service_role;
