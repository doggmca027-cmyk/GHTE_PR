-- The hourly limit of the AI assistant follows the money: a customer who has funds on the balance, or who has ever been through the ledger, is a paying
-- customer and gets a larger hour (100 by default) than a guest or a signed-in account that never paid (20). The same call counts the question and
-- decides which limit applies, so the gate still makes ONE database call per question.
--
-- chat_rate_hit(identifier, limit, window, user_id, paying_limit): with a user id whose wallet holds more than zero, or who has any completed ledger
-- entry, `paying_limit` replaces `limit`. Without them it is the function it replaces (the three-argument call still works).
-- The answer carries `paying` (which limit was used) so the Edge Function can log the kind of caller, never who.

drop function if exists public.chat_rate_hit(text, integer, integer);

create function public.chat_rate_hit(p_identifier text, p_limit integer, p_window_seconds integer, p_user_id uuid default null, p_paying_limit integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hits   integer;
  v_oldest timestamptz;
  v_limit  integer := p_limit;
  v_paying boolean := false;
begin
  if p_identifier is null or p_identifier !~ '^(tg:[0-9]{1,20}|user:[0-9a-f-]{36}|ip:[0-9a-f]{16})$'
     or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1
     or (p_paying_limit is not null and p_paying_limit < 1) then
    raise exception 'invalid_parameter_value: a known identifier, a limit and a window are required' using errcode = 'invalid_parameter_value';
  end if;

  -- money on the balance, or any completed ledger line (a customer who spent everything is still a customer)
  if p_user_id is not null and p_paying_limit is not null then
    select exists (select 1 from wallets w where w.user_id = p_user_id and w.balance > 0)
        or exists (select 1 from wallets w join wallet_transactions t on t.wallet_id = w.id where w.user_id = p_user_id and t.status = 'completed')
      into v_paying;
    if v_paying then v_limit := greatest(p_paying_limit, p_limit); end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('ai_chat_hit:' || p_identifier));

  select count(*), min(created_at) into v_hits, v_oldest
    from ai_chat_hits where identifier = p_identifier and created_at > now() - make_interval(secs => p_window_seconds);

  if v_hits >= v_limit then
    return jsonb_build_object(
      'allowed', false, 'limit', v_limit, 'remaining', 0, 'paying', v_paying,
      'retry_after', greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - now())))::integer));
  end if;

  insert into ai_chat_hits (identifier) values (p_identifier);
  return jsonb_build_object('allowed', true, 'limit', v_limit, 'remaining', v_limit - v_hits - 1, 'paying', v_paying, 'retry_after', 0);
end;
$$;

revoke all on function public.chat_rate_hit(text, integer, integer, uuid, integer) from public, anon, authenticated;
grant execute on function public.chat_rate_hit(text, integer, integer, uuid, integer) to service_role;
