-- =============================================================================
-- Phase 9: admin provider management (the SQL side of the admin-providers Edge Function)
--
-- Functions only: no table changes. The API key is encrypted by the Edge Function (AES-256-GCM, PROVIDER_KEY_SECRET: the same
-- envelope the workers decrypt with), so these functions only ever receive and store CIPHERTEXT and never return it:
--   admin_providers_list          every provider: metadata, balance, health, flags, has_api_key (never the key column)
--   admin_upsert_provider         create (no id) or update; a null api_key_encrypted keeps the stored key
--   admin_set_provider_routing    routing_enabled on / off
-- Each re-checks that the actor is an admin (assert_catalog_admin) and writes an audit entry that records THAT the key changed,
-- never the key. Service role only: clients can never reach them.
-- =============================================================================

-- the one shape every function returns: everything but api_key_encrypted
create function public.provider_admin_view(p providers)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'slug', p.slug, 'api_url', p.api_url, 'api_version', p.api_version,
    'is_active', p.is_active, 'routing_enabled', p.routing_enabled, 'priority', p.priority,
    'health_status', p.health_status, 'last_health_check', p.last_health_check,
    'provider_balance', p.provider_balance, 'currency', p.currency, 'last_balance_sync', p.last_balance_sync,
    'low_balance_threshold', p.low_balance_threshold, 'target_topup_balance', p.target_topup_balance,
    'reliability_penalty_multiplier', p.reliability_penalty_multiplier,
    'has_api_key', p.api_key_encrypted is not null,
    'created_at', p.created_at, 'updated_at', p.updated_at)
$$;

create function public.admin_providers_list(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_catalog_admin(p_actor);
  return coalesce((select jsonb_agg(provider_admin_view(p) order by p.priority desc, p.name) from providers p), '[]'::jsonb);
end;
$$;

create function public.admin_upsert_provider(
  p_actor             uuid,
  p_id                uuid    default null,
  p_name              text    default null,
  p_api_url           text    default null,
  p_api_key_encrypted text    default null,
  p_api_version       text    default null,
  p_priority          integer default null,
  p_is_active         boolean default null,
  p_currency          text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old providers%rowtype;
  v_new providers%rowtype;
  v_name text := nullif(btrim(p_name), '');
  v_url  text := nullif(btrim(p_api_url), '');
  v_cur  text := nullif(upper(btrim(p_currency)), '');
begin
  perform assert_catalog_admin(p_actor);

  if p_api_key_encrypted is not null and p_api_key_encrypted !~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' then
    raise exception 'invalid_parameter_value: the API key must be sent encrypted' using errcode = 'invalid_parameter_value';
  end if;
  if p_api_version is not null and p_api_version !~ '^v[0-9]+$' then
    raise exception 'invalid_parameter_value: apiVersion must look like v2' using errcode = 'invalid_parameter_value';
  end if;
  if v_cur is not null and v_cur !~ '^[A-Z]{3,10}$' then
    raise exception 'invalid_parameter_value: currency must be 3 to 10 capital letters' using errcode = 'invalid_parameter_value';
  end if;

  if p_id is null then
    if v_name is null or v_url is null then
      raise exception 'invalid_parameter_value: name and apiUrl are required for a new provider' using errcode = 'invalid_parameter_value';
    end if;
    if exists (select 1 from providers where lower(name) = lower(v_name)) then
      raise exception 'name_taken: a provider with this name already exists' using errcode = 'unique_violation';
    end if;
    -- a new provider never receives orders until an admin switches routing on (routing_enabled defaults to false)
    insert into providers (name, api_url, api_key_encrypted, api_version, priority, is_active, currency)
    values (v_name, v_url, p_api_key_encrypted, coalesce(p_api_version, 'v2'), coalesce(p_priority, 0), coalesce(p_is_active, true), coalesce(v_cur, 'USD'))
    returning * into v_new;

    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'create_provider', v_new.id::text, jsonb_build_object(
      'name', v_new.name, 'api_url', v_new.api_url, 'api_version', v_new.api_version, 'priority', v_new.priority,
      'is_active', v_new.is_active, 'api_key_set', p_api_key_encrypted is not null));
    return provider_admin_view(v_new) || jsonb_build_object('created', true);
  end if;

  select * into v_old from providers where id = p_id for update;
  if not found then
    raise exception 'provider_not_found' using errcode = 'no_data_found';
  end if;
  if v_name is not null and exists (select 1 from providers where lower(name) = lower(v_name) and id <> p_id) then
    raise exception 'name_taken: a provider with this name already exists' using errcode = 'unique_violation';
  end if;

  update providers
     set name              = coalesce(v_name, name),
         api_url           = coalesce(v_url, api_url),
         api_key_encrypted = coalesce(p_api_key_encrypted, api_key_encrypted),
         api_version       = coalesce(p_api_version, api_version),
         priority          = coalesce(p_priority, priority),
         is_active         = coalesce(p_is_active, is_active),
         currency          = coalesce(v_cur, currency),
         -- a provider that is switched off can never be a routing target (providers_routing_needs_active)
         routing_enabled   = case when coalesce(p_is_active, is_active) then routing_enabled else false end
   where id = p_id returning * into v_new;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (p_actor, 'update_provider', p_id::text, jsonb_build_object(
    'name', jsonb_build_array(v_old.name, v_new.name),
    'api_url', jsonb_build_array(v_old.api_url, v_new.api_url),
    'api_version', jsonb_build_array(v_old.api_version, v_new.api_version),
    'priority', jsonb_build_array(v_old.priority, v_new.priority),
    'is_active', jsonb_build_array(v_old.is_active, v_new.is_active),
    'routing_enabled', jsonb_build_array(v_old.routing_enabled, v_new.routing_enabled),
    'currency', jsonb_build_array(v_old.currency, v_new.currency),
    'api_key_changed', p_api_key_encrypted is not null));
  return provider_admin_view(v_new) || jsonb_build_object('created', false);
end;
$$;

create function public.admin_set_provider_routing(p_actor uuid, p_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old providers%rowtype;
  v_new providers%rowtype;
begin
  perform assert_catalog_admin(p_actor);
  if p_id is null or p_enabled is null then
    raise exception 'invalid_parameter_value: id and enabled are required' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_old from providers where id = p_id for update;
  if not found then
    raise exception 'provider_not_found' using errcode = 'no_data_found';
  end if;
  if p_enabled and not v_old.is_active then
    raise exception 'provider_inactive: an inactive provider cannot receive orders' using errcode = 'invalid_parameter_value';
  end if;
  if p_enabled and v_old.api_key_encrypted is null then
    raise exception 'no_api_key: save the API key of the provider before switching routing on' using errcode = 'invalid_parameter_value';
  end if;

  update providers set routing_enabled = p_enabled where id = p_id returning * into v_new;
  if v_old.routing_enabled is distinct from v_new.routing_enabled then
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'set_provider_routing', p_id::text, jsonb_build_object('routing_enabled', jsonb_build_array(v_old.routing_enabled, v_new.routing_enabled)));
  end if;
  return provider_admin_view(v_new);
end;
$$;

revoke all on function public.provider_admin_view(providers) from public, anon, authenticated;
revoke all on function public.admin_providers_list(uuid) from public, anon, authenticated;
revoke all on function public.admin_upsert_provider(uuid, uuid, text, text, text, text, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_set_provider_routing(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.provider_admin_view(providers) to service_role;
grant execute on function public.admin_providers_list(uuid) to service_role;
grant execute on function public.admin_upsert_provider(uuid, uuid, text, text, text, text, integer, boolean, text) to service_role;
grant execute on function public.admin_set_provider_routing(uuid, uuid, boolean) to service_role;
