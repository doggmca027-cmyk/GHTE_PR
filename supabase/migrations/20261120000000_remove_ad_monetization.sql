-- Ad monetization is removed: the owner decided there will be no ad monetization (2026-10-11).
-- On production the three networks (adsgram, monetag, gigapub) were switched off, none of their signing secrets was ever set, and
-- user_ad_ledger was empty: nothing was ever paid. The Edge Function ad-webhook and its shared code are deleted with this change.
--
-- The value 'ad_reward' stays in transaction_type_enum: PostgreSQL cannot drop an enum value without rebuilding the type, and no
-- ledger row uses it. Nothing creates it any more.

do $$
begin
  if exists (select 1 from public.user_ad_ledger) then
    raise exception 'user_ad_ledger is not empty: ad rewards were paid, refusing to drop their history';
  end if;
end;
$$;

drop function if exists public.process_ad_reward(uuid, text, text);
drop function if exists public.admin_set_ad_provider(uuid, text, numeric, numeric, boolean);
drop table if exists public.user_ad_ledger;
drop table if exists public.ad_providers;
drop type if exists public.ad_ledger_status;
alter table public.platform_settings drop column if exists max_daily_ad_earnings;
