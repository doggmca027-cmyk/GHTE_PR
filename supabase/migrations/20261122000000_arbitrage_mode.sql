-- =============================================================================
-- Smart Arbitrage: one switch for every donor network.
--
-- A donor is a provider with catalog_mode = 'linked_only': it sells nothing on its own and only receives the orders of the
-- storefront services an admin linked it to. The primary network (catalog_mode = 'publish') is never touched here.
--
--   admin_arbitrage_status(actor)                      what the admin card shows: the primary networks and every donor
--                                                      (routing, health, balance, active linked offers, key present)
--   admin_set_arbitrage_mode(actor, enabled, readings) OFF: every donor gets routing_enabled = false, health 'disabled'
--                                                      ON:  every ACTIVE donor WITH an API key gets routing_enabled = true and
--                                                           the live balance the Edge Function just read ({id, ok, balance,
--                                                           currency}); health 'healthy' when its panel answered (even at a
--                                                           zero balance: the router only sends what the balance covers and
--                                                           falls back to the primary), 'unavailable' when it did not.
--                                                           An inactive donor or one without a key is left as it is.
-- Both lock the donor rows and write ONE admin_audit_log entry; service role only, admin checked again inside.
-- =============================================================================

create function public.arbitrage_donors_json()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'name', p.name, 'is_active', p.is_active, 'routing_enabled', p.routing_enabled,
           'health_status', p.health_status, 'provider_balance', p.provider_balance, 'currency', p.currency,
           'last_balance_sync', p.last_balance_sync, 'has_api_key', p.api_key_encrypted is not null,
           'active_offers', (select count(*) from provider_service_offers o where o.provider_id = p.id and o.is_active)
         ) order by p.name), '[]'::jsonb)
    from providers p
   where p.catalog_mode = 'linked_only';
$$;

create function public.admin_arbitrage_status(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_catalog_admin(p_actor);
  return jsonb_build_object(
    'primary', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'routing_enabled', p.routing_enabled,
                                                             'health_status', p.health_status) order by p.name), '[]'::jsonb)
                  from providers p where p.catalog_mode = 'publish'),
    'donors', arbitrage_donors_json());
end;
$$;

create function public.admin_set_arbitrage_mode(p_actor uuid, p_enabled boolean, p_readings jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_readings jsonb := coalesce(p_readings, '[]'::jsonb);
  v_changes  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  r          providers%rowtype;
  v_read     jsonb;
  v_ok       boolean;
  v_balance  numeric;
  v_currency text;
  v_health   provider_health_enum;
begin
  perform assert_catalog_admin(p_actor);
  if p_enabled is null then
    raise exception 'invalid_parameter_value: enabled is required' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(v_readings) <> 'array' then
    raise exception 'invalid_parameter_value: readings must be an array' using errcode = 'invalid_parameter_value';
  end if;

  for r in select * from providers where catalog_mode = 'linked_only' order by name for update loop
    if not p_enabled then
      if r.routing_enabled or r.health_status <> 'disabled' then
        update providers set routing_enabled = false, health_status = 'disabled' where id = r.id;
        v_changes := v_changes || jsonb_build_object('id', r.id, 'name', r.name,
          'routing_enabled', jsonb_build_array(r.routing_enabled, false), 'health_status', jsonb_build_array(r.health_status, 'disabled'));
      end if;
      continue;
    end if;

    if not r.is_active or r.api_key_encrypted is null then
      v_skipped := v_skipped || jsonb_build_object('id', r.id, 'name', r.name, 'reason', case when not r.is_active then 'inactive' else 'no_api_key' end);
      continue;
    end if;

    select e into v_read from jsonb_array_elements(v_readings) e where e->>'id' = r.id::text limit 1;
    v_ok := coalesce((v_read->>'ok')::boolean, false);
    v_balance := case when v_ok and (v_read->>'balance') ~ '^[0-9]{1,10}(\.[0-9]+)?$' then round((v_read->>'balance')::numeric, 4) end;
    v_currency := case when v_ok and (v_read->>'currency') ~ '^[A-Z]{3,10}$' then v_read->>'currency' end;
    -- no reading at all (the function did not get to ask) is treated as "ready": the monitor re-checks within a minute
    v_health := case when v_read is null or v_ok then 'healthy' else 'unavailable' end;

    update providers
       set routing_enabled   = true,
           health_status     = v_health,
           provider_balance  = coalesce(v_balance, provider_balance),
           last_balance_sync = case when v_balance is not null then now() else last_balance_sync end,
           currency          = coalesce(v_currency, currency)
     where id = r.id;
    v_changes := v_changes || jsonb_build_object('id', r.id, 'name', r.name,
      'routing_enabled', jsonb_build_array(r.routing_enabled, true), 'health_status', jsonb_build_array(r.health_status, v_health),
      'balance', v_balance);
  end loop;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'set_arbitrage_mode', case when p_enabled then 'on' else 'off' end,
          jsonb_build_object('enabled', p_enabled, 'changes', v_changes, 'skipped', v_skipped));

  return jsonb_build_object('enabled', p_enabled, 'skipped', v_skipped, 'donors', arbitrage_donors_json());
end;
$$;

revoke all on function public.arbitrage_donors_json() from public, anon, authenticated;
revoke all on function public.admin_arbitrage_status(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_arbitrage_mode(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.arbitrage_donors_json() to service_role;
grant execute on function public.admin_arbitrage_status(uuid) to service_role;
grant execute on function public.admin_set_arbitrage_mode(uuid, boolean, jsonb) to service_role;
