-- =============================================================================
-- Phase 7: provider payment reconciliation + admin operations
--
-- 1. Evidence, stamped by the database when a payment moves:
--      confirmed_at                when the payment (last) entered CONFIRMED
--      provider_balance_before(_at) the provider's cached balance when the transfer instruction was created, i.e.
--                                   before any money could have reached the provider (null: never read)
-- 2. The detector. provider_payment_issue(payment) says whether a payment needs a human, and why:
--      Rule A  CONFIRMED for over 30 minutes and still not COMPLETED. The reason states whether the provider balance
--              rose in proportion to the amount (>= 90%, adding back what orders charged to that provider since the
--              snapshot), did not, or cannot be compared.
--      Rule B  BROADCASTED or CONFIRMING for over 4 hours (time since the broadcast was recorded).
--      Always  UNKNOWN / RECONCILIATION_REQUIRED (outcome unknown until an admin decides).
--    sync_reconciliation_cases() now also opens a `provider_payment` case for each of them, refreshes the wording of open
--    ones (balances move) and closes a case by itself once its payment no longer matches any rule. pg_cron runs it every
--    5 minutes. The TypeScript twin is supabase/functions/_shared/reconciliation-detectors.ts (same rules, same text).
-- 3. Fix: mark_provider_payment_unknown() on a CONFIRMED payment failed (CONFIRMED -> UNKNOWN is not a transition);
--    the transfer is final on chain there, so it now goes straight to RECONCILIATION_REQUIRED.
-- 4. A payment case can no longer be closed with "Mark Resolved" while its payment still needs a decision: complete it,
--    mark it failed or record its broadcast (each of those closes the case).
-- 5. Admin read paths: payout config + today's usage in admin_list_providers, list_provider_payments for admin-treasury,
--    payment details in list_reconciliation_cases.
-- 6. Payout wallets are validated (raw 0:<hex> or user-friendly with a valid checksum; a testnet-only address cannot be
--    the payout wallet on mainnet).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Evidence
-- -----------------------------------------------------------------------------
alter table public.provider_payments
  add column confirmed_at               timestamptz,
  add column provider_balance_before    numeric(14,4),
  add column provider_balance_before_at timestamptz;

create function public.stamp_provider_payment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_balance numeric(14,4);
  v_synced  timestamptz;
begin
  if new.status is distinct from old.status then
    if new.status = 'PAYMENT_CREATED' and old.provider_balance_before_at is null then
      select provider_balance, last_balance_sync into v_balance, v_synced from providers where id = new.provider_id;
      new.provider_balance_before := case when v_synced is not null then v_balance end;
      new.provider_balance_before_at := now();
    elsif new.status = 'CONFIRMED' then
      new.confirmed_at := now();
    end if;
  end if;
  return new;
end;
$$;
-- runs after trg_pp_guard (triggers fire in name order), so only valid transitions are stamped
create trigger trg_pp_stamp before update on public.provider_payments
  for each row execute function public.stamp_provider_payment();

-- -----------------------------------------------------------------------------
-- 2. The detector
-- -----------------------------------------------------------------------------
-- Money and time exactly as the TypeScript twin prints them: "$12.30" / "-$1.05" (signed: "+$4.00"), "2026-10-07 12:00 UTC".
create function public.recon_money(p numeric, p_signed boolean default false)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case when round(p, 2) < 0 then '-' when p_signed then '+' else '' end
         || '$' || to_char(abs(round(p, 2)), 'FM999999999990.00')
$$;

create function public.recon_utc(p timestamptz)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC'
$$;

-- Provider cost of the orders placed with a provider after a moment: they lower its balance while a top-up is on its way.
create function public.provider_spent_since(p_provider_id uuid, p_since timestamptz)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(provider_reservation), 0) from orders where provider_id = p_provider_id and created_at > p_since
$$;

-- null = nothing to reconcile; otherwise { rule, verdict (Rule A only), reason }. Read-only; called by the definer
-- functions below (sync_reconciliation_cases, resolve_case_manual).
create function public.provider_payment_issue(pay public.provider_payments, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  prov    providers%rowtype;
  v_at    timestamptz;
  v_head  text;
  v_why   text;
  v_spent numeric;
  v_net   numeric;
begin
  if pay.status in ('UNKNOWN', 'RECONCILIATION_REQUIRED') then
    return jsonb_build_object('rule', 'outcome_unknown', 'reason', left('outcome unknown: ' || coalesce(pay.failure_reason, ''), 500));
  end if;

  -- Rule B: the transfer left (a hash was recorded) but the chain never confirmed it
  if pay.status in ('BROADCASTED', 'CONFIRMING') then
    v_at := coalesce(pay.broadcasted_at, pay.updated_at);
    if v_at >= p_now - interval '4 hours' then
      return null;
    end if;
    return jsonb_build_object('rule', 'stuck_in_limbo', 'reason', format(
      'Stuck in %s for over 4 h: broadcast recorded at %s and never confirmed on chain. Check the transaction in an explorer, then advance the payment or mark it failed.',
      pay.status, recon_utc(v_at)));
  end if;

  -- Rule A: final on chain, but nobody verified that the provider credited it
  if pay.status <> 'CONFIRMED' then
    return null;
  end if;
  v_at := coalesce(pay.confirmed_at, pay.updated_at);
  if v_at >= p_now - interval '30 minutes' then
    return null;
  end if;
  v_head := format('Confirmed on chain at %s but not completed after 30 min', recon_utc(v_at));

  select * into prov from providers where id = pay.provider_id;
  if pay.provider_balance_before is null then
    v_why := 'no balance reading before the transfer';
  elsif prov.currency is distinct from pay.currency then
    v_why := format('provider balance in %s, payment in %s', prov.currency, pay.currency);
  elsif prov.last_balance_sync is null or prov.last_balance_sync <= v_at then
    v_why := 'balance not read since the confirmation';
  end if;
  if v_why is not null then
    return jsonb_build_object('rule', 'confirmed_not_completed', 'verdict', 'unverifiable', 'reason', format(
      '%s. The provider credit cannot be checked automatically (%s): compare the provider panel with the %s paid.',
      v_head, v_why, recon_money(pay.amount)));
  end if;

  v_spent := provider_spent_since(pay.provider_id, pay.provider_balance_before_at);
  v_net := prov.provider_balance - pay.provider_balance_before + v_spent;
  if v_net * 10 >= pay.amount * 9 then  -- at least 90% of the amount arrived
    return jsonb_build_object('rule', 'confirmed_not_completed', 'verdict', 'credited', 'reason', format(
      '%s. The provider balance rose in proportion (%s of the %s paid): verify it and complete the payment.',
      v_head, recon_money(v_net, true), recon_money(pay.amount)));
  end if;
  return jsonb_build_object('rule', 'confirmed_not_completed', 'verdict', 'not_credited', 'reason', format(
    '%s, and the provider balance did not rise in proportion: %s of the %s paid (balance %s -> %s, orders since %s).',
    v_head, recon_money(v_net, true), recon_money(pay.amount), recon_money(pay.provider_balance_before),
    recon_money(prov.provider_balance), recon_money(v_spent)));
end;
$$;

-- Detector run (orders as before + provider payments). Idempotent; pg_cron runs it every 5 minutes.
create or replace function public.sync_reconciliation_cases()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opened    integer;
  v_closed    integer;
  v_p_opened  integer := 0;
  v_p_updated integer := 0;
  v_p_closed  integer;
  pay         provider_payments%rowtype;
  v_reason    text;
begin
  -- orders
  insert into reconciliation_cases (entity_type, entity_id, reason)
  select 'order', o.id::text, left(coalesce(o.error_message, 'Stuck in processing without a confirmation from the provider'), 500)
    from orders o
   where order_needs_reconciliation(o)
  on conflict (entity_type, entity_id) where status = 'open' do nothing;
  get diagnostics v_opened = row_count;

  update reconciliation_cases c
     set status = 'resolved', resolution = 'auto', resolution_note = 'No longer needs attention', resolved_at = now()
   where c.status = 'open' and c.entity_type = 'order'
     and not exists (select 1 from orders o where o.id::text = c.entity_id and order_needs_reconciliation(o));
  get diagnostics v_closed = row_count;

  -- provider payments: open a case, or keep the open one's wording current
  for pay in
    select * from provider_payments
     where status in ('BROADCASTED', 'CONFIRMING', 'CONFIRMED', 'UNKNOWN', 'RECONCILIATION_REQUIRED')
     order by created_at
  loop
    v_reason := left(provider_payment_issue(pay) ->> 'reason', 500);
    continue when v_reason is null;
    update reconciliation_cases set reason = v_reason
     where entity_type = 'provider_payment' and entity_id = pay.id::text and status = 'open' and reason is distinct from v_reason;
    if found then
      v_p_updated := v_p_updated + 1;
      continue;
    end if;
    insert into reconciliation_cases (entity_type, entity_id, reason)
    values ('provider_payment', pay.id::text, v_reason)
    on conflict (entity_type, entity_id) where status = 'open' do nothing;
    if found then
      v_p_opened := v_p_opened + 1;
    end if;
  end loop;

  -- ...and close it once the payment no longer matches any rule (cases for unknown entity ids are left alone)
  update reconciliation_cases c
     set status = 'resolved', resolution = 'auto', resolution_note = 'No longer needs attention (payment ' || p.status || ')', resolved_at = now()
    from provider_payments p
   where c.status = 'open' and c.entity_type = 'provider_payment' and c.entity_id = p.id::text
     and provider_payment_issue(p) is null;
  get diagnostics v_p_closed = row_count;

  return jsonb_build_object(
    'opened', v_opened + v_p_opened, 'closed', v_closed + v_p_closed,
    'payments', jsonb_build_object('opened', v_p_opened, 'updated', v_p_updated, 'closed', v_p_closed));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. CONFIRMED -> reconciliation
-- -----------------------------------------------------------------------------
create or replace function public.mark_provider_payment_unknown(p_payment_id uuid, p_reason text, p_actor uuid default null)
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
  if pay.status = 'CONFIRMED' then
    -- final on chain: only the provider credit is in doubt, there is no UNKNOWN step
    update provider_payments set status = 'RECONCILIATION_REQUIRED', failure_reason = left(p_reason, 500) where id = pay.id;
  else
    update provider_payments set status = 'UNKNOWN', failure_reason = left(p_reason, 500) where id = pay.id;
    update provider_payments set status = 'RECONCILIATION_REQUIRED' where id = pay.id;
  end if;
  insert into reconciliation_cases (entity_type, entity_id, reason)
  values ('provider_payment', pay.id::text, left('outcome unknown: ' || coalesce(p_reason, ''), 500))
  on conflict (entity_type, entity_id) where status = 'open' do update set reason = excluded.reason;
  return jsonb_build_object('payment_id', pay.id, 'status', 'RECONCILIATION_REQUIRED');
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. MARK_RESOLVED: a payment that still needs a decision keeps its case
-- -----------------------------------------------------------------------------
create or replace function public.resolve_case_manual(p_case_id uuid, p_actor uuid, p_note text default null, p_provider_order_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c   reconciliation_cases%rowtype;
  o   orders%rowtype;
  pay provider_payments%rowtype;
  v_note text := nullif(trim(p_note), '');
begin
  perform assert_recon_actor(p_actor);

  select * into c from reconciliation_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if c.status = 'resolved' then
    return jsonb_build_object('case_id', c.id, 'status', 'resolved', 'resolution', c.resolution, 'already_resolved', true);
  end if;

  if c.entity_type = 'order' then
    select * into o from orders where id = c.entity_id::uuid for update;
    if found and order_needs_reconciliation(o) then
      if o.error_message like 'needs\_reconciliation: retry in progress%' and o.updated_at > now() - interval '5 minutes' then
        raise exception 'retry_in_progress: wait for the retry to finish' using errcode = 'check_violation';
      end if;
      if o.status = 'processing' then
        if p_provider_order_id is null or length(trim(p_provider_order_id)) = 0 then
          raise exception 'the provider order id is required to resolve a processing order' using errcode = 'invalid_parameter_value';
        end if;
        perform set_config('app.status_comment', 'Resolved by admin' || coalesce(': ' || v_note, ''), true);
        update orders set provider_order_id = trim(p_provider_order_id), status = 'submitted', error_message = null where id = o.id;
      else
        if v_note is null then
          raise exception 'a note is required to resolve this order without a refund' using errcode = 'invalid_parameter_value';
        end if;
        update orders set error_message = null where id = o.id;
      end if;
    end if;
  elsif v_note is null then
    raise exception 'a note is required' using errcode = 'invalid_parameter_value';
  elsif c.entity_type = 'provider_payment' then
    select * into pay from provider_payments where id::text = c.entity_id;
    if found and provider_payment_issue(pay) is not null then
      raise exception 'payment_unresolved: the payment is % and still needs a decision', pay.status using errcode = 'check_violation';
    end if;
  end if;

  update reconciliation_cases
     set status = 'resolved', resolution = 'manual', resolution_note = v_note, resolved_by = p_actor, resolved_at = now()
   where id = c.id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'reconcile_manual', c.id::text, jsonb_build_object('entity', c.entity_type, 'entity_id', c.entity_id, 'note', v_note, 'provider_order_id', p_provider_order_id));
  return jsonb_build_object('case_id', c.id, 'status', 'resolved', 'resolution', 'manual');
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Read paths
-- -----------------------------------------------------------------------------
-- Open cases; provider payment cases now carry the payment.
create or replace function public.list_reconciliation_cases()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'entity_type', c.entity_type, 'entity_id', c.entity_id, 'reason', c.reason, 'created_at', c.created_at,
    'order', case when o.id is null then null else jsonb_build_object(
      'status', o.status, 'charge_amount', o.charge_amount, 'quantity', o.quantity, 'target_url', o.target_url,
      'provider_order_id', o.provider_order_id, 'error_message', o.error_message, 'created_at', o.created_at,
      'has_routing_snapshot', o.provider_offer_id is not null,
      'service_name', s.name, 'username', u.username, 'telegram_id', u.telegram_id, 'user_id', u.id) end,
    'payment', case when pp.id is null then null else jsonb_build_object(
      'status', pp.status, 'provider_name', pv.name, 'amount', pp.amount, 'currency', pp.currency, 'asset', pp.asset,
      'network', pp.network, 'destination_wallet', pp.destination_wallet, 'tx_hash', pp.tx_hash,
      'broadcasted_at', pp.broadcasted_at, 'confirmed_at', pp.confirmed_at, 'created_at', pp.created_at) end
  ) order by c.created_at), '[]'::jsonb)
  from reconciliation_cases c
  left join orders o on c.entity_type = 'order' and o.id::text = c.entity_id
  left join users u on u.id = o.user_id
  left join services s on s.id = o.service_id
  left join provider_payments pp on c.entity_type = 'provider_payment' and pp.id::text = c.entity_id
  left join providers pv on pv.id = pp.provider_id
  where c.status = 'open'
$$;

-- Payments for Admin -> Treasury: every one still in progress plus the latest p_limit, with the detector's evidence.
create function public.list_provider_payments(p_limit integer default 20)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', pp.id, 'provider_id', pp.provider_id, 'provider_name', pv.name, 'proposal_id', pp.proposal_id,
    'amount', pp.amount, 'currency', pp.currency, 'asset', pp.asset, 'network', pp.network,
    'destination_wallet', pp.destination_wallet, 'tx_hash', pp.tx_hash, 'status', pp.status,
    'failure_reason', pp.failure_reason, 'treasury_reversed', pp.treasury_reversed,
    'validated_at', pp.validated_at, 'broadcasted_at', pp.broadcasted_at, 'confirmed_at', pp.confirmed_at,
    'completed_at', pp.completed_at, 'created_at', pp.created_at, 'updated_at', pp.updated_at,
    'provider_balance_before', pp.provider_balance_before, 'provider_balance_before_at', pp.provider_balance_before_at,
    'provider_balance', pv.provider_balance, 'provider_currency', pv.currency, 'provider_balance_synced_at', pv.last_balance_sync,
    'spent_since', provider_spent_since(pp.provider_id, pp.provider_balance_before_at),
    'open_case_id', (select c.id from reconciliation_cases c where c.entity_type = 'provider_payment' and c.entity_id = pp.id::text and c.status = 'open')
  ) order by pp.created_at desc), '[]'::jsonb)
  from provider_payments pp
  join providers pv on pv.id = pp.provider_id
  where pp.status not in ('COMPLETED', 'FAILED', 'CANCELED')
     or pp.id in (select id from provider_payments order by created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 100))
$$;

-- Admin -> Providers gains the payout configuration and what was committed today (same window as the daily limit).
create or replace function public.admin_list_providers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'is_active', p.is_active, 'routing_enabled', p.routing_enabled,
      'health_status', p.health_status, 'last_health_check', p.last_health_check,
      'provider_balance', p.provider_balance, 'currency', p.currency, 'last_balance_sync', p.last_balance_sync,
      'low_balance_threshold', p.low_balance_threshold, 'target_topup_balance', p.target_topup_balance,
      'balance_alert_sent', p.balance_alert_sent, 'reliability_penalty_multiplier', p.reliability_penalty_multiplier,
      'allowed_destination_wallet', p.allowed_destination_wallet, 'payout_network', p.payout_network, 'payout_asset', p.payout_asset,
      'max_topup_per_tx', p.max_topup_per_tx, 'max_daily_topup', p.max_daily_topup,
      'topup_used_today', (select coalesce(sum(pp.amount), 0) from provider_payments pp
                            where pp.provider_id = p.id and pp.treasury_debited and not pp.treasury_reversed
                              and pp.validated_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc'))
    ) order by p.priority desc, p.name)
    from providers p), '[]'::jsonb);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Payout wallet validation
-- -----------------------------------------------------------------------------
-- {"format": "raw"} | {"format": "friendly", "test_only": bool} for a valid TON address, null otherwise.
-- User-friendly = base64(url) of 36 bytes: tag (0x11 / 0x51, +0x80 testnet-only), workchain, 32-byte hash, CRC16-XMODEM.
create function public.ton_address_info(p_address text)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t   text := trim(coalesce(p_address, ''));
  b   bytea;
  crc integer := 0;
  i   integer;
  j   integer;
begin
  if t ~ '^-?[0-9]+:[0-9a-fA-F]{64}$' then
    return jsonb_build_object('format', 'raw');
  end if;
  if t !~ '^[A-Za-z0-9_+/-]{48}$' then
    return null;
  end if;
  b := decode(translate(t, '-_', '+/'), 'base64');
  if length(b) <> 36 or (get_byte(b, 0) & 127) not in (17, 81) then
    return null;
  end if;
  for i in 0..33 loop
    crc := crc # (get_byte(b, i) << 8);
    for j in 1..8 loop
      crc := case when crc & 32768 <> 0 then ((crc << 1) # 4129) & 65535 else (crc << 1) & 65535 end;
    end loop;
  end loop;
  if crc <> ((get_byte(b, 34) << 8) | get_byte(b, 35)) then
    return null;
  end if;
  return jsonb_build_object('format', 'friendly', 'test_only', (get_byte(b, 0) & 128) <> 0);
end;
$$;

create or replace function public.admin_set_provider_payout(
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
  v_admin  uuid := require_admin();
  v_wallet text := nullif(trim(p_wallet), '');
  v_addr   jsonb;
  old_p    providers%rowtype;
begin
  if p_network is null or p_network not in ('mainnet', 'testnet') then
    raise exception 'invalid_payout_config: the network must be mainnet or testnet' using errcode = 'invalid_parameter_value';
  end if;
  if p_asset is null or p_asset not in ('TON', 'USDT') then
    raise exception 'invalid_payout_config: the asset must be TON or USDT' using errcode = 'invalid_parameter_value';
  end if;
  if v_wallet is not null then
    v_addr := ton_address_info(v_wallet);
    if v_addr is null then
      raise exception 'invalid_payout_config: the wallet is not a valid TON address (check it was copied completely)' using errcode = 'invalid_parameter_value';
    end if;
    if p_network = 'mainnet' and coalesce((v_addr ->> 'test_only')::boolean, false) then
      raise exception 'invalid_payout_config: this is a testnet-only address but the network is mainnet' using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if (p_max_topup_per_tx is not null and (p_max_topup_per_tx <= 0 or p_max_topup_per_tx >= 1000000000))
     or (p_max_daily_topup is not null and (p_max_daily_topup <= 0 or p_max_daily_topup >= 1000000000)) then
    raise exception 'invalid_payout_config: limits must be greater than 0 and below 1000000000' using errcode = 'invalid_parameter_value';
  end if;
  if p_max_topup_per_tx is not null and p_max_daily_topup is not null and p_max_daily_topup < p_max_topup_per_tx then
    raise exception 'invalid_payout_config: the daily limit cannot be below the per-transaction limit' using errcode = 'invalid_parameter_value';
  end if;

  select * into old_p from providers where id = p_provider_id for update;
  if not found then raise exception 'provider % not found', p_provider_id using errcode = 'no_data_found'; end if;
  update providers
     set allowed_destination_wallet = v_wallet, payout_network = p_network, payout_asset = p_asset,
         max_topup_per_tx = p_max_topup_per_tx, max_daily_topup = p_max_daily_topup
   where id = p_provider_id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'set_provider_payout', p_provider_id::text, jsonb_build_object(
    'wallet', jsonb_build_array(old_p.allowed_destination_wallet, v_wallet),
    'network', jsonb_build_array(old_p.payout_network, p_network), 'asset', jsonb_build_array(old_p.payout_asset, p_asset),
    'max_topup_per_tx', jsonb_build_array(old_p.max_topup_per_tx, p_max_topup_per_tx),
    'max_daily_topup', jsonb_build_array(old_p.max_daily_topup, p_max_daily_topup)));
  return jsonb_build_object('id', p_provider_id, 'allowed_destination_wallet', v_wallet, 'payout_network', p_network,
                            'payout_asset', p_asset, 'max_topup_per_tx', p_max_topup_per_tx, 'max_daily_topup', p_max_daily_topup);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access (new functions; replaced ones keep their grants)
-- -----------------------------------------------------------------------------
revoke all on function
  public.stamp_provider_payment(), public.recon_money(numeric, boolean), public.recon_utc(timestamptz),
  public.provider_spent_since(uuid, timestamptz), public.provider_payment_issue(public.provider_payments, timestamptz),
  public.list_provider_payments(integer), public.ton_address_info(text)
  from public, anon, authenticated;
grant execute on function public.list_provider_payments(integer) to service_role;

-- -----------------------------------------------------------------------------
-- Schedule the detector (production has pg_cron; local test databases do not)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.schedule('sync-reconciliation-cases', '*/5 * * * *', 'select public.sync_reconciliation_cases()');
    exception when others then
      raise warning 'sync-reconciliation-cases was not scheduled: %', sqlerrm;
    end;
  end if;
end;
$$;
