-- =============================================================================
-- Critical fixes after the architecture audit
--
-- 1. Unknown provider outcome -> reconciliation, immediately. A `processing` order whose submission returned an
--    unknown outcome (timeout, network loss, 5xx, garbled answer) is held with a `needs_reconciliation: <reason>` note.
--    Until now it only became a case after the 10-minute in-flight grace; now the held note opens the case at once.
--    Orders still in flight (`submission in flight`) and retries being submitted still wait for the grace.
-- 2. Atomic provider balance reservation. place_order now deducts the order's provider cost from the provider's cached
--    balance in the SAME transaction as the customer's debit, with `provider_balance >= cost` in the UPDATE itself, so two
--    concurrent orders can never both spend the last funds. A clean provider rejection gives the reservation back.
--    Applies to providers whose balance is known (synced at least once); routing-enabled providers are synced every
--    minute by the health monitor.
-- 3. Poisoned catalog protection. Offers can be suspended and flagged when a provider's price moves more than the
--    allowed band or its data becomes impossible; the observed values are kept for an admin to accept.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Held orders open a reconciliation case immediately
-- -----------------------------------------------------------------------------
create or replace function public.order_needs_reconciliation(o public.orders)
returns boolean
language sql
stable
as $$
  select o.status not in ('refunded', 'completed', 'partial', 'draft')
     and ((o.status = 'processing'
           and (o.created_at < now() - public.admin_inflight_grace()
                -- the provider call RETURNED with an unknown outcome: nothing is in flight any more
                or (o.provider_order_id is null
                    and o.error_message like 'needs\_reconciliation:%'
                    and o.error_message <> 'needs_reconciliation: submission in flight'
                    and o.error_message not like 'needs\_reconciliation: retry in progress%')))
          or (o.status <> 'processing' and o.error_message like 'needs\_%'))
$$;

-- -----------------------------------------------------------------------------
-- 2. Provider balance reservation
-- -----------------------------------------------------------------------------
alter table public.orders
  add column provider_reservation numeric(14,4) not null default 0 check (provider_reservation >= 0);

create or replace function public.place_order(
  p_user_id             uuid,
  p_service_id          uuid,
  p_target_url          text,
  p_quantity            integer,
  p_provider_offer_id   uuid,
  p_provider_id         uuid,
  p_provider_service_id uuid,
  p_cost_amount         numeric,
  p_idempotency_key     text default null
) returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_svc      services%rowtype;
  v_offer    provider_service_offers%rowtype;
  v_order    orders%rowtype;
  v_charge   numeric(14,4);
  v_cost     numeric(14,4);
  v_reserved numeric(14,4) := 0;
  v_avail    numeric(14,4);
begin
  -- Serialise all purchases of this user; also makes the idempotency lookup race-free.
  perform 1 from wallets where user_id = p_user_id for update;
  if not found then
    raise exception 'wallet not found for user %', p_user_id using errcode = 'no_data_found';
  end if;

  if p_idempotency_key is not null then
    select * into v_order from orders where idempotency_key = p_idempotency_key;
    if found then
      if v_order.user_id <> p_user_id or v_order.service_id <> p_service_id
         or v_order.quantity <> p_quantity or v_order.target_url <> p_target_url then
        raise exception 'idempotency key % was already used with different parameters', p_idempotency_key
          using errcode = 'unique_violation';
      end if;
      return v_order;  -- a replay keeps its original routing snapshot (and reserves nothing again)
    end if;
  end if;

  select * into v_svc from services where id = p_service_id and is_active;
  if not found then
    raise exception 'service not found or inactive' using errcode = 'no_data_found';
  end if;
  if p_quantity < v_svc.min_quantity or p_quantity > v_svc.max_quantity then
    raise exception 'quantity must be between % and %', v_svc.min_quantity, v_svc.max_quantity
      using errcode = 'check_violation';
  end if;

  select * into v_offer from provider_service_offers
   where id = p_provider_offer_id and service_id = p_service_id and is_active;
  if not found
     or v_offer.provider_id <> p_provider_id
     or v_offer.provider_service_id <> p_provider_service_id then
    raise exception 'provider offer not found, inactive or not valid for this service' using errcode = 'no_data_found';
  end if;
  if p_quantity < v_offer.min_quantity or p_quantity > v_offer.max_quantity then
    raise exception 'quantity is outside the limits of the selected provider offer' using errcode = 'check_violation';
  end if;

  v_cost := round(p_cost_amount, 4);
  if p_cost_amount is null or p_cost_amount < 0
     or abs(v_cost - round(v_offer.cost_per_1000 * p_quantity / 1000, 4)) > 0.0001 then
    raise exception 'cost does not match the selected provider offer' using errcode = 'check_violation';
  end if;

  v_charge := round(v_svc.customer_rate_per_1000 * p_quantity / 1000, 4);
  if v_charge <= 0 then
    raise exception 'order total is too small' using errcode = 'check_violation';
  end if;

  -- Reserve the provider cost: one atomic UPDATE, the funds check inside its WHERE. Concurrent orders queue on the
  -- provider row, and the second one re-evaluates the WHERE against the first one's result.
  if v_cost > 0 then
    update providers set provider_balance = provider_balance - v_cost
     where id = v_offer.provider_id and last_balance_sync is not null and provider_balance >= v_cost
    returning provider_balance into v_avail;
    if found then
      v_reserved := v_cost;
    elsif exists (select 1 from providers where id = v_offer.provider_id and last_balance_sync is not null) then
      select provider_balance into v_avail from providers where id = v_offer.provider_id;
      raise exception 'insufficient_provider_balance: available %, required %', v_avail, v_cost
        using errcode = 'check_violation';
    end if;
    -- balance never synced: nothing to reserve against (the health monitor syncs every routing-enabled provider)
  end if;

  insert into orders (user_id, service_id, target_url, quantity, charge_amount, cost_amount, profit_amount,
                      provider_id, provider_offer_id, routing_score_snapshot, idempotency_key, provider_reservation)
  values (p_user_id, p_service_id, p_target_url, p_quantity, v_charge, v_cost, v_charge - v_cost,
          v_offer.provider_id, v_offer.id, v_offer.routing_score, p_idempotency_key, v_reserved)
  returning * into v_order;

  update orders set status = 'awaiting_payment' where id = v_order.id;

  perform process_wallet_transaction(
    p_user_id, 'purchase', -v_charge, v_order.id,
    'Order ' || v_order.id, 'purchase:' || v_order.id);

  update orders set status = 'paid' where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

-- Gives a reservation back after a CLEAN provider rejection (the provider did not create the order). Idempotent: the
-- order's reservation is zeroed in the same transaction, so a second call returns 0. Refuses orders the provider may
-- hold (a provider order id, or still processing with an unknown outcome).
create function public.release_provider_reservation(p_order_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if o.provider_reservation = 0 then
    return 0;
  end if;
  if o.provider_order_id is not null or o.status not in ('failed', 'canceled', 'refunded') then
    raise exception 'reservation of order % cannot be released: the provider may hold it (%)', o.id, o.status
      using errcode = 'check_violation';
  end if;
  update providers set provider_balance = provider_balance + o.provider_reservation where id = o.provider_id;
  update orders set provider_reservation = 0 where id = o.id;
  return o.provider_reservation;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Catalog anomalies
-- -----------------------------------------------------------------------------
alter table public.provider_service_offers
  add column anomaly_detected    boolean not null default false,
  add column anomaly_reason      text check (anomaly_reason is null or length(anomaly_reason) <= 300),
  -- what the provider reported (rate / min / max) and we refused to apply
  add column anomaly_observed    jsonb,
  add column anomaly_detected_at timestamptz;
create index idx_pso_anomaly on public.provider_service_offers (anomaly_detected_at) where anomaly_detected;

-- Suspends every offer built on a provider service and records why. Idempotent (re-flagging refreshes the details).
create function public.flag_catalog_anomaly(p_provider_service_id uuid, p_reason text, p_observed jsonb default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update provider_service_offers
     set is_active = false, anomaly_detected = true, anomaly_reason = left(p_reason, 300),
         anomaly_observed = p_observed, anomaly_detected_at = coalesce(anomaly_detected_at, now())
   where provider_service_id = p_provider_service_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- An admin accepts the provider's new values: they are applied to the provider service (the bridge trigger carries
-- cost and limits to every offer), the flag is cleared and the offer is active again. The customer price follows on the
-- next catalog sync, or immediately through the pricing tools.
create function public.accept_catalog_anomaly(p_offer_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_offer provider_service_offers%rowtype;
  v_rate  numeric;
  v_min   integer;
  v_max   integer;
begin
  if p_actor is null or not exists (select 1 from users where id = p_actor and is_admin and not is_banned) then
    raise exception 'forbidden: actor is not an admin' using errcode = 'insufficient_privilege';
  end if;
  select * into v_offer from provider_service_offers where id = p_offer_id for update;
  if not found then
    raise exception 'offer % not found', p_offer_id using errcode = 'no_data_found';
  end if;
  if not v_offer.anomaly_detected then
    return jsonb_build_object('offer_id', v_offer.id, 'already_clear', true);
  end if;

  v_rate := (v_offer.anomaly_observed ->> 'rate')::numeric;
  v_min  := (v_offer.anomaly_observed ->> 'min')::integer;
  v_max  := (v_offer.anomaly_observed ->> 'max')::integer;
  if v_rate is null or v_rate < 0 or v_min is null or v_min <= 0 or v_max is null or v_max < v_min then
    raise exception 'the observed values are not valid and cannot be accepted' using errcode = 'check_violation';
  end if;

  update provider_services set rate_per_1000 = round(v_rate, 4), min_quantity = v_min, max_quantity = v_max
   where id = v_offer.provider_service_id;
  update provider_service_offers
     set is_active = true, anomaly_detected = false, anomaly_reason = null, anomaly_observed = null, anomaly_detected_at = null
   where provider_service_id = v_offer.provider_service_id and anomaly_detected;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'accept_catalog_anomaly', v_offer.id::text, jsonb_build_object('rate', v_rate, 'min', v_min, 'max', v_max));
  return jsonb_build_object('offer_id', v_offer.id, 'rate', v_rate, 'min', v_min, 'max', v_max);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only (place_order keeps its existing grants).
-- -----------------------------------------------------------------------------
revoke all on function public.release_provider_reservation(uuid), public.flag_catalog_anomaly(uuid, text, jsonb),
  public.accept_catalog_anomaly(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_provider_reservation(uuid), public.flag_catalog_anomaly(uuid, text, jsonb),
  public.accept_catalog_anomaly(uuid, uuid) to service_role;
