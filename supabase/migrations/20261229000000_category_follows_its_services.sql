-- =============================================================================
-- A category with an active card is active
--
-- The compaction (20261207000000) switched off the canonical categories that had no active service. A later publish put cards into such a
-- category again (publish_provider_services reuses it and never switches it on), and the storefront only shows active categories
-- (categories_select_active): 1417 active cards of the Secsers and MoreThanPanel catalogues were invisible to customers.
--
--   1. the categories that hold an active card are switched on now (66 of them at the audit, after the owner's decision to show them all)
--   2. from here on a card that is stored active, or switched on, or moved into another category switches its category on:
--      whoever publishes does not have to remember it. Nothing ever switches a category OFF here: that stays the compaction's and the admin's.
-- =============================================================================

update public.categories c
   set is_active = true
 where not c.is_active
   and exists (select 1 from public.services s where s.category_id = c.id and s.is_active);

select public.recount_categories(coalesce((select array_agg(id) from public.categories), '{}'));

create or replace function public.activate_category_of_service()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.categories set is_active = true where id = new.category_id and not is_active;
  return null;
end;
$$;

revoke all on function public.activate_category_of_service() from public, anon, authenticated;

drop trigger if exists trg_services_activate_category on public.services;
create trigger trg_services_activate_category after insert or update of is_active, category_id on public.services
  for each row when (new.is_active)
  execute function public.activate_category_of_service();
