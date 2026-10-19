-- =============================================================================
-- Connected accounts: a Telegram account and an e-mail address on one profile; the bot sign-in is gone
--
-- The website signs in with Telegram's own Login Widget (oauth.telegram.org: the user confirms in Telegram, with the device and place of the
-- attempt shown there) or with an e-mail. A signed-in user can connect the other one in Settings, so either way leads to the same profile:
--
--   web_link_telegram(user, telegram id, username, first name)   the widget's signed user is set on the profile
--   web_link_email_issue(user, email, code hash, ttl)            a 6-digit code to the address (purpose link_email)
--   web_link_email_verify(user, email, code hash, password hash) the address is set on the profile (verified), with an optional password
--
-- A Telegram account or an address that already has a profile of its own is refused ('telegram_taken' / 'email_taken'): two profiles, each
-- with its balance and orders, are never merged silently. A profile that already has one keeps it ('already_linked').
--
-- The sign-in confirmed in the bot (20261210000000: /start auth_<token>, Confirm / Cancel, the browser polling) is removed: its table and
-- functions are dropped. The bot keeps the order hub and the welcome message.
-- =============================================================================

-- 1. Telegram ----------------------------------------------------------------------------------------------------------------------------
create or replace function public.web_link_telegram(p_user_id uuid, p_telegram_id bigint, p_username text default null, p_first_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  u users%rowtype;
begin
  if p_telegram_id is null or p_telegram_id <= 0 then
    raise exception 'invalid_parameter_value: telegram id' using errcode = 'invalid_parameter_value';
  end if;
  select * into u from users where id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'unknown_user'); end if;
  if u.is_banned then return jsonb_build_object('status', 'banned'); end if;
  if u.telegram_id = p_telegram_id then
    null;   -- already this one: refreshed below
  elsif u.telegram_id is not null then
    return jsonb_build_object('status', 'already_linked');
  elsif exists (select 1 from users where telegram_id = p_telegram_id and id <> p_user_id) then
    return jsonb_build_object('status', 'telegram_taken');
  end if;
  update users
     set telegram_id = p_telegram_id,
         username = coalesce(nullif(left(p_username, 64), ''), username),
         first_name = coalesce(first_name, nullif(left(p_first_name, 64), ''))
   where id = p_user_id
  returning * into u;
  return jsonb_build_object('status', 'ok', 'user', jsonb_build_object(
    'id', u.id, 'telegram_id', u.telegram_id, 'email', u.email, 'username', u.username, 'first_name', u.first_name,
    'language_code', u.language_code, 'is_banned', u.is_banned, 'is_admin', u.is_admin));
end;
$$;

-- 2. e-mail ------------------------------------------------------------------------------------------------------------------------------
create or replace function public.web_link_email_issue(p_user_id uuid, p_email text, p_code_hash text, p_ttl_seconds integer default 600)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  u        users%rowtype;
  v_last   timestamptz;
  v_expire timestamptz;
begin
  if p_ttl_seconds is null or p_ttl_seconds not between 60 and 3600 then
    raise exception 'invalid_parameter_value: ttl must be 60..3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_parameter_value: code hash' using errcode = 'invalid_parameter_value';
  end if;
  select * into u from users where id = p_user_id;
  if not found then return jsonb_build_object('status', 'unknown_user'); end if;
  if u.is_banned then return jsonb_build_object('status', 'banned'); end if;
  if u.email is not null then return jsonb_build_object('status', 'already_linked'); end if;
  if exists (select 1 from users where lower(email) = v_email) then return jsonb_build_object('status', 'email_taken'); end if;

  -- the same pace as the sign-in codes: one a minute per address, five an hour per address
  perform pg_advisory_xact_lock(hashtext('email_code:' || v_email));
  select max(created_at) into v_last from email_auth_codes where email = v_email and purpose = 'link_email';
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('status', 'cooldown', 'retry_after', ceil(extract(epoch from v_last + interval '60 seconds' - now())));
  end if;
  if not auth_rate_hit('code:' || v_email, 5, 3600) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  update email_auth_codes set consumed_at = now() where email = v_email and purpose = 'link_email' and consumed_at is null;
  v_expire := now() + make_interval(secs => p_ttl_seconds);
  insert into email_auth_codes (email, user_id, purpose, code_hash, expires_at) values (v_email, p_user_id, 'link_email', p_code_hash, v_expire);
  return jsonb_build_object('status', 'issued', 'expires_at', v_expire);
end;
$$;

create or replace function public.web_link_email_verify(p_user_id uuid, p_email text, p_code_hash text, p_password_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  c       email_auth_codes%rowtype;
  u       users%rowtype;
begin
  if p_password_hash is not null and p_password_hash !~ '^pbkdf2_sha256\$' then
    raise exception 'invalid_parameter_value: password hash' using errcode = 'invalid_parameter_value';
  end if;
  -- the code was sent for THIS profile: another one cannot redeem it
  select * into c from email_auth_codes
   where email = v_email and purpose = 'link_email' and user_id = p_user_id and consumed_at is null
   order by created_at desc limit 1
   for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if c.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if c.attempts >= c.max_attempts then return jsonb_build_object('status', 'locked'); end if;
  if c.code_hash is distinct from p_code_hash then
    update email_auth_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('status', case when c.attempts + 1 >= c.max_attempts then 'locked' else 'invalid' end,
                              'attempts_left', greatest(c.max_attempts - c.attempts - 1, 0));
  end if;
  update email_auth_codes set consumed_at = now() where id = c.id;

  select * into u from users where id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if u.is_banned then return jsonb_build_object('status', 'banned'); end if;
  if u.email is not null then return jsonb_build_object('status', 'already_linked'); end if;
  -- someone registered this address while the code was on its way
  if exists (select 1 from users where lower(email) = v_email) then return jsonb_build_object('status', 'email_taken'); end if;
  update users set email = v_email, email_verified_at = now(), password_hash = coalesce(p_password_hash, password_hash)
   where id = p_user_id
  returning * into u;
  return jsonb_build_object('status', 'ok', 'user', jsonb_build_object(
    'id', u.id, 'telegram_id', u.telegram_id, 'email', u.email, 'username', u.username, 'first_name', u.first_name,
    'language_code', u.language_code, 'is_banned', u.is_banned, 'is_admin', u.is_admin));
end;
$$;

revoke all on function public.web_link_telegram(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.web_link_email_issue(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.web_link_email_verify(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.web_link_telegram(uuid, bigint, text, text) to service_role;
grant execute on function public.web_link_email_issue(uuid, text, text, integer) to service_role;
grant execute on function public.web_link_email_verify(uuid, text, text, text) to service_role;

-- 3. the bot sign-in is removed -------------------------------------------------------------------------------------------------------
drop function if exists public.bot_login_create(text, text, integer);
drop function if exists public.bot_login_open(text, bigint, jsonb);
drop function if exists public.bot_login_decide(text, bigint, boolean);
drop function if exists public.bot_login_poll(text);
drop table if exists public.web_bot_logins;
