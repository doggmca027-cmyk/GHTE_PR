-- =============================================================================
-- Phase 1F: provider balance thresholds + low-balance alert lock + admin provider config
--
-- providers.provider_balance / last_balance_sync already exist (and mirror the legacy balance pair); the
-- health monitor now writes them on every successful check. balance_alert_sent is the alert LOCK: it flips
-- to true when a low-balance alert is raised and back to false once the balance is above the threshold again,
-- so an admin is told once per dip, not once per cron tick.
-- =============================================================================
alter table public.providers
  add column low_balance_threshold numeric(14,4) not null default 10.0000,
  add column target_topup_balance  numeric(14,4) not null default 100.0000,
  add column balance_alert_sent    boolean       not null default false,
  add constraint providers_threshold_nonneg check (low_balance_threshold >= 0),
  add constraint providers_topup_not_below_threshold check (target_topup_balance >= low_balance_threshold);

-- -----------------------------------------------------------------------------
-- Admin RPCs (same pattern as the other admin_* functions: SECURITY DEFINER + require_admin()).
-- The API key (api_key_encrypted) is never returned.
-- -----------------------------------------------------------------------------
create function public.admin_list_providers()
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
      'id', p.id, 'name', p.name, 'is_active', p.is_active, 'routing_enabled', p.routing_enabled,
      'health_status', p.health_status, 'last_health_check', p.last_health_check,
      'provider_balance', p.provider_balance, 'currency', p.currency, 'last_balance_sync', p.last_balance_sync,
      'low_balance_threshold', p.low_balance_threshold, 'target_topup_balance', p.target_topup_balance,
      'balance_alert_sent', p.balance_alert_sent
    ) order by p.priority desc, p.name)
    from providers p), '[]'::jsonb);
end;
$$;

create function public.admin_update_provider_config(
  p_provider_id           uuid,
  p_low_balance_threshold numeric default null,
  p_target_topup_balance  numeric default null,
  p_routing_enabled       boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  old_p   providers%rowtype;
  new_p   providers%rowtype;
begin
  if p_low_balance_threshold is null and p_target_topup_balance is null and p_routing_enabled is null then
    raise exception 'nothing to update' using errcode = 'invalid_parameter_value';
  end if;
  if (p_low_balance_threshold is not null and (p_low_balance_threshold < 0 or p_low_balance_threshold > 1000000000))
     or (p_target_topup_balance is not null and (p_target_topup_balance < 0 or p_target_topup_balance > 1000000000)) then
    raise exception 'balance values must be between 0 and 1000000000' using errcode = 'invalid_parameter_value';
  end if;

  select * into old_p from providers where id = p_provider_id for update;
  if not found then
    raise exception 'provider % not found', p_provider_id using errcode = 'no_data_found';
  end if;

  if coalesce(round(p_target_topup_balance, 4), old_p.target_topup_balance)
       < coalesce(round(p_low_balance_threshold, 4), old_p.low_balance_threshold) then
    raise exception 'top-up target must not be below the low-balance threshold' using errcode = 'invalid_parameter_value';
  end if;
  if p_routing_enabled is true and not old_p.is_active then
    raise exception 'an inactive provider cannot receive orders' using errcode = 'invalid_parameter_value';
  end if;

  update providers
     set low_balance_threshold = coalesce(round(p_low_balance_threshold, 4), low_balance_threshold),
         target_topup_balance  = coalesce(round(p_target_topup_balance, 4), target_topup_balance),
         routing_enabled       = coalesce(p_routing_enabled, routing_enabled)
   where id = p_provider_id returning * into new_p;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'update_provider_config', p_provider_id::text, jsonb_build_object(
    'low_balance_threshold', jsonb_build_array(old_p.low_balance_threshold, new_p.low_balance_threshold),
    'target_topup_balance',  jsonb_build_array(old_p.target_topup_balance, new_p.target_topup_balance),
    'routing_enabled',       jsonb_build_array(old_p.routing_enabled, new_p.routing_enabled)));

  return jsonb_build_object('id', new_p.id, 'low_balance_threshold', new_p.low_balance_threshold,
                            'target_topup_balance', new_p.target_topup_balance, 'routing_enabled', new_p.routing_enabled);
end;
$$;

revoke all on function public.admin_list_providers(), public.admin_update_provider_config(uuid, numeric, numeric, boolean)
  from public, anon;
grant execute on function public.admin_list_providers(), public.admin_update_provider_config(uuid, numeric, numeric, boolean)
  to authenticated, service_role;
