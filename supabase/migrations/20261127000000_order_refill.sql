-- =============================================================================
-- Refill ("докрутка"): a customer asks the provider to restore what dropped after delivery, for services sold with a guarantee.
--
-- orders.refill_available   decided when the order is routed: the storefront service AND the offer it went to support refill
-- orders.refill_status      null | requested (asked, waiting for the provider) | in_progress (the provider accepted, refill id kept)
--                            | rejected (the provider refused) | completed
-- orders.refill_requested_at / provider_refill_id
--
-- begin_order_refill(user, order)  every rule, under the order's lock: the caller's own order, not suspended, delivered
--                                   (completed / partial), refill available, sent to a provider, at least 24 h old, inside the
--                                   guarantee (the service's refill days; "lifetime" = no end; unknown = 30 days), and at most one
--                                   request a day. Marks it requested and returns what the Edge Function needs to call the panel.
-- finish_order_refill(order, ok, refill id, reason)  records the panel's answer.
-- Both service role only; the request-refill Edge Function is the only caller.
-- =============================================================================

alter table public.orders
  add column refill_available    boolean not null default false,
  add column refill_status       text check (refill_status in ('requested', 'in_progress', 'completed', 'rejected')),
  add column refill_requested_at timestamptz,
  add column provider_refill_id  text check (provider_refill_id is null or length(provider_refill_id) between 1 and 100);

create function public.set_order_refill_available()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.refill_available := coalesce((select o.refill_supported from provider_service_offers o where o.id = new.provider_offer_id), false)
                      and coalesce((select s.refill_supported from services s where s.id = new.service_id), false);
  return new;
end;
$$;
create trigger trg_orders_refill_available before insert or update of provider_offer_id on public.orders
  for each row execute function public.set_order_refill_available();

-- orders that exist already
update public.orders o
   set refill_available = true
 where o.provider_offer_id is not null
   and exists (select 1 from provider_service_offers x where x.id = o.provider_offer_id and x.refill_supported)
   and exists (select 1 from services s where s.id = o.service_id and s.refill_supported);

grant select (refill_available, refill_status, refill_requested_at) on table public.orders to authenticated;

create function public.begin_order_refill(p_user_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o        orders%rowtype;
  v_refill jsonb;
  v_days   integer;
begin
  select * into o from orders where id = p_order_id for update;
  if not found or o.user_id is distinct from p_user_id then
    raise exception 'order_not_found: no such order' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: the account is suspended' using errcode = 'insufficient_privilege';
  end if;
  if o.status not in ('completed', 'partial') then
    raise exception 'refill_not_delivered: a refill is possible once the order is delivered' using errcode = 'check_violation';
  end if;
  if not o.refill_available or o.provider_order_id is null or o.provider_id is null then
    raise exception 'refill_unavailable: this service has no refill' using errcode = 'check_violation';
  end if;
  if o.created_at > now() - interval '24 hours' then
    raise exception 'refill_too_early: a refill can be asked 24 hours after the order' using errcode = 'check_violation';
  end if;
  if o.refill_requested_at is not null and o.refill_requested_at > now() - interval '24 hours' then
    raise exception 'refill_cooldown: one refill request a day; next after %', to_char(o.refill_requested_at + interval '24 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      using errcode = 'check_violation';
  end if;

  select s.attributes -> 'refill' into v_refill from services s where s.id = o.service_id;
  if v_refill is not null and jsonb_typeof(v_refill) = 'string' and v_refill #>> '{}' = 'none' then
    raise exception 'refill_unavailable: this service has no refill' using errcode = 'check_violation';
  end if;
  v_days := case when v_refill is not null and jsonb_typeof(v_refill) = 'number' then (v_refill #>> '{}')::numeric::integer
                 when v_refill is not null and jsonb_typeof(v_refill) = 'string' and v_refill #>> '{}' = 'lifetime' then null
                 else 30 end;
  if v_days is not null and o.created_at < now() - make_interval(days => v_days) then
    raise exception 'refill_expired: the % day guarantee of this order is over', v_days using errcode = 'check_violation';
  end if;

  update orders set refill_status = 'requested', refill_requested_at = now() where id = o.id;
  return jsonb_build_object('order_id', o.id, 'provider_id', o.provider_id, 'provider_order_id', o.provider_order_id);
end;
$$;

create function public.finish_order_refill(p_order_id uuid, p_ok boolean, p_refill_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text := case when p_ok then 'in_progress' else 'rejected' end;
begin
  update orders
     set refill_status = v_status,
         provider_refill_id = case when p_ok then left(nullif(btrim(p_refill_id), ''), 100) else provider_refill_id end
   where id = p_order_id and refill_status = 'requested';
  return jsonb_build_object('order_id', p_order_id, 'refill_status', v_status);
end;
$$;

revoke all on function public.set_order_refill_available() from public, anon, authenticated;
revoke all on function public.begin_order_refill(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_order_refill(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.begin_order_refill(uuid, uuid) to service_role;
grant execute on function public.finish_order_refill(uuid, boolean, text) to service_role;
