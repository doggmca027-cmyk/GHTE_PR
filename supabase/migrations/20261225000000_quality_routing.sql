-- =============================================================================
-- Quality before price on the cards that promise it
--
-- The router and the price followed the cheapest offer of a card, so a card sold as HQ could go to bots at $0.05 instead of the real thing at
-- $0.80. Now (offer-quality.ts, routing.ts, service-cost.ts): on a card whose name promises refill, HQ, real, organic or non-drop, an offer of a
-- premium panel goes first, then an offer whose own name makes such a promise, then the rest, each group by cost. The card's price is built on
-- the offer that wins, so the price shown is what the order pays. Every other card still goes to the cheapest offer.
--
-- Here: providers.is_premium, the SQL twins of the name rules, and the three places SQL chooses an offer:
--   * refresh_arbitrage_candidates links a premium panel's service to a quality card even when it is dearer (it only ever linked cheaper ones,
--     so a premium panel would never have received an offer); the same product rules hold, and more than 50 times the card's cheapest offer is
--     not the same product
--   * hub_reroute_order (the admin's "another provider" button) keeps to the best quality that can pay
--   * get_admin_pricing_view shows the offer the router picks
-- =============================================================================

alter table public.providers
  add column if not exists is_premium boolean not null default false;

comment on column public.providers.is_premium is
  'A premium panel: its offers go first on a card that promises quality (offer-quality.ts), even when they cost more.';

update public.providers set is_premium = true where name in ('Secsers', 'MoreThanPanel') and not is_premium;

-- The patterns of offer-quality.ts (tests/provider-rotation.test.ts runs both over the same names). \y is what \b is in JavaScript. No SET on these:
-- a plain immutable SQL function is inlined, and they run once per offer in the queries below.
create or replace function public.service_name_no_guarantee(p_name text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_name, '') ~* '\y(?:no|non|not|without)[\s-]*(?:refill|guarantee)|\ynorefill|\yrefill\s*[:=-]?\s*(?:no|none|not)\y(?![\s-]*drop)|\yrefill\s*[:=-]?\s*0(?![\d-])|(?<!\y(?:no|non|chat|without|anti)[\s-])\ybots?\y(?![\s-]*starts?)';
$$;

create or replace function public.service_name_promises(p_name text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_name, '') ~* '\yrefill|\yguarantee|\yu?hq\y|\yhigh[\s-]*quality|\ynon[\s-]*drop|\yno[\s-]*drops?\y|\ydrops?\s*:\s*no\y|\yreal\y(?![\s-]*time)|\yorganic';
$$;

create or replace function public.service_name_is_quality(p_name text)
returns boolean
language sql
immutable
as $$
  select not public.service_name_no_guarantee(p_name) and public.service_name_promises(p_name);
$$;

-- 0 on a card that promises nothing, as in offer-quality.ts qualityScorer
create or replace function public.offer_quality_score(p_service_name text, p_panel_name text, p_premium boolean)
returns integer
language sql
immutable
as $$
  select case
    when not public.service_name_is_quality(p_service_name) or public.service_name_no_guarantee(p_panel_name) then 0
    when p_premium then 2
    when public.service_name_promises(p_panel_name) then 1
    else 0
  end;
$$;

-- catalog-publish.ts isLinkAndQuantity: the order form sends a link and a quantity. A panel's Custom Comments, Subscriptions, Poll, Mentions or SEO
-- service needs more than that and refuses the order; a Package is priced per package, not per 1000.
create or replace function public.service_takes_link_and_quantity(p_type text, p_name text)
returns boolean
language sql
immutable
as $$
  select lower(btrim(coalesce(p_type, 'Default'))) = 'default'
      or (lower(btrim(p_type)) = any (array[
    'followers', 'live viewers', 'traffic', 'views', 'likes', 'track & playlist plays', 'members', 'video & shorts views', 'post reactions', 'post views',
    'video likes', 'shares', 'page & post likes', 'post & video views', 'plays', 'page & profile followers', 'reposts', 'saves', 'subscribers',
    'channel subscribers', 'stories', 'live stream viewers', 'group members', 'video views', 'reactions', 'watch time', 'listeners', 'channel members',
    'upvotes', 'server members', 'monthly listeners', 'post & profile clicks', 'installs & downloads', 'story & spotlight views', 'connections',
    'channel followers', 'repins', 'playlist adds', 'clicks', 'spotlight likes & favorites', 'reblogs', 're-ups', 'community subscribers', 'pin views',
    'spotlight reposts', 'music plays'
  ]) and coalesce(p_name, '') !~* 'custom|mention|package|\ypoll|\yvotes?\y|hashtag|subscription');
$$;

revoke all on function public.service_name_no_guarantee(text), public.service_name_promises(text), public.service_name_is_quality(text), public.offer_quality_score(text, text, boolean), public.service_takes_link_and_quantity(text, text) from public, anon, authenticated;
grant execute on function public.service_name_no_guarantee(text), public.service_name_promises(text), public.service_name_is_quality(text), public.offer_quality_score(text, text, boolean), public.service_takes_link_and_quantity(text, text) to service_role;

-- -----------------------------------------------------------------------------
-- The matcher: the same as 20261216000000 except for the premium panels (svc.quality, dn.is_premium, the arb_pairs condition) and that a service
-- the order form cannot order is not linked at all (dn)
-- -----------------------------------------------------------------------------
create or replace function public.refresh_arbitrage_candidates(p_min_saving numeric default 0.15, p_max_links integer default 2000, p_min_interval_minutes integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_max_saving  constant numeric := 0.80;
  c_max_premium constant numeric := 50;
  v_linked      integer := 0;
  v_anomalies   integer := 0;
  v_unlinked    integer := 0;
  v_dropped     integer := 0;
  r             record;
  v_offer       uuid;
  v_result      jsonb;
begin
  -- one matcher at a time, and not more often than asked
  if not exists (
       select 1 from arbitrage_state
        where id = 1 and (refreshed_at is null or refreshed_at < now() - make_interval(mins => greatest(coalesce(p_min_interval_minutes, 0), 0)))
        for update skip locked) then
    return jsonb_build_object('skipped', true);
  end if;

  -- a. the links made by the autopilot earlier, checked again: one that no longer fits is switched off and rejected
  for r in
    select c.id, c.offer_id,
           array_remove(array[
             case when service_package_kind(s.name) is distinct from coalesce(d.fp_kind, service_package_kind(d.name)) then 'package' end,
             case when not arbitrage_tags_fit(f ->> 'tags', d.fp_tags) then 'details' end,
             case when not arbitrage_refill_fits(f ->> 'refill', d.fp_refill) then 'refill' end,
             case when coalesce(src.rate_per_1000, other.best) is not null and d.rate_per_1000 < coalesce(src.rate_per_1000, other.best) * (1 - c_max_saving) then 'price_anomaly' end
           ], null) why
      from arbitrage_candidates c
      join services s on s.id = c.service_id
      join provider_services d on d.id = c.provider_service_id
      cross join lateral (select service_fingerprint(s.name) f) fp
      left join provider_services src on src.id = s.primary_provider_service_id and src.id <> d.id
      left join lateral (select min(o.cost_per_1000) best from provider_service_offers o
                          where o.service_id = c.service_id and o.is_active and o.id is distinct from c.offer_id) other on true
     where c.status = 'auto_linked'
  loop
    continue when cardinality(r.why) = 0;
    if r.offer_id is not null then
      -- an offer an order went through stays (orders keep pointing at it), switched off; any other is removed
      if exists (select 1 from orders o where o.provider_offer_id = r.offer_id) then
        update provider_service_offers set is_active = false where id = r.offer_id;
      else
        delete from provider_service_offers where id = r.offer_id;
      end if;
    end if;
    update arbitrage_candidates set status = 'rejected', offer_id = null, mismatches = r.why, decided_at = now(), updated_at = now() where id = r.id;
    v_unlinked := v_unlinked + 1;
  end loop;

  -- b. the same product: same base and kind, the same package numbers, our facts stated by the donor and no worse quality, its guarantee
  --    at least ours, its limits taking our orders. The tag sets are computed once per service and per donor service.
  drop table if exists pg_temp.arb_pairs;
  create temp table arb_pairs on commit drop as
  with svc as materialized (
    select x.id, x.mn, x.mx, x.srefill, x.f, x.k, x.best, x.quality, coalesce(x.own, x.best) own,
           arbitrage_num_tags(x.f ->> 'tags') num, arbitrage_required_tags(x.f ->> 'tags') req, string_to_array(coalesce(x.f ->> 'tags', ''), ',') alltags
      from (select s.id, s.min_quantity mn, s.max_quantity mx, s.refill_supported srefill, service_fingerprint(s.name) f, service_package_kind(s.name) k,
                   service_name_is_quality(s.name) quality,
                   (select min(o.cost_per_1000) from provider_service_offers o where o.service_id = s.id and o.is_active) best,
                   (select ps.rate_per_1000 from provider_services ps where ps.id = s.primary_provider_service_id and ps.rate_per_1000 > 0) own
              from services s
             where s.is_active) x
     where x.best is not null and x.f ->> 'base' <> ''
  ),
  dn as materialized (
    select d.id, d.provider_id, d.fp_base, coalesce(d.fp_kind, 'single') k, d.fp_refill, d.rate_per_1000, d.min_quantity, d.max_quantity,
           d.refill_supported, p.is_premium, arbitrage_num_tags(d.fp_tags) num, string_to_array(coalesce(d.fp_tags, ''), ',') alltags, arbitrage_strict_tags(d.fp_tags) strict
      from provider_services d
      join providers p on p.id = d.provider_id and p.is_active and p.routing_enabled
     where d.is_active and d.rate_per_1000 > 0 and d.fp_base in (select f ->> 'base' from svc)
       and service_takes_link_and_quantity(d.service_type, d.name)
  )
  select s.id service_id, d.id ps_id, d.provider_id, s.best, s.own, d.rate_per_1000 cost
    from svc s
    join dn d on d.fp_base = s.f ->> 'base' and d.k = s.k
   where (d.rate_per_1000 <= s.best * (1 - p_min_saving) or (d.is_premium and s.quality and d.rate_per_1000 <= s.best * c_max_premium))
     and d.min_quantity <= s.mn and d.max_quantity >= s.mx
     and d.num = s.num and s.req <@ d.alltags and d.strict <@ s.alltags
     and arbitrage_refill_fits(s.f ->> 'refill', d.fp_refill) and not (s.srefill and not d.refill_supported)
     -- one offer per provider and service
     and not exists (select 1 from provider_service_offers x where x.service_id = s.id and x.provider_id = d.provider_id);

  -- what an admin (or this autopilot) already decided against stays out
  delete from arb_pairs a using arbitrage_candidates c
   where c.service_id = a.service_id and c.provider_service_id = a.ps_id
     and (c.status = 'rejected' or (c.status in ('auto_linked', 'approved') and c.offer_id is null));

  -- c. the same product but more than 80% cheaper: another package, rejected at once
  insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status, decided_at)
  select service_id, ps_id, provider_id, best, cost, round(1 - cost / best, 4), '{price_anomaly}', 'rejected', now()
    from arb_pairs
   where cost < own * (1 - c_max_saving)
  on conflict (service_id, provider_service_id) do update
    set status = 'rejected', mismatches = '{price_anomaly}', current_cost = excluded.current_cost, donor_cost = excluded.donor_cost,
        saving = excluded.saving, decided_at = now(), updated_at = now()
    where arbitrage_candidates.status = 'pending';
  get diagnostics v_anomalies = row_count;

  -- d. the same product, 15% to 80% cheaper, or a premium panel's on a quality card: linked now (the cheapest per service and donor provider)
  for r in
    select distinct on (a.service_id, a.provider_id) a.*, ps.min_quantity, ps.max_quantity, ps.refill_supported, ps.cancel_supported
      from arb_pairs a join provider_services ps on ps.id = a.ps_id
     where a.cost >= a.own * (1 - c_max_saving)
     order by a.service_id, a.provider_id, a.cost, a.ps_id
     limit p_max_links
  loop
    insert into provider_service_offers
      (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported,
       supports_partial, is_active, routing_score)
    values (r.service_id, r.provider_id, r.ps_id, r.cost, r.min_quantity, r.max_quantity, r.refill_supported, r.cancel_supported,
            false, true, 0)
    returning id into v_offer;
    insert into arbitrage_candidates (service_id, provider_service_id, provider_id, current_cost, donor_cost, saving, mismatches, status, offer_id, decided_at)
    values (r.service_id, r.ps_id, r.provider_id, r.best, r.cost, round(1 - r.cost / r.best, 4), '{}', 'auto_linked', v_offer, now())
    on conflict (service_id, provider_service_id) do update
      set status = 'auto_linked', offer_id = excluded.offer_id, current_cost = excluded.current_cost, donor_cost = excluded.donor_cost,
          saving = excluded.saving, mismatches = '{}', decided_at = now(), updated_at = now();
    v_linked := v_linked + 1;
  end loop;

  -- e. no manual queue: whatever is still pending is dropped (it is either linked above or not the same product)
  delete from arbitrage_candidates where status = 'pending';
  get diagnostics v_dropped = row_count;

  v_result := jsonb_build_object('auto_linked', v_linked, 'price_anomalies', v_anomalies, 'unlinked', v_unlinked, 'dropped', v_dropped,
                                 'pending', 0);
  update arbitrage_state set refreshed_at = now(), last_result = v_result where id = 1;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- The admin's "another provider" button: the best quality that can pay for the order now, then the cheapest
-- -----------------------------------------------------------------------------
create or replace function public.hub_reroute_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o     orders%rowtype;
  r     record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found or o.status <> 'paid' or o.awaiting_funds_since is null then
    return jsonb_build_object('ok', false, 'reason', 'not_waiting');
  end if;
  -- another provider of the card that can pay for it now; never one that would sell at a loss
  select x.id offer_id, x.provider_id, p.name, round(x.cost_per_1000 * o.quantity / 1000, 4) cost, p.provider_balance balance
    into r
    from provider_service_offers x
    join services s on s.id = x.service_id
    join provider_services ps on ps.id = x.provider_service_id and ps.is_active
    join providers p on p.id = x.provider_id and p.is_active and p.routing_enabled and p.health_status = 'healthy'
   where x.service_id = o.service_id and x.is_active and x.provider_id <> o.provider_id
     and o.quantity / greatest(coalesce(o.runs, 1), 1) between x.min_quantity and x.max_quantity
     and round(x.cost_per_1000 * o.quantity / 1000, 4) <= o.charge_amount
     and p.last_balance_sync is not null and p.provider_balance >= round(x.cost_per_1000 * o.quantity / 1000, 4)
   order by offer_quality_score(s.name, ps.name, p.is_premium) desc, x.cost_per_1000, x.id
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_funded_provider');
  end if;
  perform set_config('app.order_hub', 'reroute', true);
  update orders
     set provider_offer_id = r.offer_id, provider_id = r.provider_id, cost_amount = r.cost, profit_amount = charge_amount - r.cost
   where id = o.id;
  perform set_config('app.order_hub', '', true);
  return jsonb_build_object('ok', true, 'provider_id', r.provider_id, 'provider', r.name, 'cost', r.cost, 'balance', r.balance);
end;
$$;

-- -----------------------------------------------------------------------------
-- The admin pricing grid: the offer the router picks
-- -----------------------------------------------------------------------------
create or replace function public.get_admin_pricing_view()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_margin numeric(14,4);
begin
  perform require_admin();
  select discount_min_margin_per_1000 into v_margin from platform_settings where id = 1;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'service_id', s.id,
      'name', s.name,
      'category_id', c.id,
      'category', c.name,
      'platform', pl.slug,
      'customer_rate_per_1000', s.customer_rate_per_1000,
      'best_offer_cost', b.cost_per_1000,
      'best_offer_effective_cost', b.effective_cost,
      'base_offer_cost', base.cost_per_1000,
      'margin_absolute', case when b.cost_per_1000 is null then null
                              else round(s.customer_rate_per_1000 - b.cost_per_1000, 4) end,
      -- the most any combination of tier and promo discount can take off the list price before cost + minimum margin
      'max_discount_percent', case when base.cost_per_1000 is null or s.customer_rate_per_1000 <= 0 then null
                                   else round(greatest(s.customer_rate_per_1000 - base.cost_per_1000 - v_margin, 0) / s.customer_rate_per_1000 * 100, 2) end
    ) order by pl.sort_order, pl.slug, c.name, s.name)
    from services s
    join categories c on c.id = s.category_id
    join platforms pl on pl.id = c.platform_id
    left join lateral (
      select o.cost_per_1000,
             round(o.cost_per_1000 * p.reliability_penalty_multiplier, 4) as effective_cost
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active
         and ps.is_active
         and p.is_active and p.routing_enabled and p.health_status = 'healthy'
       order by offer_quality_score(s.name, ps.name, p.is_premium) desc, o.cost_per_1000 * p.reliability_penalty_multiplier asc, o.routing_score desc, o.id asc
       limit 1
    ) b on true
    left join lateral (
      select min(o.cost_per_1000) as cost_per_1000
        from provider_service_offers o
        join providers p on p.id = o.provider_id
        join provider_services ps on ps.id = o.provider_service_id
       where o.service_id = s.id
         and o.is_active and ps.is_active and p.is_active and p.routing_enabled
    ) base on true
    where s.is_active), '[]'::jsonb);
end;
$$;

revoke all on function public.get_admin_pricing_view() from public, anon;
grant execute on function public.get_admin_pricing_view() to authenticated, service_role;
