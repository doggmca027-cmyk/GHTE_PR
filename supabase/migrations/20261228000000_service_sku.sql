-- =============================================================================
-- Internal article numbers (SKU) of provider services: for the admin only
--
--   [PLATFORM]-[TYPE]-[QUALITY]-[PROVIDER][ID]        IG-FOL-HQ-SEC9986   TT-FOL-CHEAP-MTP5760   TG-VIEW-STD-JAP1234
--
--   * PLATFORM  the platform the service name (then its panel category) says: IG TT YT TG FB TW SP TWH SC SND KICK VK ... OTH
--   * TYPE      the action: FOL SUB MEM LIKE VIEW PLAY SHARE COM CLIKE REACT LIVE STORY IMPR VOTE TRAF REV ... OTH
--   * QUALITY   CHEAP: the name takes the guarantee back ("no refill", a bot) or says cheap / low quality / high drop / mix / economy;
--               HQ: it says so itself (HQ, high or top quality, real, non-drop, organic), or the provider is a premium panel and the name promises
--               a refill or guarantee; STD: anything else, a refill alone included
--   * the last part is the provider's short code and ITS OWN service number, so a SKU is built from the row alone: it is unique (a provider
--     has one service per number), it never depends on how many other rows there are, and "SEC9986" reads as Secsers' service 9986
--
-- A SKU is issued once, when the service is first stored, and never changes (a panel renaming its service does not renumber our article).
-- It is private: provider_services has no client grant at all, and no customer-facing function or screen selects or shows it (tests/service-sku.test.ts
-- reads the code to prove it). The admin sees it in the bundle editor and in the order-hub messages of the bot.
-- =============================================================================

-- <functions>
create or replace function public.sku_platform_of(p_text text)
returns text
language sql
immutable
as $$
  select case
    when p_text ~* '\y(instagram|insta|ig)\y' then 'IG'
    when p_text ~* '\y(tiktok|tik tok|tt)\y' then 'TT'
    when p_text ~* '\y(youtube|you tube|yt)\y' then 'YT'
    when p_text ~* '\y(telegram|tg)\y' then 'TG'
    when p_text ~* '\y(facebook|fb)\y' then 'FB'
    when p_text ~* '\ytwitter\y|\ytweets?\y|\yx\.com\y|\(x\)' then 'TW'
    when p_text ~* '\yspotify\y' then 'SP'
    when p_text ~* '\ytwitch\y' then 'TWH'
    when p_text ~* '\y(snapchat|snap)\y' then 'SC'
    when p_text ~* '\ysoundcloud\y' then 'SND'
    when p_text ~* '\ykick\y' then 'KICK'
    when p_text ~* '\yvk(\.com|ontakte)?\y|вконтакте' then 'VK'
    when p_text ~* '\ylinkedin\y' then 'LI'
    when p_text ~* '\ypinterest\y' then 'PIN'
    when p_text ~* '\yreddit\y' then 'RD'
    when p_text ~* '\ydiscord\y' then 'DC'
    when p_text ~* '\ythreads\y' then 'THR'
    when p_text ~* '\yaudiomack\y' then 'AMK'
    when p_text ~* '\y(apple music|itunes)\y' then 'AMU'
    when p_text ~* '\ydeezer\y' then 'DZ'
    when p_text ~* '\ytidal\y' then 'TDL'
    when p_text ~* '\yquora\y' then 'QR'
    when p_text ~* '\ytumblr\y' then 'TMB'
    when p_text ~* '\yrumble\y' then 'RMB'
    when p_text ~* '\ywhatsapp\y' then 'WA'
    when p_text ~* '\ybluesky\y' then 'BSK'
    when p_text ~* '\ysteam\y' then 'STM'
    when p_text ~* '\yroblox\y' then 'RBX'
    when p_text ~* '\ykwai\y' then 'KW'
    when p_text ~* '\yshopee\y' then 'SHP'
    when p_text ~* '\y(google (maps?|reviews?|business)|gmaps?)\y' then 'GM'
    when p_text ~* '\y(trustpilot|tripadvisor|yelp)\y' then 'TP'
    when p_text ~* '\y(website|web traffic|traffic|seo|backlinks?)\y' then 'WEB'
    else null
  end;
$$;

create or replace function public.sku_type_of(p_text text)
returns text
language sql
immutable
as $$
  select case
    when p_text ~* '\ylive\y|livestream|stream viewers|concurrent' then 'LIVE'
    when p_text ~* '\ystor(y|ies)\y' then 'STORY'
    when p_text ~* 'comments? (likes?|upvotes?)' then 'CLIKE'
    when p_text ~* 'comment|replies|mentions' then 'COM'
    when p_text ~* 'reaction|emoji' then 'REACT'
    when p_text ~* '\ymembers?\y|\yjoins?\y' then 'MEM'
    when p_text ~* 'subscriber' then 'SUB'
    when p_text ~* 'follower|\yfollow\y' then 'FOL'
    when p_text ~* '\ylikes?\y|\yhearts?\y|favou?rites?|upvotes?' then 'LIKE'
    when p_text ~* '\yplays?\y|\ystreams?\y|listeners' then 'PLAY'
    when p_text ~* 'share|repost|retweet|forward|\ysaves?\y|bookmark' then 'SHARE'
    when p_text ~* 'impression|\yreach\y|\yclicks?\y|profile visits' then 'IMPR'
    when p_text ~* '\yviews?\y|watch ?time|\ywatch\y' then 'VIEW'
    when p_text ~* '\yvotes?\y|\ypolls?\y' then 'VOTE'
    when p_text ~* 'traffic|visitors|\yvisits?\y' then 'TRAF'
    when p_text ~* 'review|rating' then 'REV'
    else null
  end;
$$;

create or replace function public.sku_quality_of(p_name text, p_premium boolean default false)
returns text
language sql
immutable
as $$
  select case
    when public.service_name_no_guarantee(p_name)
      or coalesce(p_name, '') ~* '\y(cheap|lq|low quality|low price|lowest price|high drop|mix|mixed|economy)\y' then 'CHEAP'
    when coalesce(p_name, '') ~* '\y(u?hq|high quality|top quality|real|real users?|non[\s-]*drop|no[\s-]*drops?|organic)\y(?![\s-]*time)'
      or (coalesce(p_premium, false) and public.service_name_promises(p_name)) then 'HQ'
    else 'STD'
  end;
$$;

-- the short code of a provider in a SKU; a provider that is new gets the first letters of its name
create or replace function public.provider_sku_code(p_name text)
returns text
language sql
immutable
as $$
  select case lower(btrim(coalesce(p_name, '')))
    when 'jap' then 'JAP'
    when 'rootpanel' then 'ROOT'
    when 'smmfollows' then 'SMMF'
    when 'secsers' then 'SEC'
    when 'morethanpanel' then 'MTP'
    when 'smm center' then 'SMMC'
    when 'smmstone' then 'SMMS'
    when 'smmpwr' then 'SMMW'
    when 'smmprovider' then 'SMMP'
    else coalesce(nullif(upper(left(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]', '', 'g'), 4)), ''), 'PRV')
  end;
$$;

create or replace function public.build_provider_service_sku(p_name text, p_category text, p_provider text, p_external text, p_premium boolean default false)
returns text
language sql
immutable
as $$
  select coalesce(public.sku_platform_of(p_name), public.sku_platform_of(p_category), 'OTH') || '-'
      || coalesce(public.sku_type_of(p_name), public.sku_type_of(p_category), 'OTH') || '-'
      || public.sku_quality_of(p_name, p_premium) || '-'
      || public.provider_sku_code(p_provider) || upper(left(regexp_replace(coalesce(p_external, ''), '[^A-Za-z0-9]', '', 'g'), 12));
$$;
-- </functions>

revoke all on function public.sku_platform_of(text), public.sku_type_of(text), public.sku_quality_of(text, boolean), public.provider_sku_code(text),
  public.build_provider_service_sku(text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sku_platform_of(text), public.sku_type_of(text), public.sku_quality_of(text, boolean), public.provider_sku_code(text),
  public.build_provider_service_sku(text, text, text, text, boolean) to service_role;

alter table public.provider_services add column if not exists sku text;
comment on column public.provider_services.sku is 'Internal article number, for the admin only: never selected by a client role or a customer-facing function.';

-- the services that exist
update public.provider_services ps
   set sku = public.build_provider_service_sku(ps.name, ps.category_raw, p.name, ps.external_service_id, p.is_premium)
  from public.providers p
 where p.id = ps.provider_id and ps.sku is null;

-- two services of one provider whose numbers only differ in punctuation would share a SKU: the later ones are told apart by their id
with twin as (select id, row_number() over (partition by sku order by id) n from public.provider_services where sku is not null)
update public.provider_services ps
   set sku = ps.sku || '-' || left(replace(ps.id::text, '-', ''), 4)
  from twin
 where twin.id = ps.id and twin.n > 1;

create unique index if not exists uq_provider_services_sku on public.provider_services (sku);

-- the services that come: a SKU is issued when the row is stored. It never blocks a catalogue sync: a failure leaves the SKU empty.
create or replace function public.set_provider_service_sku()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider text;
  v_premium  boolean;
begin
  begin
    select name, is_premium into v_provider, v_premium from providers where id = new.provider_id;
    new.sku := build_provider_service_sku(new.name, new.category_raw, v_provider, new.external_service_id, v_premium);
    if exists (select 1 from provider_services where sku = new.sku) then
      new.sku := new.sku || '-' || left(replace(new.id::text, '-', ''), 4);
    end if;
  exception when others then
    new.sku := null;
  end;
  return new;
end;
$$;
revoke all on function public.set_provider_service_sku() from public, anon, authenticated;

drop trigger if exists trg_provider_services_sku on public.provider_services;
create trigger trg_provider_services_sku before insert on public.provider_services
  for each row when (new.sku is null)
  execute function public.set_provider_service_sku();

-- Private by construction (provider_services has no client grant at all); said once more for the column
revoke select (sku) on public.provider_services from anon, authenticated;

-- The order-hub messages of the bot carry the SKU of the service the order was routed to
create or replace function public.trg_orders_hub_messages()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider providers%rowtype;
  v_service  text;
  v_sku      text;
  v_need     jsonb;
begin
  begin
    -- an order entering the hub: paid while waiting (place_order marks it waiting already as a draft), or back after a "not enough funds"
    if new.awaiting_funds_since is not null and new.status = 'paid'
       and (tg_op = 'INSERT' or old.awaiting_funds_since is null or old.status is distinct from 'paid') then
      select * into v_provider from providers where id = new.provider_id;
      select name into v_service from services where id = new.service_id;
      select ps.sku into v_sku from provider_service_offers o join provider_services ps on ps.id = o.provider_service_id where o.id = new.provider_offer_id;
      v_need := hub_provider_needed(new.provider_id);
      perform queue_hub_message('waiting:' || new.id || ':' || floor(extract(epoch from new.awaiting_funds_since))::bigint, jsonb_build_object(
        'event', 'waiting', 'order_id', new.id, 'provider_id', new.provider_id, 'provider', coalesce(v_provider.name, '?'),
        'service', coalesce(v_service, '?'), 'sku', v_sku, 'quantity', new.quantity, 'charge', new.charge_amount, 'cost', new.cost_amount,
        'balance', v_provider.provider_balance, 'needed', v_need -> 'needed', 'waiting', v_need -> 'count'));
    end if;
    -- an order sent to its provider (straight away or from the hub)
    if tg_op = 'UPDATE' and new.status = 'submitted' and old.status is distinct from 'submitted' then
      select * into v_provider from providers where id = new.provider_id;
      select name into v_service from services where id = new.service_id;
      select ps.sku into v_sku from provider_service_offers o join provider_services ps on ps.id = o.provider_service_id where o.id = new.provider_offer_id;
      perform queue_hub_message('sent:' || new.id, jsonb_build_object(
        'event', 'sent', 'order_id', new.id, 'provider', coalesce(v_provider.name, '?'), 'service', coalesce(v_service, '?'), 'sku', v_sku,
        'quantity', new.quantity, 'charge', new.charge_amount, 'cost', new.cost_amount, 'balance', v_provider.provider_balance,
        'from_hub', new.hub_entered_at is not null));
    end if;
  exception when others then
    raise warning 'order hub message skipped: %', sqlerrm;   -- a message never blocks an order
  end;
  return null;
end;
$$;
