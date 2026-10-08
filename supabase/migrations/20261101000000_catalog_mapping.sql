-- =============================================================================
-- Phase 6: service mapping (provider_services -> storefront services, through provider_service_offers)
--
-- Functions only: no table changes. sync-catalog stores new panel services in provider_services and never puts them on the
-- storefront; these functions are how an admin does that, each as ONE transaction with an audit entry:
--   admin_unlinked_provider_services   panel services nobody sells yet
--   admin_link_provider_service        add an offer for an existing storefront service
--   admin_create_service_with_offer    create a storefront service from a panel service (+ its first offer)
-- Every function re-checks that the actor is an admin. Service role only: clients can never reach them; the
-- admin-catalog-mapping Edge Function is the only caller.
--
-- services.primary_provider_service_id is NOT NULL, so a service always has a primary; "link" therefore leaves it alone
-- unless the admin asks for the new offer to become the primary (p_make_primary).
-- =============================================================================

create function public.assert_catalog_admin(p_actor uuid)
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
-- Panel services that have no offer and are nobody's primary / fallback. Only active ones (an inactive one cannot be linked).
-- -----------------------------------------------------------------------------
create function public.admin_unlinked_provider_services(
  p_actor       uuid,
  p_provider_id uuid default null,
  p_search      text default null,
  p_limit       integer default 50,
  p_offset      integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_like   text := case when nullif(btrim(p_search), '') is null then null
                        else '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_total  integer;
  v_items  jsonb;
begin
  perform assert_catalog_admin(p_actor);

  with base as (
    select ps.*, p.name as provider_name
      from provider_services ps join providers p on p.id = ps.provider_id
     where ps.is_active
       and (p_provider_id is null or ps.provider_id = p_provider_id)
       and (v_like is null or ps.name ilike v_like or ps.category_raw ilike v_like or ps.external_service_id ilike v_like)
       and not exists (select 1 from provider_service_offers o where o.provider_service_id = ps.id)
       and not exists (select 1 from services s where s.primary_provider_service_id = ps.id or s.fallback_provider_service_id = ps.id)
  ), page as (
    select * from base order by provider_name, category_raw, name, id limit v_limit offset v_offset
  )
  select (select count(*) from base),
         coalesce((select jsonb_agg(jsonb_build_object(
           'id', id, 'providerId', provider_id, 'providerName', provider_name, 'externalServiceId', external_service_id,
           'name', name, 'categoryRaw', category_raw, 'ratePer1000', rate_per_1000,
           'minQuantity', min_quantity, 'maxQuantity', max_quantity,
           'refillSupported', refill_supported, 'cancelSupported', cancel_supported, 'lastSyncedAt', last_synced_at
         ) order by provider_name, category_raw, name, id) from page), '[]'::jsonb)
    into v_total, v_items;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- -----------------------------------------------------------------------------
-- Link: a new offer (service_id <-> provider_service_id) with the panel's own cost, limits and flags.
-- -----------------------------------------------------------------------------
create function public.admin_link_provider_service(
  p_actor               uuid,
  p_provider_service_id uuid,
  p_service_id          uuid,
  p_routing_score       integer default null,
  p_supports_partial    boolean default false,
  p_make_primary        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_svc   services%rowtype;
  v_ps    provider_services%rowtype;
  v_score integer;
  v_offer uuid;
begin
  perform assert_catalog_admin(p_actor);

  select * into v_svc from services where id = p_service_id for update;
  if not found then
    raise exception 'service_not_found: %', p_service_id using errcode = 'no_data_found';
  end if;
  select * into v_ps from provider_services where id = p_provider_service_id;
  if not found then
    raise exception 'provider_service_not_found: %', p_provider_service_id using errcode = 'no_data_found';
  end if;
  if not v_ps.is_active then
    raise exception 'provider_service_inactive: the panel no longer lists this service' using errcode = 'check_violation';
  end if;
  if exists (select 1 from provider_service_offers where service_id = p_service_id and provider_service_id = p_provider_service_id) then
    raise exception 'already_linked: this panel service already has an offer for this service' using errcode = 'unique_violation';
  end if;
  if v_ps.min_quantity > v_svc.max_quantity or v_ps.max_quantity < v_svc.min_quantity then
    raise exception 'limits_do_not_overlap: the panel accepts %..% but the service sells %..%',
      v_ps.min_quantity, v_ps.max_quantity, v_svc.min_quantity, v_svc.max_quantity using errcode = 'check_violation';
  end if;

  v_score := coalesce(p_routing_score, case when p_make_primary then 100 else 0 end);
  if v_score < 0 or v_score > 1000 then
    raise exception 'invalid_parameter_value: routing score must be 0..1000' using errcode = 'invalid_parameter_value';
  end if;

  insert into provider_service_offers
    (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity,
     refill_supported, cancel_supported, supports_partial, is_active, routing_score)
  values
    (p_service_id, v_ps.provider_id, v_ps.id, v_ps.rate_per_1000, v_ps.min_quantity, v_ps.max_quantity,
     v_ps.refill_supported, v_ps.cancel_supported, coalesce(p_supports_partial, false), true, v_score)
  returning id into v_offer;

  if p_make_primary and v_svc.primary_provider_service_id is distinct from v_ps.id then
    update services
       set primary_provider_service_id = v_ps.id,
           fallback_provider_service_id = case when fallback_provider_service_id = v_ps.id then null else fallback_provider_service_id end
     where id = p_service_id;
  end if;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'link_provider_service', v_offer::text,
          jsonb_build_object('service_id', p_service_id, 'provider_service_id', v_ps.id, 'cost_per_1000', v_ps.rate_per_1000,
                             'routing_score', v_score, 'made_primary', coalesce(p_make_primary, false)));

  return jsonb_build_object('offer_id', v_offer, 'service_id', p_service_id, 'provider_service_id', v_ps.id,
                            'cost_per_1000', v_ps.rate_per_1000, 'routing_score', v_score,
                            'is_primary', (select primary_provider_service_id = v_ps.id from services where id = p_service_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Create & link: a new storefront service whose primary is the panel service; the bridge trigger creates its offer
-- (routing_score 100), which is then completed here.
-- -----------------------------------------------------------------------------
create function public.admin_create_service_with_offer(
  p_actor               uuid,
  p_provider_service_id uuid,
  p_category_id         uuid,
  p_name                text,
  p_description         text,
  p_customer_rate       numeric,
  p_min_quantity        integer default null,
  p_max_quantity        integer default null,
  p_supports_partial    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ps    provider_services%rowtype;
  v_name  text := btrim(coalesce(p_name, ''));
  v_desc  text := nullif(btrim(coalesce(p_description, '')), '');
  v_rate  numeric(14,4);
  v_min   integer;
  v_max   integer;
  v_svc   uuid;
  v_offer uuid;
begin
  perform assert_catalog_admin(p_actor);

  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception 'invalid_parameter_value: name must be 1..120 characters' using errcode = 'invalid_parameter_value';
  end if;
  if v_desc is not null and char_length(v_desc) > 1000 then
    raise exception 'invalid_parameter_value: description must be at most 1000 characters' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from categories where id = p_category_id and is_active) then
    raise exception 'category_not_found: %', p_category_id using errcode = 'no_data_found';
  end if;
  select * into v_ps from provider_services where id = p_provider_service_id;
  if not found then
    raise exception 'provider_service_not_found: %', p_provider_service_id using errcode = 'no_data_found';
  end if;
  if not v_ps.is_active then
    raise exception 'provider_service_inactive: the panel no longer lists this service' using errcode = 'check_violation';
  end if;

  if p_customer_rate is null or p_customer_rate <= 0 or p_customer_rate > 1000000 then
    raise exception 'invalid_parameter_value: customer rate must be greater than 0' using errcode = 'invalid_parameter_value';
  end if;
  v_rate := round(p_customer_rate, 4);
  if v_rate < v_ps.rate_per_1000 then
    raise exception 'below_cost: customer rate % is below the panel cost %', v_rate, v_ps.rate_per_1000 using errcode = 'check_violation';
  end if;

  v_min := coalesce(p_min_quantity, v_ps.min_quantity);
  v_max := coalesce(p_max_quantity, v_ps.max_quantity);
  if v_min <= 0 or v_max < v_min then
    raise exception 'invalid_parameter_value: invalid quantity range' using errcode = 'invalid_parameter_value';
  end if;
  if v_min < v_ps.min_quantity or v_max > v_ps.max_quantity then
    raise exception 'limits_exceed_panel: the panel accepts %..%', v_ps.min_quantity, v_ps.max_quantity using errcode = 'check_violation';
  end if;

  insert into services
    (category_id, name, description, primary_provider_service_id, fallback_provider_service_id,
     customer_rate_per_1000, min_quantity, max_quantity, is_active, sort_order, refill_supported)
  values
    (p_category_id, v_name, v_desc, v_ps.id, null, v_rate, v_min, v_max, true, 0, v_ps.refill_supported)
  returning id into v_svc;

  -- trg_services_sync_offers has just created the primary offer (score 100) from the panel service
  update provider_service_offers set supports_partial = coalesce(p_supports_partial, false)
   where service_id = v_svc and provider_service_id = v_ps.id
  returning id into v_offer;
  if v_offer is null then
    raise exception 'internal: the offer for the new service was not created';
  end if;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'create_service_with_offer', v_svc::text,
          jsonb_build_object('offer_id', v_offer, 'provider_service_id', v_ps.id, 'category_id', p_category_id, 'name', v_name,
                             'customer_rate_per_1000', v_rate, 'cost_per_1000', v_ps.rate_per_1000));

  return jsonb_build_object('service_id', v_svc, 'offer_id', v_offer, 'provider_service_id', v_ps.id,
                            'customer_rate_per_1000', v_rate, 'cost_per_1000', v_ps.rate_per_1000,
                            'min_quantity', v_min, 'max_quantity', v_max);
end;
$$;

-- -----------------------------------------------------------------------------
-- Access: service role only.
-- -----------------------------------------------------------------------------
revoke all on function public.assert_catalog_admin(uuid),
  public.admin_unlinked_provider_services(uuid, uuid, text, integer, integer),
  public.admin_link_provider_service(uuid, uuid, uuid, integer, boolean, boolean),
  public.admin_create_service_with_offer(uuid, uuid, uuid, text, text, numeric, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function
  public.admin_unlinked_provider_services(uuid, uuid, text, integer, integer),
  public.admin_link_provider_service(uuid, uuid, uuid, integer, boolean, boolean),
  public.admin_create_service_with_offer(uuid, uuid, uuid, text, text, numeric, integer, integer, boolean)
  to service_role;
