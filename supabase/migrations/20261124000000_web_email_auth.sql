-- =============================================================================
-- Web expansion, step 1: e-mail + password + 6-digit code sign-in next to Telegram, on the SAME users / wallets / orders.
--
-- 1. users: telegram_id becomes optional; email (lower case, unique), email_verified_at and password_hash are added; every user
--    keeps at least one identity. A row with an email is only ever created verified (registration is pending until the code
--    arrives), so "has an email" means "proved they own it".
-- 2. Column privileges: the API role "authenticated" no longer has SELECT on the whole table, only on the listed columns; the
--    password hash is readable by nobody but the service role (and SECURITY DEFINER functions).
-- 3. email_auth_codes: one-time 6-digit codes, stored only as HMAC-SHA-256 (the Edge Function holds the key), 5 attempts, a few
--    minutes of life. A pending registration keeps its password hash and referral code HERE until the code is proved, so nobody
--    can pre-claim someone else's address with their own password.
-- 4. auth_rate_events + auth_rate_hit(): a shared, database-backed rate limiter (Edge isolates do not share memory).
-- 5. web_auth_issue_code() / web_auth_verify_code(): every rule of issuing and redeeming a code, atomic. Service role only.
-- 6. admin_find_users(): also by e-mail, and shows it.
-- =============================================================================

-- ---- 1. users ---------------------------------------------------------------------------------------------------------------
alter table public.users alter column telegram_id drop not null;
alter table public.users
  add column email             text,
  add column email_verified_at timestamptz,
  add column password_hash     text,
  add constraint users_email_format check (email is null or (email = lower(email) and length(email) <= 254 and email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$')),
  add constraint users_has_identity check (telegram_id is not null or email is not null),
  add constraint users_password_hash_format check (password_hash is null or password_hash ~ '^pbkdf2_sha256\$[0-9]{6,7}\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
  add constraint users_email_verified_pair check (email is null or email_verified_at is not null);
create unique index users_email_lower_uq on public.users (lower(email)) where email is not null;

-- ---- 2. column privileges ---------------------------------------------------------------------------------------------------
-- Table-level SELECT would include password_hash (a column grant cannot take one column back out of a table grant).
revoke select on public.users from anon, authenticated;
grant select (id, telegram_id, username, first_name, language_code, is_banned, created_at, updated_at, is_admin, notifications_enabled,
              referred_by, referred_at, referral_code, referral_reward_percentage, tier_id, bot_blocked_at, email, email_verified_at)
  on public.users to authenticated;

-- ---- 3. codes -----------------------------------------------------------------------------------------------------------------
create table public.email_auth_codes (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null check (email = lower(email) and length(email) between 3 and 254),
  user_id               uuid references public.users(id) on delete cascade,
  purpose               text not null check (purpose in ('register_verify', 'login_code', 'reset_password', 'link_email')),
  code_hash             text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts              integer not null default 0 check (attempts >= 0),
  max_attempts          integer not null default 5 check (max_attempts between 1 and 20),
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now(),
  -- a registration waiting for its code: what the account will be created with
  pending_password_hash text check (pending_password_hash is null or pending_password_hash ~ '^pbkdf2_sha256\$'),
  pending_referral_code text check (pending_referral_code is null or pending_referral_code ~ '^[a-z0-9]{6,32}$')
);
create index idx_email_auth_codes_open on public.email_auth_codes (email, purpose, created_at desc) where consumed_at is null;
alter table public.email_auth_codes enable row level security;
revoke all on public.email_auth_codes from public, anon, authenticated;

-- ---- 4. rate limiter ----------------------------------------------------------------------------------------------------------
create table public.auth_rate_events (
  bucket     text not null check (length(bucket) between 3 and 200),
  created_at timestamptz not null default now()
);
create index idx_auth_rate_events_bucket on public.auth_rate_events (bucket, created_at);
alter table public.auth_rate_events enable row level security;
revoke all on public.auth_rate_events from public, anon, authenticated;

-- True and counted if `bucket` had fewer than `p_limit` hits in the last `p_window_seconds`; false (not counted) otherwise.
create function public.auth_rate_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hits integer;
begin
  if p_bucket is null or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid_parameter_value: bucket, limit and window are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('auth_rate:' || p_bucket));
  delete from auth_rate_events where bucket = p_bucket and created_at < now() - make_interval(secs => greatest(p_window_seconds, 86400));
  if random() < 0.01 then delete from auth_rate_events where created_at < now() - interval '2 days'; end if;
  select count(*) into v_hits from auth_rate_events where bucket = p_bucket and created_at > now() - make_interval(secs => p_window_seconds);
  if v_hits >= p_limit then return false; end if;
  insert into auth_rate_events (bucket) values (p_bucket);
  return true;
end;
$$;

-- ---- 5. issuing and redeeming codes -------------------------------------------------------------------------------------------
-- What the caller learns is deliberately coarse: 'issued' (send the e-mail) or 'suppressed' (send nothing) both answer the
-- customer the same way, so the endpoint cannot be used to find out who has an account.
create function public.web_auth_issue_code(
  p_email                 text,
  p_purpose               text,
  p_code_hash             text,
  p_ttl_seconds           integer default 600,
  p_pending_password_hash text default null,
  p_pending_referral_code text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_user   users%rowtype;
  v_last   timestamptz;
  v_id     uuid;
  v_expire timestamptz;
begin
  if p_purpose not in ('register_verify', 'login_code', 'reset_password') then
    raise exception 'invalid_parameter_value: unknown purpose' using errcode = 'invalid_parameter_value';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 60 and 3600 then
    raise exception 'invalid_parameter_value: ttl must be 60..3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  if p_purpose = 'register_verify' and p_pending_password_hash is null then
    raise exception 'invalid_parameter_value: a registration needs a password' using errcode = 'invalid_parameter_value';
  end if;

  -- one code a minute per address and purpose, five an hour per address
  perform pg_advisory_xact_lock(hashtext('email_code:' || v_email));
  select max(created_at) into v_last from email_auth_codes where email = v_email and purpose = p_purpose;
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('status', 'cooldown', 'retry_after', ceil(extract(epoch from v_last + interval '60 seconds' - now())));
  end if;
  if not auth_rate_hit('code:' || v_email, 5, 3600) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  select * into v_user from users where email = v_email;
  if p_purpose = 'register_verify' then
    if found then return jsonb_build_object('status', 'suppressed'); end if;   -- already registered: nothing to send
    if not coalesce((select global_signups_enabled from platform_settings where id = 1), true) then
      raise exception 'signups_paused: new registrations are switched off' using errcode = 'check_violation';
    end if;
  elsif not found or v_user.is_banned then
    return jsonb_build_object('status', 'suppressed');
  end if;

  -- a new code replaces any open one of the same purpose
  update email_auth_codes set consumed_at = now() where email = v_email and purpose = p_purpose and consumed_at is null;
  v_expire := now() + make_interval(secs => p_ttl_seconds);
  insert into email_auth_codes (email, user_id, purpose, code_hash, expires_at, pending_password_hash, pending_referral_code)
  values (v_email, v_user.id, p_purpose, p_code_hash, v_expire,
          case when p_purpose = 'register_verify' then p_pending_password_hash end,
          case when p_purpose = 'register_verify' then nullif(lower(btrim(p_pending_referral_code)), '') end)
  returning id into v_id;
  return jsonb_build_object('status', 'issued', 'code_id', v_id, 'expires_at', v_expire);
end;
$$;

-- Redeems the newest open code of (email, purpose). A wrong code costs one of max_attempts (counted even though nothing else is
-- written); the last wrong one locks the code. On success: register_verify creates the verified account (and applies the
-- invite), login_code signs in, reset_password replaces the password. Returns {status, user?}.
create function public.web_auth_verify_code(
  p_email             text,
  p_purpose           text,
  p_code_hash         text,
  p_new_password_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email    text := lower(btrim(coalesce(p_email, '')));
  c          email_auth_codes%rowtype;
  u          users%rowtype;
  v_referral boolean := false;
begin
  if p_purpose not in ('register_verify', 'login_code', 'reset_password') then
    raise exception 'invalid_parameter_value: unknown purpose' using errcode = 'invalid_parameter_value';
  end if;
  if p_purpose = 'reset_password' and p_new_password_hash is null then
    raise exception 'invalid_parameter_value: a new password is required' using errcode = 'invalid_parameter_value';
  end if;

  select * into c from email_auth_codes
   where email = v_email and purpose = p_purpose and consumed_at is null
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

  if p_purpose = 'register_verify' then
    select * into u from users where email = v_email;
    if found then return jsonb_build_object('status', 'already_registered'); end if;
    if not coalesce((select global_signups_enabled from platform_settings where id = 1), true) then
      raise exception 'signups_paused: new registrations are switched off' using errcode = 'check_violation';
    end if;
    insert into users (email, email_verified_at, password_hash) values (v_email, now(), c.pending_password_hash)
    returning * into u;   -- the wallet and the default tier come from the existing triggers
    update email_auth_codes set user_id = u.id where id = c.id;
    if c.pending_referral_code is not null then
      begin
        perform apply_referral(u.id, c.pending_referral_code);
        v_referral := true;
      exception when others then
        v_referral := false;   -- an unknown or unusable invite never blocks the registration
      end;
    end if;
  else
    select * into u from users where email = v_email for update;
    if not found then return jsonb_build_object('status', 'invalid'); end if;
    if p_purpose = 'reset_password' then
      update users set password_hash = p_new_password_hash where id = u.id returning * into u;
      -- every other open code of this address is void after a password change
      update email_auth_codes set consumed_at = now() where email = v_email and consumed_at is null;
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'referral_applied', v_referral, 'user', jsonb_build_object(
    'id', u.id, 'telegram_id', u.telegram_id, 'email', u.email, 'username', u.username, 'first_name', u.first_name,
    'language_code', u.language_code, 'is_banned', u.is_banned, 'is_admin', u.is_admin));
end;
$$;

revoke all on function public.auth_rate_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.web_auth_issue_code(text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.web_auth_verify_code(text, text, text, text) from public, anon, authenticated;
grant execute on function public.auth_rate_hit(text, integer, integer) to service_role;
grant execute on function public.web_auth_issue_code(text, text, text, integer, text, text) to service_role;
grant execute on function public.web_auth_verify_code(text, text, text, text) to service_role;

-- ---- 6. admin_find_users: by e-mail too ----------------------------------------------------------------------------------------
create or replace function public.admin_find_users(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := require_admin();
  v_q     text := btrim(coalesce(p_query, ''));
  v_name  text;
  v_mail  text;
begin
  if length(v_q) < 2 or length(v_q) > 64 then
    raise exception 'invalid_parameter_value: type 2 to 64 characters' using errcode = 'invalid_parameter_value';
  end if;
  -- typed text is matched literally: LIKE wildcards are escaped
  v_name := replace(replace(replace(ltrim(v_q, '@'), '\', '\\'), '%', '\%'), '_', '\_');
  v_mail := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select jsonb_agg(r order by r->>'created_at' desc)
      from (
        select jsonb_build_object(
                 'id', u.id, 'telegram_id', u.telegram_id, 'username', u.username, 'first_name', u.first_name, 'email', u.email,
                 'is_banned', u.is_banned, 'is_admin', u.is_admin, 'created_at', u.created_at,
                 'balance', coalesce((select sum(w.balance) from wallets w where w.user_id = u.id), 0),
                 'orders', (select count(*) from orders o where o.user_id = u.id and o.status <> 'draft'),
                 'is_you', u.id = v_admin) r
          from users u
         where (v_q ~ '^[0-9]{1,19}$' and u.telegram_id = v_q::bigint)
            or (v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and u.id = v_q::uuid)
            or (u.username ilike v_name || '%')
            or (u.email is not null and u.email like v_mail || '%')
         order by u.created_at desc
         limit 20
      ) found
  ), '[]'::jsonb);
end;
$$;
