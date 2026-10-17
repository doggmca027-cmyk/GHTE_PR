-- =============================================================================
-- Website sign-in confirmed in the Telegram bot
--
--   1. the website asks web-auth (BOT_LOGIN_INIT): a challenge is stored with the SHA-256 of two random secrets: the START token (it
--      travels in the bot link https://t.me/<bot>?start=auth_<start>) and the POLL token (kept by the browser only)
--   2. the bot gets /start auth_<start> (telegram-bot webhook): the challenge is OPENED by that Telegram account (bot_login_open) and the bot
--      asks "is this you?" with Confirm / Cancel buttons
--   3. a button press (bot_login_decide) is accepted only from the Telegram account that opened it: confirmed or cancelled
--   4. the browser polls with its poll token (BOT_LOGIN_POLL -> bot_login_poll): a confirmed challenge is handed out ONCE (consumed) and
--      web-auth signs that Telegram account in
-- A challenge lives 5 minutes. Only hashes are stored: a database reader can neither confirm nor collect a sign-in. Service role only.
-- =============================================================================

create table if not exists public.web_bot_logins (
  id            uuid primary key default gen_random_uuid(),
  start_hash    text not null unique,
  poll_hash     text not null unique,
  status        text not null default 'pending' check (status in ('pending', 'opened', 'confirmed', 'cancelled', 'consumed')),
  telegram_id   bigint,
  telegram_user jsonb,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  opened_at     timestamptz,
  decided_at    timestamptz,
  consumed_at   timestamptz
);
create index if not exists idx_web_bot_logins_expires on public.web_bot_logins (expires_at);

alter table public.web_bot_logins enable row level security;
revoke all on table public.web_bot_logins from public, anon, authenticated;

create or replace function public.bot_login_create(p_start_hash text, p_poll_hash text, p_ttl_seconds integer default 300)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(length(p_start_hash), 0) <> 64 or coalesce(length(p_poll_hash), 0) <> 64 then
    raise exception 'invalid_parameter_value: hashes are 64 hex characters' using errcode = 'invalid_parameter_value';
  end if;
  -- housekeeping: challenges a day past their end are of no use to anyone
  delete from web_bot_logins where expires_at < now() - interval '1 day';
  insert into web_bot_logins (start_hash, poll_hash, expires_at)
  values (p_start_hash, p_poll_hash, now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 300), 60), 900)));
end;
$$;

/** The bot got /start auth_<token>: 'ok' (now opened by this account), 'expired', 'used', 'other_user' or 'unknown'. */
create or replace function public.bot_login_open(p_start_hash text, p_telegram_id bigint, p_user jsonb)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c web_bot_logins%rowtype;
begin
  select * into c from web_bot_logins where start_hash = p_start_hash for update;
  if not found then return 'unknown'; end if;
  if c.expires_at < now() then return 'expired'; end if;
  if c.status not in ('pending', 'opened') then return 'used'; end if;
  if c.status = 'opened' and c.telegram_id is distinct from p_telegram_id then return 'other_user'; end if;
  update web_bot_logins
     set status = 'opened', telegram_id = p_telegram_id, telegram_user = coalesce(p_user, '{}'::jsonb), opened_at = coalesce(opened_at, now())
   where id = c.id;
  return 'ok';
end;
$$;

/** Confirm / Cancel pressed: 'confirmed', 'cancelled', 'expired', 'used', 'other_user' or 'unknown'. Only the account that opened it decides. */
create or replace function public.bot_login_decide(p_start_hash text, p_telegram_id bigint, p_approve boolean)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c web_bot_logins%rowtype;
begin
  select * into c from web_bot_logins where start_hash = p_start_hash for update;
  if not found then return 'unknown'; end if;
  if c.telegram_id is distinct from p_telegram_id then return 'other_user'; end if;
  if c.status <> 'opened' then return 'used'; end if;
  if c.expires_at < now() then return 'expired'; end if;
  update web_bot_logins
     set status = case when p_approve then 'confirmed' else 'cancelled' end, decided_at = now()
   where id = c.id;
  return case when p_approve then 'confirmed' else 'cancelled' end;
end;
$$;

/**
 * The browser asks with its poll token: {status} of pending / opened / cancelled / expired / consumed / unknown, or, ONCE,
 * {status: 'confirmed', telegram_user} (the challenge becomes consumed: a second poll gets nothing).
 */
create or replace function public.bot_login_poll(p_poll_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c web_bot_logins%rowtype;
begin
  select * into c from web_bot_logins where poll_hash = p_poll_hash for update;
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  if c.status = 'confirmed' then
    -- a confirmation is collected within a few minutes of the end of the challenge, never later
    if c.expires_at < now() - interval '5 minutes' then return jsonb_build_object('status', 'expired'); end if;
    update web_bot_logins set status = 'consumed', consumed_at = now() where id = c.id;
    return jsonb_build_object('status', 'confirmed', 'telegram_user', c.telegram_user);
  end if;
  if c.status in ('pending', 'opened') and c.expires_at < now() then return jsonb_build_object('status', 'expired'); end if;
  return jsonb_build_object('status', c.status);
end;
$$;

revoke all on function public.bot_login_create(text, text, integer) from public, anon, authenticated;
revoke all on function public.bot_login_open(text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.bot_login_decide(text, bigint, boolean) from public, anon, authenticated;
revoke all on function public.bot_login_poll(text) from public, anon, authenticated;
grant execute on function public.bot_login_create(text, text, integer) to service_role;
grant execute on function public.bot_login_open(text, bigint, jsonb) to service_role;
grant execute on function public.bot_login_decide(text, bigint, boolean) to service_role;
grant execute on function public.bot_login_poll(text) to service_role;
