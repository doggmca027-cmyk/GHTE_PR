-- The article of a storefront card no longer carries the code of a provider.
--
-- It was copied from the card's primary panel service (20261230000000), so it read IG-FOL-HQ-SEC9986: the panel's code (SEC, ROOT, MTP, JAP...) and
-- the panel's own service number. A customer sees it, so a customer could tell who the supplier is. Now it is
--
--     PLATFORM-TYPE-QUALITY-<code>        IG-FOL-HQ-3F9A1C
--
-- the first three parts as before (what the card is) and a code that is only a hash of the card's own id: no provider, no panel number, nothing that
-- can be turned back into either. The code is 6 hex characters; the few cards that would share one get 8 (then 12), so every article stays unique.
--
-- * provider_services.sku (the admin-only article, with the panel code) is NOT touched: the admin still reads which panel a service is.
-- * Orders point at the card by its id, never by its article, so no order, quote or ledger line changes. Only services.sku is rewritten.
-- * An article is still issued once: the trigger fills it only when it is empty; nothing recomputes it later (a changed quality must not change a
--   number a customer has saved).
-- * The old articles stop existing: a customer who saved one finds nothing for it and is told so by the search. They were handed out for days only.

-- ---- 1. the code ------------------------------------------------------------------------------------------------------------------------------
create or replace function public.card_sku_code(p_id uuid, p_len integer default 6)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select upper(left(md5(p_id::text), greatest(6, least(p_len, 12)))) $$;
revoke all on function public.card_sku_code(uuid, integer) from public, anon, authenticated;

-- "IG-FOL-HQ-SEC9986-3FA9" -> "IG-FOL-HQ": what the card is, without the supplier
create or replace function public.card_sku_prefix(p_sku text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when split_part(p_sku, '-', 4) <> '' then split_part(p_sku, '-', 1) || '-' || split_part(p_sku, '-', 2) || '-' || split_part(p_sku, '-', 3) end
$$;
revoke all on function public.card_sku_prefix(text) from public, anon, authenticated;

-- ---- 2. every card that has an article -------------------------------------------------------------------------------------------------------
-- Two steps: the code of 6 characters for everyone, then a longer one for the cards whose article would equal another's. The new articles can never
-- equal an old one (an old one ends in a panel code with a letter that is not hex), so the unique index never sees a clash halfway through.
with fresh as (
  select s.id, public.card_sku_prefix(s.sku) as prefix from public.services s where s.sku is not null
), candidate as (
  select f.id, f.prefix, f.prefix || '-' || public.card_sku_code(f.id, 6) as sku6, f.prefix || '-' || public.card_sku_code(f.id, 8) as sku8
    from fresh f where f.prefix is not null
), ranked as (
  select c.*, count(*) over (partition by c.sku6) as same6, count(*) over (partition by c.sku8) as same8 from candidate c
)
update public.services s
   set sku = case when r.same6 = 1 then r.sku6 when r.same8 = 1 then r.sku8 else r.prefix || '-' || public.card_sku_code(r.id, 12) end
  from ranked r
 where s.id = r.id;

-- ---- 3. the cards that come ------------------------------------------------------------------------------------------------------------------
create or replace function public.set_service_sku()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text;
  v_len    integer := 6;
begin
  begin
    -- what the card is comes from its primary panel service's article; the code is the card's own
    select public.card_sku_prefix(ps.sku) into v_prefix from provider_services ps where ps.id = new.primary_provider_service_id;
    if v_prefix is not null then
      new.sku := v_prefix || '-' || public.card_sku_code(new.id, v_len);
      while v_len < 12 and exists (select 1 from services s where s.sku = new.sku and s.id <> new.id) loop
        v_len := case when v_len = 6 then 8 else 12 end;
        new.sku := v_prefix || '-' || public.card_sku_code(new.id, v_len);
      end loop;
    else
      new.sku := null;
    end if;
  exception when others then
    new.sku := null;
  end;
  return new;
end;
$$;
revoke all on function public.set_service_sku() from public, anon, authenticated;
