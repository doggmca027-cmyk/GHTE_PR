-- Supabase grants EXECUTE on every new public function to anon and authenticated by default, and
-- PostgREST exposes callable functions as /rest/v1/rpc/<name>. Only the audited admin RPCs and the
-- service-role functions are meant to be reachable, so close the one helper that was left open.
-- (scripts/check-supabase.ts now fails the build if any other function is exposed.)

revoke all on function public.is_valid_order_transition(public.order_status_enum, public.order_status_enum)
  from public, anon, authenticated;
grant execute on function public.is_valid_order_transition(public.order_status_enum, public.order_status_enum)
  to service_role;
