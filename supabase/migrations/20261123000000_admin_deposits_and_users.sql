-- =============================================================================
-- Admin panel: decide deposit cases and suspend users from the UI.
--
-- 1. list_reconciliation_cases() also describes a DEPOSIT case (the deposit, its customer), so the admin can credit or dismiss it
--    with admin_resolve_deposit() (already a guarded client RPC), and carries the customer's user id for orders and deposits so a
--    customer can be suspended from the case with admin_set_user_ban(). Service role only, as before.
-- 2. admin_find_users(query): look a customer up by Telegram id, user id or @username (at most 20), with what the admin needs to
--    decide a suspension. A client RPC guarded by require_admin(), like admin_set_user_ban().
-- =============================================================================

create or replace function public.list_reconciliation_cases()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'entity_type', c.entity_type, 'entity_id', c.entity_id, 'reason', c.reason, 'created_at', c.created_at,
    'order', case when o.id is null then null else jsonb_build_object(
      'status', o.status, 'charge_amount', o.charge_amount, 'quantity', o.quantity, 'target_url', o.target_url,
      'provider_order_id', o.provider_order_id, 'error_message', o.error_message, 'created_at', o.created_at,
      'has_routing_snapshot', o.provider_offer_id is not null,
      'service_name', s.name, 'username', u.username, 'telegram_id', u.telegram_id, 'user_id', u.id, 'user_banned', u.is_banned) end,
    'payment', case when pp.id is null then null else jsonb_build_object(
      'status', pp.status, 'provider_name', pv.name, 'amount', pp.amount, 'currency', pp.currency, 'asset', pp.asset,
      'network', pp.network, 'destination_wallet', pp.destination_wallet, 'tx_hash', pp.tx_hash,
      'broadcasted_at', pp.broadcasted_at, 'confirmed_at', pp.confirmed_at, 'created_at', pp.created_at) end,
    'deposit', case when d.id is null then null else jsonb_build_object(
      'status', d.status, 'amount_usd', d.amount_usd, 'amount_crypto', d.amount_crypto, 'asset', d.asset, 'network', d.network,
      'memo', d.memo, 'tx_hash', d.tx_hash, 'received_amount_nano', d.received_amount_nano, 'valid_until', d.valid_until,
      'created_at', d.created_at, 'username', du.username, 'telegram_id', du.telegram_id, 'user_id', du.id, 'user_banned', du.is_banned) end
  ) order by c.created_at), '[]'::jsonb)
  from reconciliation_cases c
  left join orders o on c.entity_type = 'order' and o.id::text = c.entity_id
  left join users u on u.id = o.user_id
  left join services s on s.id = o.service_id
  left join provider_payments pp on c.entity_type = 'provider_payment' and pp.id::text = c.entity_id
  left join providers pv on pv.id = pp.provider_id
  left join deposits d on c.entity_type = 'deposit' and d.id::text = c.entity_id
  left join users du on du.id = d.user_id
  where c.status = 'open'
$$;

create function public.admin_find_users(p_query text)
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
begin
  if length(v_q) < 2 or length(v_q) > 64 then
    raise exception 'invalid_parameter_value: type 2 to 64 characters' using errcode = 'invalid_parameter_value';
  end if;
  -- a username is matched as text only: LIKE wildcards typed by the admin are taken literally
  v_name := replace(replace(replace(ltrim(v_q, '@'), '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select jsonb_agg(r order by r->>'created_at' desc)
      from (
        select jsonb_build_object(
                 'id', u.id, 'telegram_id', u.telegram_id, 'username', u.username, 'first_name', u.first_name,
                 'is_banned', u.is_banned, 'is_admin', u.is_admin, 'created_at', u.created_at,
                 'balance', coalesce((select sum(w.balance) from wallets w where w.user_id = u.id), 0),
                 'orders', (select count(*) from orders o where o.user_id = u.id and o.status <> 'draft'),
                 'is_you', u.id = v_admin) r
          from users u
         where (v_q ~ '^[0-9]{1,19}$' and u.telegram_id = v_q::bigint)
            or (v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and u.id = v_q::uuid)
            or (u.username ilike v_name || '%')
         order by u.created_at desc
         limit 20
      ) found
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_find_users(text) from public, anon;
grant execute on function public.admin_find_users(text) to authenticated, service_role;
