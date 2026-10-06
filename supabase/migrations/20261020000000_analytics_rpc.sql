-- =============================================================================
-- Phase 1I: profit analytics
--
-- get_profit_analytics(start, end): realised revenue, provider cost, gross profit, treasury fees and net profit for the
-- orders PLACED in [start, end) (created_at; a NULL bound is open-ended). Read-only, admin only.
--
-- Realised amounts only (same rules as get_admin_metrics()):
--   completed  revenue = charge_amount                          cost = cost_amount
--   partial    revenue = charge_amount - partial_refund_amount  cost = cost_amount * (quantity - remains) / quantity
--   all other statuses (draft, active, canceled, failed, refunded) earn and cost nothing here.
-- Treasury fees: |sum(amount)| of treasury_transactions of type 'fee' created in the period.
-- =============================================================================

-- Range scans for the order aggregation (the status filter is cheap on the narrowed rows).
create index idx_orders_created_at on public.orders (created_at);

create function public.get_profit_analytics(
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
begin
  perform require_admin();
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'end date must be after start date' using errcode = 'invalid_parameter_value';
  end if;

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

  select coalesce(abs(sum(amount)), 0) into v_fees
  from treasury_transactions
  where type = 'fee'
    and (p_start_date is null or created_at >= p_start_date)
    and (p_end_date   is null or created_at <  p_end_date);

  return jsonb_build_object(
    'period_start',      p_start_date,
    'period_end',        p_end_date,
    'total_orders',      v_orders,
    'completed_orders',  v_done,
    'partial_orders',    v_partial,
    'gross_revenue',     v_revenue,
    'provider_cost',     v_cost,
    'gross_profit',      v_revenue - v_cost,
    -- sum of the profit snapshots taken at order time: equals the part of gross_profit that comes from completed orders
    'completed_profit_snapshot', v_snapshot,
    'treasury_fees',     v_fees,
    'net_profit',        v_revenue - v_cost - v_fees,
    'margin_pct',        case when v_revenue > 0 then round((v_revenue - v_cost) / v_revenue * 100, 2) end
  );
end;
$$;

revoke all on function public.get_profit_analytics(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_profit_analytics(timestamptz, timestamptz) to authenticated, service_role;
