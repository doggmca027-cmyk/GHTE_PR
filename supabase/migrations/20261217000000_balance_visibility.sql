-- =============================================================================
-- A card is on sale only while a provider that can pay for it serves it
--
-- About 780 cards are served only by donors, and every donor's balance is $0: an order there would fail at the panel. Instead of hiding
-- them by hand, visibility now follows the balances the health monitor reads every minute:
--   * services.on_sale: at least one working offer (offer, panel service and provider active, routing on) belongs to a provider whose
--     balance is unknown (never read) or at least min_provider_balance() ($0.10)
--   * customers see a card only when it is active AND on sale (row level security), the categories count only such cards (an empty
--     category, and with it an empty platform, is not shown) and only such cards are grouped into variants
--   * refresh_service_funding() recomputes the flag; it runs when a provider's balance crosses the line (trigger on providers) and every
--     5 minutes (pg_cron: new offers, panels dropping services). A donor topped up brings its cards back by itself.
-- is_active stays what it was (the catalogue's decision); nothing is deleted.
-- =============================================================================

create or replace function public.min_provider_balance()
returns numeric
language sql
immutable
as $$ select 0.10::numeric $$;

alter table public.services add column if not exists on_sale boolean not null default true;
comment on column public.services.on_sale is 'A provider that can pay (balance unknown or >= min_provider_balance()) serves the card; customers only see cards that are active and on sale.';

-- the categories count what a customer can see
create or replace function public.recount_categories(p_ids uuid[])
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.categories c
     set active_service_count = n.cnt
    from (select u.id, (select count(*) from public.services s where s.category_id = u.id and s.is_active and s.on_sale)::integer as cnt
            from unnest(p_ids) as u(id)) n
   where c.id = n.id and c.active_service_count is distinct from n.cnt
$$;

-- only cards on sale are grouped into variants (a hidden card never leads a group whose other cards are on sale)
create or replace function public.regroup_service_variants()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_grouped integer;
  v_cleared integer;
  v_groups  integer;
begin
  create temp table _variants on commit drop as
    with base as (
      select id, category_id, name, customer_rate_per_1000 rate, sort_order, service_group_key(name) k
        from services where is_active and on_sale
    ), counted as (
      -- services with the very same name differ in something the name does not say (a niche in the description): never grouped
      select category_id, k, count(*) n, count(distinct name) names from base group by category_id, k
    ), sized as (
      select b.*, c.n from base b join counted c using (category_id, k) where c.n = c.names
    )
    select id, category_id, k,
           row_number() over (partition by category_id, k order by rate, sort_order, id)::smallint rk,
           first_value(id) over (partition by category_id, k order by rate, sort_order, id) main
      from sized where n between 2 and 10 and k <> '';

  update services s set parent_service_id = null, variant_rank = null
   where (s.parent_service_id is not null or s.variant_rank is not null)
     and not exists (select 1 from _variants v where v.id = s.id);
  get diagnostics v_cleared = row_count;

  update services s
     set parent_service_id = case when v.rk = 1 then null else v.main end, variant_rank = v.rk
    from _variants v
   where v.id = s.id
     and (s.parent_service_id is distinct from case when v.rk = 1 then null else v.main end or s.variant_rank is distinct from v.rk);
  get diagnostics v_grouped = row_count;

  select count(distinct (category_id, k)) into v_groups from _variants;
  return jsonb_build_object('groups', v_groups, 'services_in_groups', (select count(*) from _variants), 'rows_changed', v_grouped, 'rows_cleared', v_cleared);
end;
$$;


create or replace function public.refresh_service_funding()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hidden   integer;
  v_restored integer;
begin
  drop table if exists pg_temp._funding;
  create temp table _funding on commit drop as
  select s.id, s.on_sale was,
         exists (select 1
                   from provider_service_offers o
                   join provider_services ps on ps.id = o.provider_service_id and ps.is_active
                   join providers p on p.id = o.provider_id and p.is_active and p.routing_enabled
                  where o.service_id = s.id and o.is_active
                    and (p.last_balance_sync is null or p.provider_balance >= min_provider_balance())) now
    from services s
   where s.is_active;

  update services s set on_sale = f.now from _funding f where f.id = s.id and f.was and not f.now;
  get diagnostics v_hidden = row_count;
  update services s set on_sale = f.now from _funding f where f.id = s.id and not f.was and f.now;
  get diagnostics v_restored = row_count;

  if v_hidden + v_restored > 0 then
    perform regroup_service_variants();
  end if;
  return jsonb_build_object('hidden', v_hidden, 'restored', v_restored,
                            'on_sale', (select count(*) from services where is_active and on_sale));
end;
$$;

-- a provider's balance crossing the line (or the provider switched on / off) changes what is on sale at once
create or replace function public.trg_providers_funding()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (old.last_balance_sync is null or old.provider_balance >= min_provider_balance())
       is distinct from (new.last_balance_sync is null or new.provider_balance >= min_provider_balance())
     or old.is_active is distinct from new.is_active
     or old.routing_enabled is distinct from new.routing_enabled then
    perform refresh_service_funding();
  end if;
  return null;
end;
$$;

drop trigger if exists trg_providers_funding on public.providers;
create trigger trg_providers_funding
  after update of provider_balance, last_balance_sync, is_active, routing_enabled on public.providers
  for each row execute function public.trg_providers_funding();

revoke all on function public.refresh_service_funding(), public.trg_providers_funding(), public.min_provider_balance() from public, anon, authenticated;
grant execute on function public.refresh_service_funding(), public.min_provider_balance() to service_role;

-- customers see what can be ordered
drop policy if exists services_select_active on public.services;
create policy services_select_active on public.services
  for select to anon, authenticated
  using (is_active and on_sale);

-- every 5 minutes: new offers (autopilot, gap filling), panels dropping services
do $$
begin
  if to_regclass('cron.job') is not null then
    execute 'select cron.schedule($1, $2, $3)' using 'refresh-service-funding', '*/5 * * * *', 'select public.refresh_service_funding()';
  end if;
exception when others then
  raise warning 'refresh-service-funding job not scheduled: %', sqlerrm;
end;
$$;

select public.refresh_service_funding();
select public.recount_categories(coalesce((select array_agg(id) from public.categories), '{}'));
