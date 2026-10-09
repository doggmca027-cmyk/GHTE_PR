-- The hourly sync of a catalogue of tens of thousands of services must not send every row back every hour. Rows that did not change only need
--    their last_synced_at refreshed ("the panel still lists it"): one statement inside the database. Service role only.
create function public.touch_provider_services(p_provider_id uuid, p_at timestamptz, p_skip uuid[] default '{}')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  update provider_services
     set last_synced_at = p_at
   where provider_id = p_provider_id
     and is_active
     and (last_synced_at is null or last_synced_at < p_at)
     and not (id = any (coalesce(p_skip, '{}')));
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke all on function public.touch_provider_services(uuid, timestamptz, uuid[]) from public, anon, authenticated;
grant execute on function public.touch_provider_services(uuid, timestamptz, uuid[]) to service_role;

