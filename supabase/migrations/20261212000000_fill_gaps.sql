-- =============================================================================
-- Donors fill the gaps of the storefront
--
-- Since the compaction (20261207000000) a donor (catalog_mode 'linked_only') only backs the reference cards. Dozens of platforms of the
-- registry therefore show nothing although a donor sells them (Roblox, W.TV, Loco, Topick... live at RootPanel only), and some actions of
-- covered platforms are missing (Twitter Spaces, Twitch clip views).
--
-- providers.fill_gaps: such a donor also publishes into the places the reference catalogue does not sell: a platform without a single
-- reference service, or an action of a covered platform no reference service sells. The sync decides the places and picks at most ten
-- services per place and run (catalog-publish.ts chooseGapFillers); this function writes them:
--   1. a donor service that is exactly an active card of the same platform (same fingerprint) is not published again: it backs that card as
--      an offer when its limits fit (one offer per provider and card)
--   2. twins among the rows: the cheapest one becomes the card
--   3. the rest is published like any canonical donor service (publish_provider_services; the sync then prices it with the rules)
--   4. a card of these rows hidden by the compaction comes back, with its category
-- =============================================================================

alter table public.providers
  add column if not exists fill_gaps boolean not null default false;

comment on column public.providers.fill_gaps is
  'A donor (linked_only) that also publishes into the places the reference catalogue does not sell (empty platforms and actions).';

update public.providers set fill_gaps = true where name in ('JAP', 'SMMFollows', 'SMMProvider', 'RootPanel') and not fill_gaps;

-- What the reference catalogue sells: platform, category and service name of every active reference service (one json value, so the
-- API's row limit does not cut it).
create or replace function public.storefront_reference_services()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('platform', t.platform, 'category', t.category, 'name', t.name)), '[]'::jsonb)
    from (select distinct pl.slug platform, c.name category, s.name
            from services s
            join categories c on c.id = s.category_id and c.is_active
            join platforms pl on pl.id = c.platform_id
            join provider_services ps on ps.id = s.primary_provider_service_id
            join providers p on p.id = ps.provider_id and p.catalog_mode = 'publish'
           where s.is_active) t;
$$;

create or replace function public.fill_storefront_gaps(p_provider_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_linked      integer := 0;
  v_twins       integer := 0;
  v_reactivated integer := 0;
  v_published   jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_parameter_value: rows must be a json array' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from providers where id = p_provider_id and fill_gaps) then
    return jsonb_build_object('skipped', true);
  end if;

  drop table if exists _gap;
  create temp table _gap on commit drop as
  select r.value as row, d.id as ps, r.value ->> 'platform' as platform, d.rate_per_1000 as rate, d.min_quantity as mn, d.max_quantity as mx,
         d.refill_supported, d.cancel_supported, nullif(d.fp_base, '') as fb, d.fp_tags as ft, d.fp_refill as fr,
         exists (select 1 from services x where x.primary_provider_service_id = d.id) as known
    from jsonb_array_elements(p_rows) r
    join provider_services d on d.id = (r.value ->> 'ps')::uuid and d.provider_id = p_provider_id and d.is_active and d.rate_per_1000 > 0;

  -- 1. exactly a card that is already on sale on this platform: back it, do not repeat it
  drop table if exists _twin;
  create temp table _twin on commit drop as
  select distinct on (g.ps) g.ps, s.id as service_id, g.rate, g.mn, g.mx, g.refill_supported, g.cancel_supported,
         s.min_quantity as smn, s.max_quantity as smx
    from _gap g
    join provider_services x on x.fp_base = g.fb and x.fp_tags is not distinct from g.ft and x.fp_refill is not distinct from g.fr and x.id <> g.ps
    join services s on s.primary_provider_service_id = x.id and s.is_active
    join categories c on c.id = s.category_id
    join platforms pl on pl.id = c.platform_id and pl.slug = g.platform
   where not g.known and g.fb is not null
   order by g.ps, s.id;

  insert into provider_service_offers
    (service_id, provider_id, provider_service_id, cost_per_1000, min_quantity, max_quantity, refill_supported, cancel_supported,
     supports_partial, is_active, routing_score)
  select distinct on (t.service_id) t.service_id, p_provider_id, t.ps, t.rate, t.mn, t.mx, t.refill_supported, t.cancel_supported, false, true, 0
    from _twin t
   where t.mn <= t.smn and t.mx >= t.smx
     and not exists (select 1 from provider_service_offers o where o.service_id = t.service_id and o.provider_id = p_provider_id)
   order by t.service_id, t.rate, t.ps
  on conflict (service_id, provider_id, provider_service_id) do nothing;
  get diagnostics v_linked = row_count;

  delete from _gap g using _twin t where t.ps = g.ps;
  get diagnostics v_twins = row_count;

  -- 2. twins among the rows themselves: one card, the cheapest
  delete from _gap g
   using (select ps, row_number() over (partition by platform, fb, ft, fr order by rate, ps) as n from _gap where not known and fb is not null) d
   where d.ps = g.ps and d.n > 1;

  -- 3. publish
  v_published := publish_provider_services(p_provider_id, (select coalesce(jsonb_agg(row), '[]'::jsonb) from _gap));

  -- 4. cards of these rows that the compaction hid come back, and so do their categories
  update services s
     set is_active = true
    from _gap g
   where s.primary_provider_service_id = g.ps and s.auto_published and not s.is_active;
  get diagnostics v_reactivated = row_count;

  update categories c
     set is_active = true
   where not c.is_active
     and exists (select 1 from services s join _gap g on g.ps = s.primary_provider_service_id where s.category_id = c.id and s.is_active);

  return v_published || jsonb_build_object('linked', v_linked, 'twins', v_twins, 'reactivated', v_reactivated);
end;
$$;

revoke all on function public.storefront_reference_services(), public.fill_storefront_gaps(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.storefront_reference_services(), public.fill_storefront_gaps(uuid, jsonb) to service_role;
