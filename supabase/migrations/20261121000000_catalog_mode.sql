-- Curated multi-provider routing: a provider either PUBLISHES its catalogue on the storefront (one storefront service per panel
-- service, the way SMM Center works) or is LINKED_ONLY: its catalogue is imported into provider_services (searchable, priced, guarded
-- against price anomalies) but nothing of it reaches the storefront except the panel services an admin links to an existing storefront
-- service as an additional offer. Switching routing on for such a provider no longer floods the storefront with its whole catalogue.
--
-- New providers default to linked_only. Providers whose catalogue is already on the storefront (auto-published services) keep publishing:
-- on production that is SMM Center; SMMPWR, SMMStone and RootPanel (nothing published) become linked_only.

alter table public.providers
  add column catalog_mode text not null default 'linked_only'
  constraint providers_catalog_mode_check check (catalog_mode in ('publish', 'linked_only'));

update public.providers p
   set catalog_mode = 'publish'
 where exists (select 1 from public.services s
                 join public.provider_services ps on ps.id = s.primary_provider_service_id
                where ps.provider_id = p.id and s.auto_published);

-- (latest definition taken from 20261103000000_admin_providers.sql)
create or replace function public.provider_admin_view(p providers)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'slug', p.slug, 'api_url', p.api_url, 'api_version', p.api_version,
    'is_active', p.is_active, 'routing_enabled', p.routing_enabled, 'priority', p.priority, 'catalog_mode', p.catalog_mode,
    'health_status', p.health_status, 'last_health_check', p.last_health_check,
    'provider_balance', p.provider_balance, 'currency', p.currency, 'last_balance_sync', p.last_balance_sync,
    'low_balance_threshold', p.low_balance_threshold, 'target_topup_balance', p.target_topup_balance,
    'reliability_penalty_multiplier', p.reliability_penalty_multiplier,
    'has_api_key', p.api_key_encrypted is not null,
    'created_at', p.created_at, 'updated_at', p.updated_at)
$$;

-- (latest definition taken from 20261027000000_payment_reconciliation.sql)
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
      'id', p.id, 'name', p.name, 'is_active', p.is_active, 'routing_enabled', p.routing_enabled, 'catalog_mode', p.catalog_mode,
      'health_status', p.health_status, 'last_health_check', p.last_health_check,
      'provider_balance', p.provider_balance, 'currency', p.currency, 'last_balance_sync', p.last_balance_sync,
      'low_balance_threshold', p.low_balance_threshold, 'target_topup_balance', p.target_topup_balance,
      'balance_alert_sent', p.balance_alert_sent, 'reliability_penalty_multiplier', p.reliability_penalty_multiplier,
      'allowed_destination_wallet', p.allowed_destination_wallet, 'payout_network', p.payout_network, 'payout_asset', p.payout_asset,
      'max_topup_per_tx', p.max_topup_per_tx, 'max_daily_topup', p.max_daily_topup,
      'topup_used_today', (select coalesce(sum(pp.amount), 0) from provider_payments pp
                            where pp.provider_id = p.id and pp.treasury_debited and not pp.treasury_reversed
                              and pp.validated_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc'))
    ) order by p.priority desc, p.name)
    from providers p), '[]'::jsonb);
end;
$$;

drop function public.admin_upsert_provider(uuid, uuid, text, text, text, text, integer, boolean, text);

-- (latest definition taken from 20261103000000_admin_providers.sql)
create or replace function public.admin_upsert_provider(
  p_actor             uuid,
  p_id                uuid    default null,
  p_name              text    default null,
  p_api_url           text    default null,
  p_api_key_encrypted text    default null,
  p_api_version       text    default null,
  p_priority          integer default null,
  p_is_active         boolean default null,
  p_currency          text    default null,
  p_catalog_mode      text    default null
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
  if p_catalog_mode is not null and p_catalog_mode not in ('publish', 'linked_only') then
    raise exception 'invalid_parameter_value: catalogMode must be publish or linked_only' using errcode = 'invalid_parameter_value';
  end if;

  if p_id is null then
    if v_name is null or v_url is null then
      raise exception 'invalid_parameter_value: name and apiUrl are required for a new provider' using errcode = 'invalid_parameter_value';
    end if;
    if exists (select 1 from providers where lower(name) = lower(v_name)) then
      raise exception 'name_taken: a provider with this name already exists' using errcode = 'unique_violation';
    end if;
    -- a new provider never receives orders until an admin switches routing on (routing_enabled defaults to false)
    -- a new provider sells nothing by itself: only the panel services an admin links to a storefront service (catalog_mode linked_only)
    insert into providers (name, api_url, api_key_encrypted, api_version, priority, is_active, currency, catalog_mode)
    values (v_name, v_url, p_api_key_encrypted, coalesce(p_api_version, 'v2'), coalesce(p_priority, 0), coalesce(p_is_active, true), coalesce(v_cur, 'USD'),
            coalesce(p_catalog_mode, 'linked_only'))
    returning * into v_new;

    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'create_provider', v_new.id::text, jsonb_build_object(
      'name', v_new.name, 'api_url', v_new.api_url, 'api_version', v_new.api_version, 'priority', v_new.priority,
      'is_active', v_new.is_active, 'catalog_mode', v_new.catalog_mode, 'api_key_set', p_api_key_encrypted is not null));
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
         catalog_mode      = coalesce(p_catalog_mode, catalog_mode),
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
    'catalog_mode', jsonb_build_array(v_old.catalog_mode, v_new.catalog_mode),
    'api_key_changed', p_api_key_encrypted is not null));
  return provider_admin_view(v_new) || jsonb_build_object('created', false);
end;
$$;

revoke all on function public.admin_upsert_provider(uuid, uuid, text, text, text, text, integer, boolean, text, text) from public, anon, authenticated;
grant execute on function public.admin_upsert_provider(uuid, uuid, text, text, text, text, integer, boolean, text, text) to service_role;
