-- =============================================================================
-- The article number (SKU) of a storefront card, readable by customers
--
-- The support assistant gives a customer the article of the service it recommends (IG-FOL-STD-ROOT89336) and the storefront search finds the card by
-- it. A card's article is the SKU of its primary provider service (20261228000000), copied once and never changed: re-pointing the card to another
-- panel service, or the panel renaming its service, does not renumber the card, so an article a customer copied stays valid.
--
-- provider_services.sku itself stays private (no client grant): a customer reads the copy that the card carries. The article names the panel code
-- (ROOT, SEC, MTP...) and the panel's own service number: that is the owner's decision, the costs and the routing stay as private as before.
-- =============================================================================

alter table public.services add column if not exists sku text;
comment on column public.services.sku is 'Article number of the card: the SKU of its primary provider service, issued once. Public: the assistant gives it to customers and the search finds the card by it.';

-- the cards that exist
update public.services s
   set sku = ps.sku
  from public.provider_services ps
 where ps.id = s.primary_provider_service_id and s.sku is null and ps.sku is not null;

-- two cards on one panel service would share an article: the later ones are told apart by their id
with twin as (select id, row_number() over (partition by sku order by id) n from public.services where sku is not null)
update public.services s
   set sku = s.sku || '-' || left(replace(s.id::text, '-', ''), 4)
  from twin
 where twin.id = s.id and twin.n > 1;

create unique index if not exists uq_services_sku on public.services (sku);

-- the cards that come: the article is copied when the card is stored (or, for a card stored without one, when it gets its primary service).
-- It never blocks a publish: a failure leaves the article empty.
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
      new.sku := new.sku || '-' || left(replace(new.id::text, '-', ''), 4);
    end if;
  exception when others then
    new.sku := null;
  end;
  return new;
end;
$$;
revoke all on function public.set_service_sku() from public, anon, authenticated;

drop trigger if exists trg_services_sku on public.services;
create trigger trg_services_sku before insert or update of primary_provider_service_id on public.services
  for each row when (new.sku is null)
  execute function public.set_service_sku();

-- services has column-level grants: a new public column needs its own
grant select (sku) on table public.services to anon, authenticated;
