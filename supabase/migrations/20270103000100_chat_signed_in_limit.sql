-- The larger hour of the AI assistant is for every signed-in customer, not only for those who have paid.
--
-- Migration 20270101000000 gave the larger hour (100) to a customer with money on the balance or a completed ledger line, and the small one (20) to a guest or
-- a signed-in account that never paid. That is the wrong way round for the customers who need the assistant most: people look at the services, and ask the
-- assistant what to buy, BEFORE they top up. So now:
--
--   * a signed-in customer (the Vercel function sends a token WE signed, and the account exists) gets p_paying_limit (100 by default), paid or not;
--   * a guest (no token, counted by a keyed hash of the address) keeps p_limit (20): an anonymous caller is the one that can be a script.
--
-- `paying` in the answer keeps its meaning (money on the balance or any completed ledger line) and no longer decides the limit: it is how the log tells
-- paying customers from browsers, and how we will see how many people ask before they pay. The signature and the shape of the answer do not change (the
-- parameter keeps its old name, p_paying_limit: it is now the limit of a signed-in customer), so the Edge Function that is deployed next to this migration
-- and the one before it both work with it.

create or replace function public.chat_rate_hit(p_identifier text, p_limit integer, p_window_seconds integer, p_user_id uuid default null, p_paying_limit integer default null)
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

  if p_user_id is not null and p_paying_limit is not null and exists (select 1 from users u where u.id = p_user_id) then
    -- a signed-in customer: the larger hour, whether or not they have paid yet
    v_limit := greatest(p_paying_limit, p_limit);
    -- money on the balance, or any completed ledger line (a customer who spent everything is still a customer): only the kind of caller, for the log
    select exists (select 1 from wallets w where w.user_id = p_user_id and w.balance > 0)
        or exists (select 1 from wallets w join wallet_transactions t on t.wallet_id = w.id where w.user_id = p_user_id and t.status = 'completed')
      into v_paying;
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
