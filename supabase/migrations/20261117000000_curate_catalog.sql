-- Catalogue curation: take the storefront down to services that carry a guarantee, plus the kinds of service that cannot have one.
--
-- A storefront service stays active when its name says it is
--   * a guarantee: premium, 0% drop, non drop / no drops, guaranteed, high retention, targeted, real, or a refill that is not "no refill"
--   * a kind that has no drop or refill by nature: views, reactions, impressions, reach, traffic, plays, streams, shares, reposts,
--     saves, votes, polls, comments, viewers (the high-margin "magnet" services of the pricing strategy)
-- Everything else that is active (followers, likes, members with "no refill" and no other guarantee) is switched off.
--
-- Matching is by WHOLE WORD (Postgres \y), never by substring: "[no refill]" is not a refill, "10% drop" is not "0% drop",
-- and "real" is not found inside "unreal". Only rows that are active now are touched, so a service an admin or the anomaly guard
-- already switched off is never reactivated. Nothing is deleted; the previous set of active ids was saved before this migration
-- (reports/curation/active-service-ids-before-curation.json) and restoring is one UPDATE.
--
-- Safety valve: when the storefront had 30 or more active services and fewer than 30 would be left, the whole migration is rolled
-- back. On a fresh database (no services) it is a no-op, so CI is not affected.

do $$
declare
  v_before integer;
  v_after  integer;
begin
  select count(*) into v_before from public.services where is_active;

  update public.services s
     set is_active = false
   where s.is_active
     and not (
          s.name ~* '\ypremium\y'
       or s.name ~* '(^|[^0-9])0% drop'
       or s.name ~* '\ynon[ -]?drop'
       or s.name ~* '\yno drops?\y'
       or s.name ~* '\yguarantee(d)?\y'
       or s.name ~* '\yhigh retention\y'
       or s.name ~* '\ytargeted\y'
       or s.name ~* '\yreal\y'
       or (s.name ~* '\yrefill\y' and s.name !~* '\yno[ -]?refill\y')
       or s.name ~* '\y(views?|reactions?|impressions|reach|traffic|plays?|streams?|shares?|reposts?|saves?|votes?|poll|comments?|viewers)\y'
     );

  select count(*) into v_after from public.services where is_active;
  if v_before >= 30 and v_after < 30 then
    raise exception 'catalogue curation would leave % active services (was %); aborted', v_after, v_before;
  end if;
end
$$;
