-- =============================================================================
-- Phase 1J: platform kill switches
--
-- One row of global emergency switches. The Edge Functions read it with the service role BEFORE any money moves:
--   place-order     refuses new orders when maintenance_mode or NOT global_orders_enabled
--   create-deposit  refuses new deposits when maintenance_mode or NOT global_payments_enabled
-- verify-deposit is deliberately NOT gated: a deposit the user already paid on-chain must still be credited.
-- Clients can never read or write this table; admins change it through update_platform_settings() (admin-settings
-- Edge Function), and every change is audited.
-- =============================================================================
create table public.platform_settings (
  id                      integer primary key default 1 check (id = 1),
  global_orders_enabled   boolean not null default true,
  global_payments_enabled boolean not null default true,
  maintenance_mode        boolean not null default false,
  updated_by              uuid references public.users(id) on delete set null,
  updated_at              timestamptz not null default now()
);
insert into public.platform_settings (id, global_orders_enabled, global_payments_enabled, maintenance_mode)
values (1, true, true, false);

-- Exactly one row, ever.
create trigger trg_platform_settings_no_delete before delete on public.platform_settings
  for each row execute function public.forbid_mutation();
create trigger trg_platform_settings_no_truncate before truncate on public.platform_settings
  for each statement execute function public.forbid_mutation();

alter table public.platform_settings enable row level security;
revoke all on table public.platform_settings from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Admin write path. A NULL argument leaves that switch as it is, so the UI can flip one switch at a time without
-- racing another admin's change to a different one. The row is locked while it is read and written.
-- -----------------------------------------------------------------------------
create function public.update_platform_settings(
  p_orders_enabled      boolean default null,
  p_payments_enabled    boolean default null,
  p_maintenance_mode    boolean default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  v_old   platform_settings%rowtype;
  v_new   platform_settings%rowtype;
begin
  if p_orders_enabled is null and p_payments_enabled is null and p_maintenance_mode is null then
    raise exception 'nothing to update' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_old from platform_settings where id = 1 for update;

  update platform_settings
     set global_orders_enabled   = coalesce(p_orders_enabled, global_orders_enabled),
         global_payments_enabled = coalesce(p_payments_enabled, global_payments_enabled),
         maintenance_mode        = coalesce(p_maintenance_mode, maintenance_mode),
         updated_by              = v_admin,
         updated_at              = now()
   where id = 1
   returning * into v_new;

  insert into admin_audit_log (admin_id, action, target_id, details)
  values (v_admin, 'update_platform_settings', '1', jsonb_build_object(
    'global_orders_enabled',   jsonb_build_array(v_old.global_orders_enabled, v_new.global_orders_enabled),
    'global_payments_enabled', jsonb_build_array(v_old.global_payments_enabled, v_new.global_payments_enabled),
    'maintenance_mode',        jsonb_build_array(v_old.maintenance_mode, v_new.maintenance_mode)));

  return jsonb_build_object(
    'global_orders_enabled',   v_new.global_orders_enabled,
    'global_payments_enabled', v_new.global_payments_enabled,
    'maintenance_mode',        v_new.maintenance_mode,
    'updated_at',              v_new.updated_at);
end;
$$;

revoke all on function public.update_platform_settings(boolean, boolean, boolean) from public, anon;
grant execute on function public.update_platform_settings(boolean, boolean, boolean) to authenticated, service_role;
