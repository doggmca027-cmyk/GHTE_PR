-- =============================================================================
-- Phase 1K: Reconciliation Center
--
-- One table of "something needs a human" cases, with atomic and idempotent ways to resolve them. Orders are the only
-- entity that is detected today; 'deposit' and 'provider_payment' are reserved for the next detectors.
--
-- "Needs reconciliation" is not a column on orders: it is derived (same rule as admin_reconciliation_queue()):
--   * a `processing` order older than the in-flight grace (outcome at the provider unknown), or
--   * any other open status carrying a `needs_*` note (e.g. failed + needs_refund: a refund is still owed).
-- An UPDATE trigger opens a case the moment an order enters that state; sync_reconciliation_cases() (run by cron and
-- by the admin API) also catches orders that become stuck purely by the passage of time, and closes cases whose order
-- has been settled elsewhere (e.g. by the sync worker).
--
-- Service role only: the admin-reconciliation Edge Function checks the admin and passes the actor id.
-- =============================================================================

create type public.reconciliation_entity_enum as enum ('order', 'deposit', 'provider_payment');
create type public.reconciliation_status_enum as enum ('open', 'resolved');

create table public.reconciliation_cases (
  id              uuid primary key default gen_random_uuid(),
  entity_type     public.reconciliation_entity_enum not null,
  entity_id       text not null check (length(entity_id) between 1 and 100),
  reason          text not null check (length(reason) <= 500),
  status          public.reconciliation_status_enum not null default 'open',
  -- how it was closed: refund | retry | manual | auto
  resolution      text check (resolution in ('refund', 'retry', 'manual', 'auto')),
  resolution_note text check (resolution_note is null or length(resolution_note) <= 500),
  resolved_by     uuid references public.users(id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint recon_resolved_fields check ((status = 'open') = (resolution is null and resolved_at is null))
);
-- At most one OPEN case per entity; history of closed ones is kept.
create unique index uq_recon_open_per_entity on public.reconciliation_cases (entity_type, entity_id) where status = 'open';
create index idx_recon_status_created on public.reconciliation_cases (status, created_at);
create trigger trg_recon_updated_at before update on public.reconciliation_cases
  for each row execute function public.set_updated_at();

alter table public.reconciliation_cases enable row level security;
revoke all on table public.reconciliation_cases from anon, authenticated;

-- -----------------------------------------------------------------------------
-- The rule (single definition for the trigger, the detector and the resolvers)
-- -----------------------------------------------------------------------------
create function public.order_needs_reconciliation(o public.orders)
returns boolean
language sql
stable
as $$
  select o.status not in ('refunded', 'completed', 'partial', 'draft')
     and ((o.status = 'processing' and o.created_at < now() - public.admin_inflight_grace())
          or (o.status <> 'processing' and o.error_message like 'needs\_%'))
$$;

-- Opens (or refreshes) the case when an order enters the state. It never closes one: closing is explicit (the resolvers)
-- or lazy (sync_reconciliation_cases), so a resolver that edits the order cannot have its case closed or re-opened under it.
create function public.open_case_for_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.order_needs_reconciliation(new) then
    insert into reconciliation_cases (entity_type, entity_id, reason)
    values ('order', new.id::text, left(coalesce(new.error_message, 'Stuck in processing without a confirmation from the provider'), 500))
    on conflict (entity_type, entity_id) where status = 'open'
    do update set reason = excluded.reason;
  end if;
  return new;
end;
$$;
create trigger trg_orders_open_case after insert or update of status, error_message on public.orders
  for each row execute function public.open_case_for_order();

-- Detector. Idempotent; safe to run every minute.
create function public.sync_reconciliation_cases()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opened integer;
  v_closed integer;
begin
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

  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end;
$$;

-- Open cases with what the admin needs to decide (order, customer, amount).
create function public.list_reconciliation_cases()
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
      'service_name', s.name, 'username', u.username, 'telegram_id', u.telegram_id, 'user_id', u.id) end
  ) order by c.created_at), '[]'::jsonb)
  from reconciliation_cases c
  left join orders o on c.entity_type = 'order' and o.id::text = c.entity_id
  left join users u on u.id = o.user_id
  left join services s on s.id = o.service_id
  where c.status = 'open'
$$;

-- shared guard for the resolvers
create function public.assert_recon_actor(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_actor is null or not exists (select 1 from users where id = p_actor and is_admin and not is_banned) then
    raise exception 'forbidden: actor is not an admin' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- RESOLVE_REFUND: full refund to the customer's wallet, order -> refunded, case -> resolved. One transaction.
-- Lock order: case, then order (refund_order re-locks the order it already holds). Idempotent twice over: a closed case
-- is a no-op, and refund_order itself never pays twice (one `refund:<order>` ledger key).
-- -----------------------------------------------------------------------------
create function public.resolve_case_refund(p_case_id uuid, p_actor uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c reconciliation_cases%rowtype;
  o orders%rowtype;
begin
  perform assert_recon_actor(p_actor);

  select * into c from reconciliation_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if c.status = 'resolved' then
    return jsonb_build_object('case_id', c.id, 'status', 'resolved', 'resolution', c.resolution, 'already_resolved', true);
  end if;
  if c.entity_type <> 'order' then
    raise exception 'unsupported_entity: only order cases can be refunded' using errcode = 'check_violation';
  end if;

  select * into o from orders where id = c.entity_id::uuid for update;
  if not found then
    raise exception 'order % not found', c.entity_id using errcode = 'no_data_found';
  end if;

  if o.status <> 'refunded' then
    if not order_needs_reconciliation(o) then
      raise exception 'order % (%) is not in the reconciliation queue', o.id, o.status using errcode = 'check_violation';
    end if;
    -- Never refund a retry that is being submitted right now: the provider may be about to accept it.
    if o.error_message like 'needs\_reconciliation: retry in progress%' and o.updated_at > now() - interval '5 minutes' then
      raise exception 'retry_in_progress: wait for the retry to finish' using errcode = 'check_violation';
    end if;
    if o.status = 'processing' then
      update orders set status = 'failed', error_message = 'needs_refund: admin force refund' where id = o.id;
    end if;
    perform refund_order(o.id, null, 'Admin force refund' || coalesce(': ' || nullif(trim(p_reason), ''), ''));
    update orders set error_message = null where id = o.id returning * into o;
  end if;

  update reconciliation_cases
     set status = 'resolved', resolution = 'refund', resolution_note = nullif(trim(p_reason), ''), resolved_by = p_actor, resolved_at = now()
   where id = c.id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'reconcile_refund', c.id::text, jsonb_build_object('order_id', o.id, 'charge_amount', o.charge_amount, 'reason', p_reason));
  return jsonb_build_object('case_id', c.id, 'status', 'resolved', 'resolution', 'refund', 'order_status', o.status, 'amount', o.charge_amount);
end;
$$;

-- -----------------------------------------------------------------------------
-- RESOLVE_RETRY, step 1: claim the retry. Atomic: only one caller can hold it (a marker on the order, which expires after
-- 5 minutes in case the caller crashed). Only `processing` orders without a provider id qualify (outcome unknown), and the
-- retry always goes to the SAME provider offer the order was charged for: an order is never silently re-routed.
-- Returns what the Edge Function needs to talk to the provider.
-- -----------------------------------------------------------------------------
create function public.begin_case_retry(p_case_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c reconciliation_cases%rowtype;
  o orders%rowtype;
begin
  perform assert_recon_actor(p_actor);

  select * into c from reconciliation_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if c.status <> 'open' then
    raise exception 'case_not_open: this case was already resolved' using errcode = 'check_violation';
  end if;
  if c.entity_type <> 'order' then
    raise exception 'unsupported_entity: only order cases can be retried' using errcode = 'check_violation';
  end if;

  select * into o from orders where id = c.entity_id::uuid for update;
  if not found then
    raise exception 'order % not found', c.entity_id using errcode = 'no_data_found';
  end if;
  if o.status <> 'processing' or o.provider_order_id is not null or not order_needs_reconciliation(o) then
    raise exception 'not_retryable: only a held order without a provider id can be retried (this one is %)', o.status using errcode = 'check_violation';
  end if;
  if o.provider_offer_id is null then
    raise exception 'not_retryable: this order has no routing snapshot' using errcode = 'check_violation';
  end if;
  if o.error_message like 'needs\_reconciliation: retry in progress%' and o.updated_at > now() - interval '5 minutes' then
    raise exception 'retry_in_progress: another retry is running for this order' using errcode = 'check_violation';
  end if;

  update orders set error_message = 'needs_reconciliation: retry in progress' where id = o.id;
  return jsonb_build_object('order_id', o.id, 'target_url', o.target_url, 'quantity', o.quantity, 'provider_offer_id', o.provider_offer_id);
end;
$$;

-- Step 2a: the provider accepted. Order -> submitted with its provider id, case -> resolved, one transaction.
create function public.finish_case_retry(p_case_id uuid, p_actor uuid, p_provider_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c reconciliation_cases%rowtype;
  o orders%rowtype;
begin
  perform assert_recon_actor(p_actor);
  if p_provider_order_id is null or length(trim(p_provider_order_id)) = 0 then
    raise exception 'the provider order id is required' using errcode = 'invalid_parameter_value';
  end if;

  select * into c from reconciliation_cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'no_data_found';
  end if;
  if c.status = 'resolved' then
    return jsonb_build_object('case_id', c.id, 'status', 'resolved', 'resolution', c.resolution, 'already_resolved', true);
  end if;

  select * into o from orders where id = c.entity_id::uuid for update;
  if o.status <> 'processing' or o.provider_order_id is not null then
    raise exception 'not_retryable: order % is % and cannot take a provider id', o.id, o.status using errcode = 'check_violation';
  end if;

  perform set_config('app.status_comment', 'Retried by admin: accepted by the provider', true);
  update orders set provider_order_id = trim(p_provider_order_id), status = 'submitted', error_message = null where id = o.id;
  update reconciliation_cases
     set status = 'resolved', resolution = 'retry', resolution_note = 'Resubmitted to the provider', resolved_by = p_actor, resolved_at = now()
   where id = c.id;
  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'reconcile_retry', c.id::text, jsonb_build_object('order_id', o.id, 'provider_order_id', trim(p_provider_order_id)));
  return jsonb_build_object('case_id', c.id, 'status', 'resolved', 'resolution', 'retry', 'order_status', 'submitted');
end;
$$;

-- Step 2b: the retry did not succeed. Drop the marker and record why; the case stays open.
create function public.release_case_retry(p_case_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c reconciliation_cases%rowtype;
begin
  select * into c from reconciliation_cases where id = p_case_id for update;
  if not found or c.status <> 'open' or c.entity_type <> 'order' then
    return;
  end if;
  update orders
     set error_message = left('needs_reconciliation: ' || coalesce(nullif(trim(p_note), ''), 'retry did not succeed'), 400)
   where id = c.entity_id::uuid and status = 'processing' and provider_order_id is null;
end;
$$;

-- -----------------------------------------------------------------------------
-- MARK_RESOLVED: close the case without any financial action (the admin dealt with it elsewhere).
--   order still in the queue, processing  : the provider order id is required (nothing could sync it otherwise) -> submitted
--   order still in the queue, failed/etc. : a note is required -> the needs_* flag is cleared
--   order no longer in the queue / other entity types: just closed (other entities need a note)
-- -----------------------------------------------------------------------------
create function public.resolve_case_manual(p_case_id uuid, p_actor uuid, p_note text default null, p_provider_order_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c reconciliation_cases%rowtype;
  o orders%rowtype;
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
-- Backfill: orders that already need attention get their case.
-- -----------------------------------------------------------------------------
select public.sync_reconciliation_cases();

-- -----------------------------------------------------------------------------
-- Access: service role only.
-- -----------------------------------------------------------------------------
revoke all on function
  public.order_needs_reconciliation(public.orders), public.open_case_for_order(), public.sync_reconciliation_cases(),
  public.list_reconciliation_cases(), public.assert_recon_actor(uuid), public.resolve_case_refund(uuid, uuid, text),
  public.begin_case_retry(uuid, uuid), public.finish_case_retry(uuid, uuid, text), public.release_case_retry(uuid, text),
  public.resolve_case_manual(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function
  public.sync_reconciliation_cases(), public.list_reconciliation_cases(), public.resolve_case_refund(uuid, uuid, text),
  public.begin_case_retry(uuid, uuid), public.finish_case_retry(uuid, uuid, text), public.release_case_retry(uuid, text),
  public.resolve_case_manual(uuid, uuid, text, text)
  to service_role;
