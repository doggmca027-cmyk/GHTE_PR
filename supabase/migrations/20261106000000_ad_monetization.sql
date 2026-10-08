-- =============================================================================
-- Phase 14: ad monetization (server-to-server postbacks)
--
--   ad_providers        per ad network: the FIXED payout to the user (the network's own number is never read), on/off, per-user daily cap
--   user_ad_ledger      append-only record of every postback: credited, or soft-rejected (limit / banned), once per (network, tx)
--   process_ad_reward   the only way money moves: one transaction that locks the user's wallet, de-duplicates the network's
--                       transaction id, enforces the rolling 24 h caps and credits the main wallet (type 'ad_reward')
--
-- The networks are seeded OFF with a small reward: nothing pays out until an admin enables a network AND its signing secret is
-- set on the Edge Function. Signatures are verified by the ad-webhook function before this is ever called; this function trusts
-- only (user, network, transaction id). Service role only.
-- =============================================================================

alter type public.transaction_type_enum add value if not exists 'ad_reward';

alter table public.platform_settings
  add column max_daily_ad_earnings numeric(14,4) not null default 1.0000 check (max_daily_ad_earnings >= 0);

create table public.ad_providers (
  id                  text primary key check (id ~ '^[a-z0-9_]{2,30}$'),
  name                text not null,
  reward_amount       numeric(14,4) not null check (reward_amount > 0 and reward_amount <= 100),
  daily_limit_per_user numeric(14,4) not null default 0.5000 check (daily_limit_per_user >= 0),
  is_active           boolean not null default false,
  updated_at          timestamptz not null default now()
);
insert into public.ad_providers (id, name, reward_amount, daily_limit_per_user, is_active) values
  ('adsgram', 'AdsGram', 0.0050, 0.5000, false),
  ('monetag', 'Monetag', 0.0050, 0.5000, false),
  ('gigapub', 'GigaPub', 0.0050, 0.5000, false);

create type public.ad_ledger_status as enum ('credited', 'rejected');

create table public.user_ad_ledger (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users(id) on delete restrict,
  provider_id           text not null references public.ad_providers(id) on delete restrict,
  external_tx_id        text not null check (length(external_tx_id) between 1 and 128),
  status                public.ad_ledger_status not null,
  reward_amount         numeric(14,4) not null check (reward_amount >= 0),      -- 0 for a rejected postback
  reject_reason         text,
  wallet_transaction_id uuid references public.wallet_transactions(id) on delete restrict,
  created_at            timestamptz not null default now(),
  constraint user_ad_ledger_once_per_network_tx unique (provider_id, external_tx_id),
  constraint user_ad_ledger_shape check (
    (status = 'credited' and reward_amount > 0 and wallet_transaction_id is not null and reject_reason is null)
 or (status = 'rejected' and reward_amount = 0 and wallet_transaction_id is null and reject_reason is not null))
);
create index idx_user_ad_ledger_user_time on public.user_ad_ledger (user_id, created_at) where status = 'credited';

create trigger trg_user_ad_ledger_no_update before update on public.user_ad_ledger
  for each row execute function public.forbid_mutation();
create trigger trg_user_ad_ledger_no_delete before delete on public.user_ad_ledger
  for each row execute function public.forbid_mutation();
create trigger trg_user_ad_ledger_no_truncate before truncate on public.user_ad_ledger
  for each statement execute function public.forbid_mutation();

alter table public.ad_providers enable row level security;
alter table public.user_ad_ledger enable row level security;
revoke all on table public.ad_providers, public.user_ad_ledger from anon, authenticated;

-- -----------------------------------------------------------------------------
-- The reward
-- -----------------------------------------------------------------------------
-- Returns {status, reward}: credited | duplicate (already processed, nothing paid again) | rejected (nothing paid, answer the
-- network 200 so it stops retrying; the rejection is remembered, so a retry gets the same answer).
-- Rolling window: the sum of this user's CREDITED rewards with created_at > now() - 24 h, computed while the user's wallet row
-- is locked FOR UPDATE, so concurrent postbacks for one user are strictly serial: none can read a sum that misses another's insert.
create function public.process_ad_reward(p_user_id uuid, p_provider_id text, p_external_tx_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx       text := btrim(coalesce(p_external_tx_id, ''));
  v_provider ad_providers%rowtype;
  v_existing user_ad_ledger%rowtype;
  v_max      numeric(14,4);
  v_total    numeric(14,4);
  v_provider_total numeric(14,4);
  v_wtx      wallet_transactions%rowtype;
  v_reason   text;
begin
  if length(v_tx) not between 1 and 128 then
    raise exception 'invalid_parameter_value: the transaction id must be 1 to 128 characters' using errcode = 'invalid_parameter_value';
  end if;

  -- Serialise this user's rewards (and every other movement of their wallet).
  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  select * into v_provider from ad_providers where id = p_provider_id;
  if not found then
    raise exception 'ad_provider_not_found: unknown ad network' using errcode = 'no_data_found';
  end if;

  -- Idempotency: the network retries; the same transaction is answered, never paid twice.
  select * into v_existing from user_ad_ledger where provider_id = p_provider_id and external_tx_id = v_tx;
  if found then
    if v_existing.user_id <> p_user_id then
      raise exception 'ad_tx_conflict: this transaction id belongs to another user' using errcode = 'unique_violation';
    end if;
    return jsonb_build_object('status', 'duplicate', 'was', v_existing.status, 'reward', v_existing.reward_amount);
  end if;

  if not v_provider.is_active then
    v_reason := 'provider_inactive';
  elsif exists (select 1 from users where id = p_user_id and is_banned) then
    v_reason := 'user_banned';
  else
    select max_daily_ad_earnings into v_max from platform_settings where id = 1;
    select coalesce(sum(reward_amount), 0), coalesce(sum(reward_amount) filter (where provider_id = p_provider_id), 0)
      into v_total, v_provider_total
      from user_ad_ledger
     where user_id = p_user_id and status = 'credited' and created_at > now() - interval '24 hours';
    if v_total + v_provider.reward_amount > v_max then
      v_reason := 'daily_limit_reached';
    elsif v_provider_total + v_provider.reward_amount > v_provider.daily_limit_per_user then
      v_reason := 'provider_daily_limit_reached';
    end if;
  end if;

  if v_reason is not null then
    insert into user_ad_ledger (user_id, provider_id, external_tx_id, status, reward_amount, reject_reason)
    values (p_user_id, p_provider_id, v_tx, 'rejected', 0, v_reason);
    return jsonb_build_object('status', 'rejected', 'reason', v_reason, 'reward', 0);
  end if;

  v_wtx := process_wallet_transaction(p_user_id, 'ad_reward', v_provider.reward_amount, null,
                                      'Ad reward (' || v_provider.name || ')', 'ad:' || p_provider_id || ':' || v_tx);
  insert into user_ad_ledger (user_id, provider_id, external_tx_id, status, reward_amount, wallet_transaction_id)
  values (p_user_id, p_provider_id, v_tx, 'credited', v_provider.reward_amount, v_wtx.id);
  return jsonb_build_object('status', 'credited', 'reward', v_provider.reward_amount, 'wallet_balance', v_wtx.balance_after);
end;
$$;

-- Admin switch for one network: payout, per-user cap and on/off. Audited.
create function public.admin_set_ad_provider(
  p_actor uuid, p_provider_id text, p_reward numeric default null, p_daily_limit numeric default null, p_is_active boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row ad_providers%rowtype;
begin
  perform assert_catalog_admin(p_actor);
  if p_reward is null and p_daily_limit is null and p_is_active is null then
    raise exception 'invalid_parameter_value: nothing to update' using errcode = 'invalid_parameter_value';
  end if;
  if (p_reward is not null and (p_reward <= 0 or p_reward > 100)) or (p_daily_limit is not null and p_daily_limit < 0) then
    raise exception 'invalid_parameter_value: reward must be in (0, 100], the daily limit not negative' using errcode = 'invalid_parameter_value';
  end if;
  update ad_providers
     set reward_amount = coalesce(round(p_reward, 4), reward_amount),
         daily_limit_per_user = coalesce(round(p_daily_limit, 4), daily_limit_per_user),
         is_active = coalesce(p_is_active, is_active), updated_at = now()
   where id = p_provider_id returning * into v_row;
  if not found then
    raise exception 'ad_provider_not_found: unknown ad network' using errcode = 'no_data_found';
  end if;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'set_ad_provider', p_provider_id, jsonb_build_object('reward', v_row.reward_amount, 'daily_limit', v_row.daily_limit_per_user, 'is_active', v_row.is_active));
  return jsonb_build_object('id', v_row.id, 'reward_amount', v_row.reward_amount, 'daily_limit_per_user', v_row.daily_limit_per_user, 'is_active', v_row.is_active);
end;
$$;

revoke all on function public.process_ad_reward(uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_set_ad_provider(uuid, text, numeric, numeric, boolean) from public, anon, authenticated;
grant execute on function public.process_ad_reward(uuid, text, text) to service_role;
grant execute on function public.admin_set_ad_provider(uuid, text, numeric, numeric, boolean) to service_role;
