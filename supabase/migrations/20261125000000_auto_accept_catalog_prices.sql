-- =============================================================================
-- Autonomous catalogue pricing (owner decision, 2026-10-16).
--
-- Until now a provider price move of more than 30% was held back as a "catalog anomaly": the provider service kept its old price and
-- every offer on it was switched off until an admin accepted the new price. Services stayed on the storefront without a usable offer.
-- From now on sync-catalog applies every price move at once and re-prices the storefront service through the price rules in the same
-- run (the markup is kept). Only impossible data (no valid price or limits) is still held back.
--
-- 1. clear_catalog_anomalies(provider, keep): what sync-catalog calls after writing a provider's catalogue: offers suspended by a
--    guard come back on when their provider service is active again (except those still impossible in this run). Service role only.
-- 2. One-time: the offers frozen today get the last price the sync observed (anomaly_observed, the same values
--    accept_catalog_anomaly() would apply) and are switched back on. Their storefront prices are raised / lowered by the next sync run,
--    which runs right after this deploy; until then routing does not use an offer that costs more than the customer pays.
-- =============================================================================

create function public.clear_catalog_anomalies(p_provider_id uuid, p_keep uuid[] default '{}')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update provider_service_offers o
     set is_active = true, anomaly_detected = false, anomaly_reason = null, anomaly_observed = null, anomaly_detected_at = null
    from provider_services ps
   where ps.id = o.provider_service_id
     and o.provider_id = p_provider_id
     and o.anomaly_detected
     and ps.is_active
     and not (o.provider_service_id = any (coalesce(p_keep, '{}')));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.clear_catalog_anomalies(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.clear_catalog_anomalies(uuid, uuid[]) to service_role;

-- ---- one-time: unfreeze what the old guard froze -----------------------------------------------------------------------------
do $$
declare
  r          record;
  v_services integer := 0;
  v_offers   integer := 0;
  v_count    integer;
begin
  for r in
    select distinct on (o.provider_service_id)
           o.provider_service_id,
           (o.anomaly_observed ->> 'rate')::numeric  as rate,
           (o.anomaly_observed ->> 'min')::integer   as min_q,
           (o.anomaly_observed ->> 'max')::integer   as max_q
      from provider_service_offers o
      join provider_services ps on ps.id = o.provider_service_id
     where o.anomaly_detected
       and ps.is_active
       and o.anomaly_observed is not null
     order by o.provider_service_id, o.anomaly_detected_at desc nulls last
  loop
    -- the same validity rule as accept_catalog_anomaly(): impossible values stay frozen
    continue when r.rate is null or r.rate < 0 or r.min_q is null or r.min_q <= 0 or r.max_q is null or r.max_q < r.min_q;
    update provider_services set rate_per_1000 = round(r.rate, 4), min_quantity = r.min_q, max_quantity = r.max_q
     where id = r.provider_service_id;
    update provider_service_offers
       set is_active = true, anomaly_detected = false, anomaly_reason = null, anomaly_observed = null, anomaly_detected_at = null,
           cost_per_1000 = round(r.rate, 4), min_quantity = r.min_q, max_quantity = r.max_q
     where provider_service_id = r.provider_service_id and anomaly_detected;
    get diagnostics v_count = row_count;
    v_services := v_services + 1;
    v_offers := v_offers + v_count;
  end loop;
  raise notice 'auto-accept catalog prices: % provider services, % offers unfrozen', v_services, v_offers;
end;
$$;
