-- =============================================================================
-- Partial refunds + order status sync support
--
--  * orders.partial_refund_amount: how much of the charge was already returned for undelivered units.
--  * apply_partial_refund(): atomic and idempotent "provider says Partial" handler
--      (lock order -> status partial -> remains/refund recorded -> ledger credit, one transaction).
--  * refund_order() now refunds only what has NOT been refunded yet, so refunding a `partial`
--    order later can never pay the same money out twice.
-- =============================================================================

alter table public.orders
  add column if not exists partial_refund_amount numeric(14,4) not null default 0;

alter table public.orders
  add constraint orders_partial_refund_bounds
  check (partial_refund_amount >= 0 and partial_refund_amount <= charge_amount);

-- Worker queries: oldest-checked active orders, and refunds that still need to be retried.
create index if not exists idx_orders_sync_active
  on public.orders (updated_at) where status in ('submitted', 'in_progress', 'processing');
create index if not exists idx_orders_needs_refund
  on public.orders (updated_at) where error_message like 'needs_refund%';

-- History rows written inside one transaction (place_order: draft -> awaiting_payment -> paid;
-- apply_partial_refund: processing -> submitted -> partial) must keep their real order.
-- now() is frozen per transaction, clock_timestamp() is not.
alter table public.order_status_history alter column created_at set default clock_timestamp();

-- -----------------------------------------------------------------------------
-- Partial refund: refund = round(charge * remains / quantity, 4)
--
-- Multiplying before dividing keeps the exact quotient for NUMERIC; the single rounding step
-- is the only place precision is lost (<= 0.00005), and the amount the platform keeps is
-- charge - refund, so refunded + retained == charge to the last digit (nothing leaks).
-- -----------------------------------------------------------------------------
create function public.apply_partial_refund(
  p_order_id    uuid,
  p_remains     integer,
  p_start_count integer default null
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o      public.orders%rowtype;
  v_refund numeric(14,4);
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  -- Already settled as partial: single execution per order.
  if o.status = 'partial' then
    return o;
  end if;
  if o.status not in ('processing', 'submitted', 'in_progress') then
    raise exception 'order % is % and cannot become partial', o.id, o.status using errcode = 'check_violation';
  end if;
  if p_remains is null or p_remains < 0 or p_remains > o.quantity then
    raise exception 'remains must be between 0 and % (got %)', o.quantity, p_remains using errcode = 'invalid_parameter_value';
  end if;

  v_refund := round(o.charge_amount * p_remains / o.quantity, 4);

  -- A held order that the provider actually accepted: record the missing `submitted` step first.
  if o.status = 'processing' then
    update orders set status = 'submitted', error_message = null where id = o.id returning * into o;
  end if;

  perform set_config('app.status_comment',
    format('Partial: %s of %s undelivered, refunded %s', p_remains, o.quantity, v_refund), true);
  update orders
     set status = 'partial',
         remains = p_remains,
         start_count = coalesce(p_start_count, start_count),
         partial_refund_amount = v_refund,
         error_message = null
   where id = o.id
  returning * into o;

  -- Idempotent at the ledger level too: the key is unique per order.
  if v_refund > 0 then
    perform process_wallet_transaction(
      o.user_id, 'refund', v_refund, o.id,
      'Partial refund for order #' || o.id, 'partial_refund:' || o.id);
  end if;

  return o;
end;
$$;

-- -----------------------------------------------------------------------------
-- refund_order: only the not-yet-refunded part of the charge can be refunded.
-- -----------------------------------------------------------------------------
create or replace function public.refund_order(
  p_order_id uuid,
  p_amount   numeric default null,
  p_comment  text default null
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     orders%rowtype;
  v_remaining numeric(14,4);
  v_amount    numeric(14,4);
begin
  select * into v_order from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.status = 'refunded' then
    return v_order;  -- idempotent
  end if;

  if not exists (select 1 from wallet_transactions
                 where reference_id = v_order.id and type = 'purchase' and status = 'completed') then
    raise exception 'order % was never paid; nothing to refund', v_order.id
      using errcode = 'check_violation';
  end if;

  v_remaining := v_order.charge_amount - v_order.partial_refund_amount;

  perform set_config('app.status_comment', coalesce(p_comment, 'refund'), true);

  -- Everything was already returned (e.g. a partial refund of 100%): just close the order.
  if v_remaining <= 0 then
    update orders set status = 'refunded' where id = v_order.id returning * into v_order;
    return v_order;
  end if;

  v_amount := round(coalesce(p_amount, v_remaining), 4);
  if v_amount <= 0 or v_amount > v_remaining then
    raise exception 'refund amount must be in (0, %]', v_remaining
      using errcode = 'invalid_parameter_value';
  end if;

  -- Validates the transition (raises for e.g. in_progress -> refunded).
  update orders set status = 'refunded' where id = v_order.id returning * into v_order;

  perform process_wallet_transaction(
    v_order.user_id, 'refund', v_amount, v_order.id,
    'Refund for order ' || v_order.id, 'refund:' || v_order.id);

  return v_order;
end;
$$;

revoke all on function public.apply_partial_refund(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.apply_partial_refund(uuid, integer, integer) to service_role;
