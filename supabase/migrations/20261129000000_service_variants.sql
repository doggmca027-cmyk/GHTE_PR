-- =============================================================================
-- Service variants: services of one category that differ only in quality / speed / guarantee / start time / server are shown as ONE
-- card with switches (Economy / Standard / Premium), grouped automatically by name (owner decision 2026-10-16).
--
-- services.parent_service_id   the group's main service (the cheapest); null for the main service and for ungrouped ones
-- services.variant_rank        1 = cheapest ... n = dearest inside the group; null when ungrouped
--
-- service_group_key(name)      the name without the bracketed parts that only describe quality ("[refill: 30 days]", "[speed: 10 K/day]",
--                              "[start: 0-1 hour]", "[high quality]", "[server 2]", "[S2]", ...). Parts that change WHAT is sold (a
--                              country, a post count, a target, "premium accounts") stay, so different products never merge.
-- regroup_service_variants()   rebuilds every group of active services: same category + same key, 2 to 10 services (a larger set is
--                              more likely a bad merge and stays ungrouped). Called by sync-catalog after each catalogue run.
-- A main service that is switched off hands its group to the next cheapest active variant at once (trigger), so no variant is ever
-- hidden behind an inactive main service.
-- =============================================================================

alter table public.services
  add column parent_service_id uuid references public.services(id) on delete set null,
  add column variant_rank      smallint check (variant_rank is null or variant_rank between 1 and 10),
  add constraint services_parent_not_self check (parent_service_id is null or parent_service_id <> id);
create index idx_services_parent on public.services (parent_service_id) where parent_service_id is not null;

grant select (parent_service_id, variant_rank) on table public.services to anon, authenticated;

create function public.service_group_key(p_name text)
returns text
language plpgsql
immutable
as $fn$
declare
  v_name text := lower(coalesce(p_name, ''));
  v_part text;
begin
  -- each bracketed part on its own: a guarantee is always a variant trait; a part that names WHAT is delivered (comments, posts,
  -- minutes, views, members, likes, reactions) is kept; any other quality / speed / start / server part is a variant trait
  for v_part in select m[1] from regexp_matches(v_name, '([\[(][^\])]*[\])])', 'g') m loop
    if v_part ~ '(refill|гарант|восстанов|drop|списан|lifetime|пожизн)'
       or (v_part !~ '(comment|коммент|\mposts?\M|пост|\mmin\M|минут|views|просмотр|member|подписч|\mlikes?\M|лайк|reaction|реакц)'
           and v_part ~ '(speed|скорост|start|старт|quality|качеств|\mreal\M|реальн|cheap|дешев|server|сервер|\mfast\M|быстр|\mslow\M|instant|мгновен|stable|стабил|bonus|бонус|urgent|срочн|\mvip\M|\mhq\M|\ms\d{1,2}\M|max:|без )')
    then
      v_name := replace(v_name, v_part, '');
    end if;
  end loop;
  return btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
end;
$fn$;

create function public.regroup_service_variants()
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
        from services where is_active
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

-- a main service switched off: the next cheapest active variant takes the group over
create function public.promote_service_variant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next uuid;
begin
  if old.is_active and not new.is_active then
    select id into v_next from services where parent_service_id = new.id and is_active
     order by variant_rank nulls last, customer_rate_per_1000, id limit 1;
    if v_next is not null then
      update services set parent_service_id = null where id = v_next;
      update services set parent_service_id = v_next where parent_service_id = new.id and id <> v_next;
    end if;
  end if;
  return null;
end;
$$;
create trigger trg_services_promote_variant after update of is_active on public.services
  for each row execute function public.promote_service_variant();

revoke all on function public.service_group_key(text) from public, anon, authenticated;
revoke all on function public.regroup_service_variants() from public, anon, authenticated;
revoke all on function public.promote_service_variant() from public, anon, authenticated;
grant execute on function public.service_group_key(text) to service_role;
grant execute on function public.regroup_service_variants() to service_role;

select public.regroup_service_variants();
