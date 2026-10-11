-- Forensic verification follow-up (stages V1-V5). tests/forensic-audit-hardening.test.ts reproduces every item.
--
--   #1  one TON transaction could be stored twice: as base64 (Toncenter) and as hex (an explorer) - UNIQUE(tx_hash) saw two values
--   #2  service_role kept INSERT / DELETE / TRUNCATE on wallets, and could UPDATE treasury_state without a ledger row
--   #3  a user whose wallet row vanished was not counted as ledger drift
--   #7  a referral clawback after the payout left an untracked negative balance
--   #9  a suspended account could still write analytics and read quotes, its referral summary and its tickets
-- (#4 finality, #5 key rotation, #6 DNS, #8 postback time are in the Edge Functions; #10 in scripts/concurrency-test.ts.)

-- ===== #1 canonical transaction hash ===========================================================================================
create function public.normalize_ton_tx_hash(p_hash text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := btrim(coalesce(p_hash, ''));
  b bytea;
begin
  if v ~* '^(0x)?[0-9a-f]{64}$' then
    b := decode(regexp_replace(v, '^0[xX]', ''), 'hex');
  elsif v ~ '^[A-Za-z0-9+/_-]{43}=?$' then
    v := translate(v, '-_', '+/');
    if length(v) = 43 then v := v || '='; end if;
    b := decode(v, 'base64');
  else
    raise exception 'invalid_tx_hash: the tx hash must be a 32-byte TON transaction hash (64 hex or 44 base64 characters)'
      using errcode = 'invalid_parameter_value';
  end if;
  if length(b) <> 32 then
    raise exception 'invalid_tx_hash: the tx hash must decode to exactly 32 bytes' using errcode = 'invalid_parameter_value';
  end if;
  return encode(b, 'base64');   -- 44 characters, the form Toncenter v3 returns (supabase/functions/_shared/ton.ts canonicalTxHash)
end;
$$;

revoke all on function public.normalize_ton_tx_hash(text) from public, anon, authenticated;
grant execute on function public.normalize_ton_tx_hash(text) to service_role;

-- Every stored hash is canonical, so UNIQUE(tx_hash) compares transactions, not spellings. Production has no completed deposit yet;
-- the check is validated when the existing rows allow it (and enforced for every write from now on in any case).
alter table public.deposits
  add constraint deposits_tx_hash_canonical check (tx_hash is null or tx_hash = public.normalize_ton_tx_hash(tx_hash)) not valid;
do $$
begin
  alter table public.deposits validate constraint deposits_tx_hash_canonical;
exception when others then
  raise notice 'deposits_tx_hash_canonical stays NOT VALID: %', sqlerrm;
end;
$$;

-- (latest definition taken from 20261118000000_security_audit_remediation.sql)
create or replace function public.complete_deposit(
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
  v_required numeric;
  v_hash text := public.normalize_ton_tx_hash(p_tx_hash);   -- one transaction, one form: hex and base64 of the same hash are equal
begin

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

  v_required := round(d.amount_crypto * 1000000000);
  if p_received_nano is not null and p_received_nano < v_required then
    raise exception 'underpaid: received % nanoton, required %', p_received_nano, v_required
      using errcode = 'check_violation';
  end if;

  -- Explicit check for a friendly error; the UNIQUE constraint on tx_hash is the real guarantee.
  if exists (select 1 from deposits where tx_hash = v_hash and id <> d.id) then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end if;

  -- Two DIFFERENT deposits racing for the same hash both pass the check above (neither sees the other's uncommitted
  -- claim); the UNIQUE index then makes the second one wait and fail. Report that as the same business error.
  begin
    update deposits
       set status = 'completed', tx_hash = v_hash, sender_address = p_sender_address, completed_at = now(),
           received_amount_nano = case when p_received_nano is null then null else round(p_received_nano)::bigint end
     where id = d.id
    returning * into d;
  exception when unique_violation then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end;

  perform process_wallet_transaction(
    d.user_id, 'deposit', d.amount_usd, d.id,
    'Deposit via Tonkeeper (' || d.asset || ')', 'deposit:' || d.id);

  -- Only the quoted amount is credited. What came on top stays on our wallet, so it is written down and put in front of an admin
  -- (to be returned or kept by decision), instead of disappearing silently.
  if p_received_nano is not null and p_received_nano > v_required then
    insert into reconciliation_cases (entity_type, entity_id, reason)
    values ('deposit', d.id::text, left(format('overpaid: received %s nanoton, quoted %s (credited %s USD only)', round(p_received_nano), v_required, d.amount_usd), 500))
    on conflict (entity_type, entity_id) where status = 'open'
    do update set reason = excluded.reason;
  end if;

  return d;
end;
$$;

-- (latest definition taken from 20261118000000_security_audit_remediation.sql)
create or replace function public.admin_resolve_deposit(
  p_deposit_id    uuid,
  p_action        text,
  p_tx_hash       text    default null,
  p_received_nano numeric default null,
  p_note          text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin    uuid := require_admin();
  d          public.deposits%rowtype;
  v_note     text := nullif(btrim(p_note), '');
  v_hash     text;
  v_required numeric;
  v_credit   numeric(14,4);
begin
  if p_action not in ('credit', 'dismiss') then
    raise exception 'invalid_parameter_value: action must be credit or dismiss' using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposits where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id using errcode = 'no_data_found';
  end if;

  if p_action = 'dismiss' then
    if v_note is null then
      raise exception 'invalid_parameter_value: a note is required to dismiss a deposit case' using errcode = 'invalid_parameter_value';
    end if;
    update reconciliation_cases
       set status = 'resolved', resolution = 'manual', resolution_note = left(v_note, 500), resolved_by = v_admin, resolved_at = now()
     where entity_type = 'deposit' and entity_id = d.id::text and status = 'open';
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (v_admin, 'resolve_deposit', d.id::text, jsonb_build_object('action', 'dismiss', 'note', v_note));
    return jsonb_build_object('deposit_id', d.id, 'status', d.status, 'credited', 0, 'action', 'dismiss');
  end if;

  -- credit
  v_hash := public.normalize_ton_tx_hash(p_tx_hash);   -- an explorer's hex and Toncenter's base64 are the same transaction
  if d.status = 'completed' then
    if d.tx_hash = v_hash then
      return jsonb_build_object('deposit_id', d.id, 'status', 'completed', 'credited', 0, 'action', 'credit', 'replayed', true);
    end if;
    raise exception 'deposit_already_completed: this deposit was credited with another transaction' using errcode = 'check_violation';
  end if;
  if d.status = 'failed' then
    raise exception 'deposit % has failed and cannot be credited', d.id using errcode = 'check_violation';
  end if;
  if exists (select 1 from deposits where tx_hash = v_hash and id <> d.id) then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end if;
  if p_received_nano is null or p_received_nano <= 0 then
    raise exception 'invalid_parameter_value: the received amount (nanoton) is required' using errcode = 'invalid_parameter_value';
  end if;

  v_required := round(d.amount_crypto * 1000000000);
  v_credit := round(d.amount_usd * least(p_received_nano / v_required, 1), 4);
  if v_credit <= 0 then
    raise exception 'invalid_parameter_value: nothing to credit' using errcode = 'invalid_parameter_value';
  end if;

  begin
    update deposits
       set status = 'completed', tx_hash = v_hash, received_amount_nano = round(p_received_nano)::bigint, completed_at = now()
     where id = d.id
    returning * into d;
  exception when unique_violation then
    raise exception 'tx_already_used: transaction already credited to another deposit' using errcode = 'unique_violation';
  end;

  perform process_wallet_transaction(
    d.user_id, 'deposit', v_credit, d.id,
    'Deposit resolved by an administrator', 'deposit:' || d.id);

  update reconciliation_cases
     set status = 'resolved', resolution = 'manual', resolution_note = left(coalesce(v_note, 'credited by an administrator'), 500),
         resolved_by = v_admin, resolved_at = now()
   where entity_type = 'deposit' and entity_id = d.id::text and status = 'open';

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'resolve_deposit', d.id::text,
          jsonb_build_object('action', 'credit', 'tx_hash', v_hash, 'received_nano', round(p_received_nano), 'credited_usd', v_credit, 'note', v_note));

  return jsonb_build_object('deposit_id', d.id, 'status', 'completed', 'credited', v_credit, 'action', 'credit');
end;
$$;

-- ===== #2 wallets and treasury_state: only their ledger functions write them =====================================================
-- Wallets are created by the SECURITY DEFINER trigger on users (create_wallet_for_new_user) and changed only by
-- process_wallet_transaction / settle_wallet_transaction; the treasury only by process_treasury_transaction. The API role needs none
-- of these privileges (on Supabase it also bypasses RLS, so a DELETE would really delete).
revoke insert, update, delete, truncate on public.wallets from service_role, anon, authenticated;
revoke insert, update, delete, truncate on public.treasury_state from service_role, anon, authenticated;

create function public.guard_treasury_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.balance <> 0 then
      raise exception 'the treasury must be created with a zero balance' using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if new.balance is distinct from old.balance and coalesce(current_setting('app.treasury_op', true), 'off') <> 'on' then
    raise exception 'treasury balance can only be changed via process_treasury_transaction()' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger trg_treasury_state_guard
  before insert or update on public.treasury_state
  for each row execute function public.guard_treasury_state();

revoke all on function public.guard_treasury_state() from public, anon, authenticated;

-- (latest definition taken from 20261024000100_effective_routing_and_pnl.sql)
create or replace function public.process_treasury_transaction(
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
     or (p_type in ('withdrawal', 'provider_topup', 'fee', 'network_fee') and v_amount > 0) then
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

  perform set_config('app.treasury_op', 'on', true);
  update treasury_state set balance = v_new, updated_at = now() where id = 1;
  perform set_config('app.treasury_op', 'off', true);

  if p_actor is not null then
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'treasury_' || p_type::text, v_tx.id::text,
            jsonb_build_object('amount', v_amount, 'balance_after', v_new, 'description', p_description));
  end if;
  return v_tx;
end;
$$;

-- ===== #3 a user without a wallet is drift too ====================================================================================
create or replace function public.ledger_drift_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select count(*)::integer
            from wallets w
           where w.balance <> coalesce((select sum(t.amount) from wallet_transactions t where t.wallet_id = w.id and t.status = 'completed'), 0))
       + (select count(*)::integer from users u where not exists (select 1 from wallets w where w.user_id = u.id))
$$;

-- ===== #7 a clawback after the payout is an explicit, self-repaying debt ===========================================================
-- (latest definition taken from 20261104000000_referral_engine.sql)
create or replace function public.referral_balance(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'total',     coalesce(sum(l.amount), 0),
    -- a clawback after the money was already paid out: owed back, repaid first from the next rewards (nothing is payable meanwhile)
    'debt',      greatest(-coalesce(sum(l.amount), 0), 0),
    -- rewards still inside the hold period that have not been clawed back
    'pending',   coalesce(sum(l.amount) filter (where l.transaction_type = 'reward' and l.available_at > now()
                                                 and not exists (select 1 from referral_ledger c where c.reverses_id = l.id)), 0),
    'available', greatest(coalesce(sum(l.amount), 0)
                          - coalesce(sum(l.amount) filter (where l.transaction_type = 'reward' and l.available_at > now()
                                                            and not exists (select 1 from referral_ledger c where c.reverses_id = l.id)), 0), 0))
  from referral_ledger l
 where l.user_id = p_user_id
$$;

-- ===== #9 a suspended account gets nothing from the remaining endpoints =============================================================
-- (users_select_own stays readable on purpose: the app reads the user's own row to show the "account suspended" screen.)
-- (latest definition taken from 20261108000000_analytics.sql)
create or replace function public.record_client_events(p_user_id uuid, p_events jsonb, p_limit integer default 120)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used  integer;
  v_room  integer;
  v_added integer := 0;
  e       jsonb;
begin
  if p_user_id is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;
  if exists (select 1 from users where id = p_user_id and is_banned) then
    return 0;   -- a suspended account writes nothing, silently (the call is fire-and-forget)
  end if;
  select count(*) into v_used from analytics_events
   where user_id = p_user_id and source = 'client' and created_at > now() - interval '1 minute';
  v_room := greatest(p_limit - v_used, 0);

  for e in select * from jsonb_array_elements(p_events) loop
    exit when v_room <= 0 or v_added >= 50;
    continue when jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'name') <> 'string'
               or (e->>'name') !~ '^[a-z][a-z0-9_]{1,40}$'
               or (e->>'name') in ('user_registered', 'first_deposit', 'order_placed', 'order_refunded', 'promo_applied')
               or jsonb_typeof(coalesce(e->'properties', '{}'::jsonb)) <> 'object';
    begin
      insert into analytics_events (user_id, event_name, source, properties)
      values (p_user_id, e->>'name', 'client', coalesce(e->'properties', '{}'::jsonb));
      v_added := v_added + 1;
      v_room := v_room - 1;
    exception when others then
      raise warning 'analytics: client event skipped: %', sqlerrm;
    end;
  end loop;
  return v_added;
end;
$$;

-- (latest definition taken from 20261118000000_security_audit_remediation.sql)
create or replace function public.quote_order_price(p_user_id uuid, p_service_id uuid, p_quantity integer, p_promo_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost numeric(14,4);
begin
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  -- The order is routed to the best ELIGIBLE offer (health, balance and score are decided by the Edge Function). The quote assumes the
  -- most expensive offer that can take the order and still be sold at the list price: the customer is never shown less than they pay.
  select max(o.cost_per_1000) into v_cost
    from provider_service_offers o
    join providers p on p.id = o.provider_id
    join provider_services ps on ps.id = o.provider_service_id
    join services s on s.id = o.service_id
   where o.service_id = p_service_id and o.is_active and ps.is_active and p.is_active and p.routing_enabled
     and p_quantity between o.min_quantity and o.max_quantity
     and o.cost_per_1000 <= s.customer_rate_per_1000;
  if v_cost is null then
    raise exception 'service_unavailable: no provider can take this order' using errcode = 'no_data_found';
  end if;
  return calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_cost * p_quantity / 1000, 4), p_promo_code);
end;
$$;

-- (latest definition taken from 20261104000000_referral_engine.sql)
create or replace function public.referral_summary(p_user_id uuid, p_recent integer default 20)
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
  if u.is_banned then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
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

-- (latest definition taken from 20261110000000_ticketing.sql)
create or replace function public.support_get_ticket(p_user_id uuid, p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  t support_tickets%rowtype;
begin
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  select * into t from support_tickets where id = p_ticket_id and user_id = p_user_id;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';   -- someone else's ticket reads exactly like a missing one
  end if;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;

-- (latest definition taken from 20261110000000_ticketing.sql, now plpgsql so it can refuse a suspended account)
create or replace function public.support_list_my_tickets(p_user_id uuid, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  return (
  select coalesce(jsonb_agg(support_ticket_json(t) || jsonb_build_object(
             'last_message', (select left(m.message_text, 140) from ticket_messages m where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1),
             'last_from_support', (select m.is_admin from ticket_messages m where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1)
           ) order by t.updated_at desc, t.id), '[]'::jsonb)
      from (select * from support_tickets where user_id = p_user_id order by updated_at desc, id
             limit least(greatest(coalesce(p_limit, 30), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) t
  );
end;
$$;
