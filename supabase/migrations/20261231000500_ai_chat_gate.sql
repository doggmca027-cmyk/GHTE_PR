-- The AI assistant (/api/chat on Vercel): the log of what customers ask it, and the hourly limit on its questions.
--
--   * ai_chat_logs   what was asked, what the assistant understood, which services it had and which it recommended. The owner reads it to see what
--                    customers look for and widen the catalogue. A question is stored with the Telegram ID of a signed-in customer, or, for a guest, a
--                    one-way hash of the IP address (an address itself is never stored). Rows older than 90 days are deleted.
--   * ai_chat_hits   one row per question counted against the limit (20 an hour for one person), so the limit is the same on every Vercel instance.
--
-- Neither table is readable or writable by a client role. Only the chat-gate Edge Function reaches them, through the three service-role functions
-- below; the Vercel function that holds the model's key never gets a database key (it calls chat-gate with a shared secret).

-- ---- 1. who: the shape of an identifier ---------------------------------------------------------------------------------------------------
-- tg:<Telegram ID> | user:<account id> (a signed-in customer without a Telegram ID) | ip:<16 hex of a keyed hash> (a guest). The check is on both
-- tables, so no raw IP address can be written by mistake.

create table public.ai_chat_logs (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  user_identifier  text not null check (user_identifier ~ '^(tg:[0-9]{1,20}|user:[0-9a-f-]{36}|ip:[0-9a-f]{16})$'),
  user_prompt      text not null check (length(user_prompt) between 1 and 500),
  extracted_intent jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted_intent) = 'object' and length(extracted_intent::text) <= 2000),
  matched_skus     text[] not null default '{}' check (cardinality(matched_skus) <= 20),
  recommended_skus text[] not null default '{}' check (cardinality(recommended_skus) <= 10),
  found_count      integer not null default 0 check (found_count between 0 and 1000),
  tool_calls       integer not null default 0 check (tool_calls between 0 and 50),
  model            text check (model is null or length(model) <= 80)
);
create index idx_ai_chat_logs_created_at on public.ai_chat_logs (created_at desc);
alter table public.ai_chat_logs enable row level security;
revoke all on public.ai_chat_logs from public, anon, authenticated;

create table public.ai_chat_hits (
  identifier text not null check (identifier ~ '^(tg:[0-9]{1,20}|user:[0-9a-f-]{36}|ip:[0-9a-f]{16})$'),
  created_at timestamptz not null default now()
);
create index idx_ai_chat_hits_identifier on public.ai_chat_hits (identifier, created_at);
alter table public.ai_chat_hits enable row level security;
revoke all on public.ai_chat_hits from public, anon, authenticated;

-- ---- 2. the limit ---------------------------------------------------------------------------------------------------------------------------
-- Counts one question for `p_identifier` if it has asked fewer than `p_limit` in the last `p_window_seconds`. Always answers:
--   { allowed, limit, remaining, retry_after }   retry_after: seconds until a place frees up (0 when allowed)
-- A blocked question is not counted, so waiting is never punished. One caller at a time per identifier (advisory lock): two questions sent together
-- cannot both take the last place.
create function public.chat_rate_hit(p_identifier text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hits   integer;
  v_oldest timestamptz;
begin
  if p_identifier is null or p_identifier !~ '^(tg:[0-9]{1,20}|user:[0-9a-f-]{36}|ip:[0-9a-f]{16})$'
     or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid_parameter_value: a known identifier, a limit and a window are required' using errcode = 'invalid_parameter_value';
  end if;
  perform pg_advisory_xact_lock(hashtext('ai_chat_hit:' || p_identifier));

  select count(*), min(created_at) into v_hits, v_oldest
    from ai_chat_hits where identifier = p_identifier and created_at > now() - make_interval(secs => p_window_seconds);

  if v_hits >= p_limit then
    return jsonb_build_object(
      'allowed', false, 'limit', p_limit, 'remaining', 0,
      'retry_after', greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - now())))::integer));
  end if;

  insert into ai_chat_hits (identifier) values (p_identifier);
  return jsonb_build_object('allowed', true, 'limit', p_limit, 'remaining', p_limit - v_hits - 1, 'retry_after', 0);
end;
$$;

-- ---- 3. the log -----------------------------------------------------------------------------------------------------------------------------
-- Deletes what is past its time: log rows after `p_days` days, counted questions after two days (the window is an hour). Returns the log rows deleted.
create function public.purge_ai_chat_logs(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if p_days is null or p_days < 1 then
    raise exception 'invalid_parameter_value: p_days must be at least 1' using errcode = 'invalid_parameter_value';
  end if;
  delete from ai_chat_hits where created_at < now() - interval '2 days';
  delete from ai_chat_logs where created_at < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Writes one line of the log. The Edge Function has cleaned the values already; the checks of the table and the cut-offs here are the second wall.
-- The old rows are deleted in passing (one call in fifty): nothing has to be scheduled, and it works where pg_cron does not.
create function public.record_ai_chat_log(
  p_user_identifier text,
  p_prompt          text,
  p_intent          jsonb,
  p_matched         text[],
  p_recommended     text[],
  p_found_count     integer,
  p_tool_calls      integer,
  p_model           text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into ai_chat_logs (user_identifier, user_prompt, extracted_intent, matched_skus, recommended_skus, found_count, tool_calls, model)
  values (
    p_user_identifier,
    left(btrim(p_prompt), 500),
    coalesce(p_intent, '{}'::jsonb),
    coalesce(p_matched[1:20], '{}'::text[]),
    coalesce(p_recommended[1:10], '{}'::text[]),
    least(greatest(coalesce(p_found_count, 0), 0), 1000),
    least(greatest(coalesce(p_tool_calls, 0), 0), 50),
    left(p_model, 80)
  );
  if random() < 0.02 then
    perform purge_ai_chat_logs(90);
  end if;
end;
$$;

-- ---- 4. who may call them -------------------------------------------------------------------------------------------------------------------
revoke all on function public.chat_rate_hit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_ai_chat_logs(integer) from public, anon, authenticated;
revoke all on function public.record_ai_chat_log(text, text, jsonb, text[], text[], integer, integer, text) from public, anon, authenticated;
grant execute on function public.chat_rate_hit(text, integer, integer) to service_role;
grant execute on function public.purge_ai_chat_logs(integer) to service_role;
grant execute on function public.record_ai_chat_log(text, text, jsonb, text[], text[], integer, integer, text) to service_role;
