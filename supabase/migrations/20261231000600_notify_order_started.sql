-- The customer is told on Telegram when the provider has begun the order (status in_progress), next to the messages for completed / partial /
-- canceled that the outbox (20261109000000) already queues. Same mechanism: a row in notification_outbox written by the trigger in the SAME
-- transaction as the status change (one INSERT, a failure inside is swallowed and can never fail an order), sent later by telegram-notifier
-- with retries. Nothing here touches the network.
--
-- kind 'started'. Its dedupe key is 'order:<id>:started'. Unlike the final messages it is not held back 30 seconds (there is no fast path in the
-- sync worker to wait for). The notifier skips it when the order has already finished by the time it is sent.

alter table public.notification_outbox drop constraint if exists notification_outbox_kind_check;
alter table public.notification_outbox
  add constraint notification_outbox_kind_check check (kind in ('started', 'completed', 'partial', 'canceled', 'admin_alert', 'admin_hub'));

create or replace function public.trg_orders_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := case new.status when 'in_progress' then 'started' when 'completed' then 'completed' when 'partial' then 'partial' else 'canceled' end;
begin
  begin
    insert into notification_outbox (order_id, user_id, kind, dedupe_key, next_attempt_at)
    values (new.id, new.user_id, v_kind, 'order:' || new.id || ':' || v_kind,
            case when v_kind = 'started' then now() else now() + interval '30 seconds' end)
    on conflict (dedupe_key) do nothing;
  exception when others then
    raise warning 'notification outbox: order % skipped: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists trg_orders_notify on public.orders;
create trigger trg_orders_notify after update of status on public.orders
  for each row when (old.status is distinct from new.status and new.status in ('in_progress', 'completed', 'partial', 'canceled', 'failed'))
  execute function public.trg_orders_notify();
