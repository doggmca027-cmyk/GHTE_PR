-- =============================================================================
-- Drip-feed, part 4: the quote and what the storefront shows
--
-- services.dripfeed_available: the order form offers gradual delivery for this service. True while at least one offer that routing could
-- pick (active offer, active provider service the panel lists as drip-feed capable, active provider with routing on) exists. Rebuilt by
-- refresh_service_dripfeed() after every catalogue sync; readable by clients like the other storefront columns. It is only a hint for the
-- form: routing and place_order decide on their own.
--
-- quote_order_price takes p_runs (default 1) and prices exactly like place_order: the offer limits hold for one run (quantity / runs), a
-- drip-feed quote only looks at drip-feed capable offers, and the price is for the TOTAL quantity (volume step of the whole order).
-- =============================================================================

alter table public.services add column if not exists dripfeed_available boolean not null default false;
grant select (dripfeed_available) on table public.services to anon, authenticated;
comment on column public.services.dripfeed_available is 'At least one routable offer of this service is drip-feed capable. Rebuilt by refresh_service_dripfeed() after each catalogue sync.';

create or replace function public.refresh_service_dripfeed()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed integer;
begin
  with wanted as (
    select s.id, exists (
      select 1
        from provider_service_offers o
        join provider_services ps on ps.id = o.provider_service_id
        join providers p on p.id = o.provider_id
       where o.service_id = s.id and o.is_active
         and ps.is_active and ps.is_dripfeed_enabled
         and p.is_active and p.routing_enabled
    ) as available
    from services s
  )
  update services s set dripfeed_available = w.available
    from wanted w
   where w.id = s.id and s.dripfeed_available is distinct from w.available;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke all on function public.refresh_service_dripfeed() from public, anon, authenticated;
grant execute on function public.refresh_service_dripfeed() to service_role;

select public.refresh_service_dripfeed();

-- -----------------------------------------------------------------------------
-- quote_order_price: p_runs
-- -----------------------------------------------------------------------------
drop function public.quote_order_price(uuid, uuid, integer, text);

create function public.quote_order_price(p_user_id uuid, p_service_id uuid, p_quantity integer, p_promo_code text default null, p_runs integer default 1)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost numeric(14,4);
  v_runs integer := coalesce(p_runs, 1);
begin
  if exists (select 1 from users where id = p_user_id and is_banned) then
    raise exception 'user_banned: this account is suspended' using errcode = 'insufficient_privilege';
  end if;
  if v_runs < 1 then
    raise exception 'invalid_parameter_value: runs must be at least 1' using errcode = 'invalid_parameter_value';
  end if;
  if p_quantity % v_runs <> 0 then
    raise exception 'invalid_parameter_value: quantity must split evenly into runs' using errcode = 'invalid_parameter_value';
  end if;
  -- The order is routed to the best ELIGIBLE offer (health, balance and score are decided by the Edge Function). The quote assumes the
  -- most expensive offer that can take the order and still be sold at the list price: the customer is never shown less than they pay.
  -- A drip-feed order is taken run by run, so an offer must take one run, and must be drip-feed capable.
  select max(o.cost_per_1000) into v_cost
    from provider_service_offers o
    join providers p on p.id = o.provider_id
    join provider_services ps on ps.id = o.provider_service_id
    join services s on s.id = o.service_id
   where o.service_id = p_service_id and o.is_active and ps.is_active and p.is_active and p.routing_enabled
     and p_quantity / v_runs between o.min_quantity and o.max_quantity
     and (v_runs = 1 or ps.is_dripfeed_enabled)
     and o.cost_per_1000 <= s.customer_rate_per_1000;
  if v_cost is null then
    raise exception 'service_unavailable: no provider can take this order' using errcode = 'no_data_found';
  end if;
  -- the price is for the TOTAL quantity
  return calculate_order_price(p_user_id, p_service_id, p_quantity, round(v_cost * p_quantity / 1000, 4), p_promo_code);
end;
$$;

revoke all on function public.quote_order_price(uuid, uuid, integer, text, integer) from public, anon, authenticated;
grant execute on function public.quote_order_price(uuid, uuid, integer, text, integer) to service_role;
