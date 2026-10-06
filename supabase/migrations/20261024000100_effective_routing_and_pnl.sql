-- =============================================================================
-- Phase 2: effective provider cost routing + P&L breakdown
--
-- 1. providers.reliability_penalty_multiplier (default 1.0, range 1..10). Routing ranks offers by
--       effective cost = cost_per_1000 * reliability_penalty_multiplier   (ascending)
--    then routing_score (descending), then offer id. The admin pricing grid uses the same order, so "best cost"
--    there is the offer an order would actually go to. Order snapshots are untouched: an order still records the
--    offer's REAL cost (cost_amount), the multiplier only decides which offer wins.
-- 2. Treasury: 'network_fee' entries (debits) accepted by the ledger.
-- 3. get_profit_analytics adds network_fees and refund_cost; net_profit also subtracts network fees.
--    Revenue / cost / gross profit formulas are unchanged, so historical figures do not move.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Reliability penalty
-- -----------------------------------------------------------------------------
alter table public.providers
  add column reliability_penalty_multiplier numeric(6,3) not null default 1.000
    constraint providers_penalty_range check (reliability_penalty_multiplier between 1 and 10);

create or replace function public.get_admin_pricing_view()
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
      'service_id', s.id,
      'name', s.name,
      'category_id', c.id,
      'category', c.name,
      'platform', c.platform,
      'customer_rate_per_1000', s.customer_rate_per_1000,
      'best_offer_cost', b.cost_per_1000,
      'best_offer_effective_cost', b.effective_cost,
      'margin_absolute', case when b.cost_per_1000 is null then null
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end
    ) order by c.platform, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    left join lateral (
      select o.cost_per_1000, round(o.cost_per_1000 * p.reliability_penalty_multiplier, 4) as effective_cost
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active
         and ps.is_active
         and p.is_active and p.routing_enabled and p.health_status = 'healthy'
       order by o.cost_per_1000 * p.reliability_penalty_multiplier asc, o.routing_score desc, o.id asc
       limit 1
    ) b on true
    where s.is_active), '[]'::jsonb);
end;
$$;

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
      'balance_alert_sent', p.balance_alert_sent, 'reliability_penalty_multiplier', p.reliability_penalty_multiplier
    ) order by p.priority desc, p.name)
    from providers p), '[]'::jsonb);
end;
$$;

-- The config RPC gains the penalty (a 5th argument with a default, so existing 4-argument calls keep working).
drop function public.admin_update_provider_config(uuid, numeric, numeric, boolean);
create function public.admin_update_provider_config(
  p_provider_id           uuid,
  p_low_balance_threshold numeric default null,
  p_target_topup_balance  numeric default null,
  p_routing_enabled       boolean default null,
  p_reliability_penalty   numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  old_p   providers%rowtype;
  new_p   providers%rowtype;
begin
  if p_low_balance_threshold is null and p_target_topup_balance is null and p_routing_enabled is null and p_reliability_penalty is null then
    raise exception 'nothing to update' using errcode = 'invalid_parameter_value';
  end if;
  if (p_low_balance_threshold is not null and (p_low_balance_threshold < 0 or p_low_balance_threshold > 1000000000))
     or (p_target_topup_balance is not null and (p_target_topup_balance < 0 or p_target_topup_balance > 1000000000)) then
    raise exception 'balance values must be between 0 and 1000000000' using errcode = 'invalid_parameter_value';
  end if;
  if p_reliability_penalty is not null and (p_reliability_penalty < 1 or p_reliability_penalty > 10) then
    raise exception 'reliability penalty must be between 1 and 10' using errcode = 'invalid_parameter_value';
  end if;

  select * into old_p from providers where id = p_provider_id for update;
  if not found then
    raise exception 'provider % not found', p_provider_id using errcode = 'no_data_found';
  end if;

  if coalesce(round(p_target_topup_balance, 4), old_p.target_topup_balance)
       < coalesce(round(p_low_balance_threshold, 4), old_p.low_balance_threshold) then
    raise exception 'top-up target must not be below the low-balance threshold' using errcode = 'invalid_parameter_value';
  end if;
  if p_routing_enabled is true and not old_p.is_active then
    raise exception 'an inactive provider cannot receive orders' using errcode = 'invalid_parameter_value';
  end if;

  update providers
     set low_balance_threshold          = coalesce(round(p_low_balance_threshold, 4), low_balance_threshold),
         target_topup_balance           = coalesce(round(p_target_topup_balance, 4), target_topup_balance),
         routing_enabled                = coalesce(p_routing_enabled, routing_enabled),
         reliability_penalty_multiplier = coalesce(round(p_reliability_penalty, 3), reliability_penalty_multiplier)
   where id = p_provider_id returning * into new_p;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'update_provider_config', p_provider_id::text, jsonb_build_object(
    'low_balance_threshold', jsonb_build_array(old_p.low_balance_threshold, new_p.low_balance_threshold),
    'target_topup_balance',  jsonb_build_array(old_p.target_topup_balance, new_p.target_topup_balance),
    'routing_enabled',       jsonb_build_array(old_p.routing_enabled, new_p.routing_enabled),
    'reliability_penalty_multiplier', jsonb_build_array(old_p.reliability_penalty_multiplier, new_p.reliability_penalty_multiplier)));

  return jsonb_build_object('id', new_p.id, 'low_balance_threshold', new_p.low_balance_threshold,
                            'target_topup_balance', new_p.target_topup_balance, 'routing_enabled', new_p.routing_enabled,
                            'reliability_penalty_multiplier', new_p.reliability_penalty_multiplier);
end;
$$;
revoke all on function public.admin_update_provider_config(uuid, numeric, numeric, boolean, numeric) from public, anon;
grant execute on function public.admin_update_provider_config(uuid, numeric, numeric, boolean, numeric) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Treasury accepts network fees (debits, like fees)
-- -----------------------------------------------------------------------------
alter table public.treasury_transactions drop constraint treasury_tx_sign;
alter table public.treasury_transactions add constraint treasury_tx_sign check (
  (type = 'deposit' and amount > 0)
  or (type in ('withdrawal', 'provider_topup', 'fee', 'network_fee') and amount < 0)
  or type = 'manual_adjustment');

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
-- 3. P&L: network fees and refund volume
-- -----------------------------------------------------------------------------
create or replace function public.get_profit_analytics(
  p_start_date timestamptz default null,
  p_end_date   timestamptz default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_orders   bigint;
  v_done     bigint;
  v_partial  bigint;
  v_revenue  numeric(14,4);
  v_cost     numeric(14,4);
  v_snapshot numeric(14,4);
  v_fees     numeric(14,4);
  v_network  numeric(14,4);
  v_refunds  numeric(14,4);
begin
  perform require_admin();
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'end date must be after start date' using errcode = 'invalid_parameter_value';
  end if;

  -- unchanged: realised revenue and provider cost of the orders placed in the period
  select
    count(*),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'partial'),
    coalesce(sum(case status when 'completed' then charge_amount
                             when 'partial'   then charge_amount - partial_refund_amount end), 0),
    coalesce(sum(case status when 'completed' then cost_amount
                             when 'partial'   then round(cost_amount * (quantity - coalesce(remains, 0)) / quantity, 4) end), 0),
    coalesce(sum(profit_amount) filter (where status = 'completed'), 0)
  into v_orders, v_done, v_partial, v_revenue, v_cost, v_snapshot
  from orders
  where status <> 'draft'
    and (p_start_date is null or created_at >= p_start_date)
    and (p_end_date   is null or created_at <  p_end_date);

  select coalesce(abs(sum(amount) filter (where type = 'fee')), 0),
         coalesce(abs(sum(amount) filter (where type = 'network_fee')), 0)
    into v_fees, v_network
  from treasury_transactions
  where type in ('fee', 'network_fee')
    and (p_start_date is null or created_at >= p_start_date)
    and (p_end_date   is null or created_at <  p_end_date);

  -- money returned to customers (full and partial refunds) for the orders placed in the period, from the wallet ledger
  select coalesce(sum(wt.amount), 0) into v_refunds
  from wallet_transactions wt
  join orders o on o.id = wt.reference_id
  where wt.type = 'refund' and wt.status = 'completed'
    and (p_start_date is null or o.created_at >= p_start_date)
    and (p_end_date   is null or o.created_at <  p_end_date);

  return jsonb_build_object(
    'period_start',      p_start_date,
    'period_end',        p_end_date,
    'total_orders',      v_orders,
    'completed_orders',  v_done,
    'partial_orders',    v_partial,
    'gross_revenue',     v_revenue,
    'provider_cost',     v_cost,
    'gross_profit',      v_revenue - v_cost,
    'completed_profit_snapshot', v_snapshot,
    'treasury_fees',     v_fees,
    'network_fees',      v_network,
    'refund_cost',       v_refunds,
    'net_profit',        v_revenue - v_cost - v_fees - v_network,
    'margin_pct',        case when v_revenue > 0 then round((v_revenue - v_cost) / v_revenue * 100, 2) end
  );
end;
$$;
