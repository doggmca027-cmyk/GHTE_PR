-- A margin rule on a platform, a category or on everything re-prices thousands of services at once. The admin-pricing function computes the
-- new rates with the price engine (never in SQL) and hands them over here in chunks: one statement per chunk instead of one request per service.
--
-- Service role only (the function has already checked that the caller is an admin).

create function public.apply_service_rates(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'apply_service_rates: p_rows must be a JSON array' using errcode = '22023';
  end if;
  update services s
     set customer_rate_per_1000 = r.rate
    from jsonb_to_recordset(p_rows) as r(id uuid, rate numeric)
   where s.id = r.id
     and r.rate >= 0
     and s.customer_rate_per_1000 is distinct from r.rate;
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke all on function public.apply_service_rates(jsonb) from public, anon, authenticated;
grant execute on function public.apply_service_rates(jsonb) to service_role;
