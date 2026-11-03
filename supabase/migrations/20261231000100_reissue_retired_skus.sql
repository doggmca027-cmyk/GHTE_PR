-- =============================================================================
-- Articles (SKU) of the cards that still carry the code of a provider that is off
--
-- A card's article was copied from its primary panel service (20261230000000). For 1,101 active cards that service belongs to SMM Center, which left
-- the pool: they are served by their other offers, yet the article ends in SMMC and a customer reads the code of a provider nobody buys from any more.
-- Now each such card takes the article of the panel service that serves it today: among its working offers (the offer is on, the provider is on and
-- takes orders, the panel still lists the service) the one routing would pick, i.e. the best quality score, then the lowest cost.
--
--   * only active cards whose article is the article of a panel service of a provider that is off; a card with no working offer keeps its article
--   * a donor's article that is already some other card's (the card whose own primary service it is) is told apart by four characters of the card's
--     id, like twins everywhere else: IG-FOL-STD-ROOT89336-3FA9
--   * the suffix is in capitals, the way the search looks an article up (sku.eq. on the capitals a customer types or pastes)
-- =============================================================================

with stale as (
  select s.id, s.name
    from public.services s
   where s.is_active
     and s.sku in (select ps.sku
                     from public.provider_services ps
                     join public.providers p on p.id = ps.provider_id
                    where not p.is_active and ps.sku is not null)
),
donor as (
  select distinct on (st.id) st.id, ps.sku
    from stale st
    join public.provider_service_offers o on o.service_id = st.id and o.is_active
    join public.providers p on p.id = o.provider_id and p.is_active and p.routing_enabled
    join public.provider_services ps on ps.id = o.provider_service_id and ps.is_active and ps.sku is not null
   order by st.id, public.offer_quality_score(st.name, ps.name, p.is_premium) desc, o.cost_per_1000, ps.id
),
ranked as (
  select d.id, d.sku,
         row_number() over (partition by d.sku order by d.id) n,
         exists (select 1 from public.services x where x.sku = d.sku and x.id <> d.id and x.id not in (select id from stale)) taken
    from donor d
)
update public.services s
   set sku = case when r.n = 1 and not r.taken then r.sku else r.sku || '-' || upper(left(replace(s.id::text, '-', ''), 4)) end
  from ranked r
 where r.id = s.id;

-- the cards that come: the same, with the suffix in capitals (20261230000000 wrote it in lower case)
create or replace function public.set_service_sku()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    select ps.sku into new.sku from provider_services ps where ps.id = new.primary_provider_service_id;
    if new.sku is not null and exists (select 1 from services s where s.sku = new.sku and s.id <> new.id) then
      new.sku := new.sku || '-' || upper(left(replace(new.id::text, '-', ''), 4));
    end if;
  exception when others then
    new.sku := null;
  end;
  return new;
end;
$$;
revoke all on function public.set_service_sku() from public, anon, authenticated;
