-- =============================================================================
-- Phase 20: customer support tickets
--
--   support_tickets    one conversation per problem, optionally about one of the customer's own orders
--   ticket_messages    its messages, APPEND-ONLY (a support history is evidence: nothing is edited or deleted)
--
-- Who sees what is decided in SQL, not in the app:
--   * every customer function takes the user's id from the JWT (the Edge Function), and a ticket that is not theirs is simply
--     "not found" (the same answer as one that does not exist, so ticket ids cannot be probed)
--   * every admin function re-checks that the actor is an admin (assert_catalog_admin), on top of the Edge Function's own check
--   * the tables have row level security on and no client grants at all; all access is through these service-role functions
--
-- Status is kept by triggers, not by the app:
--   open       the customer wrote last: waiting for support (what admins work through, oldest first)
--   answered   support wrote last: waiting for the customer
--   resolved   support says it is solved; a new customer message reopens it
--   closed     final: no more messages, no way back
-- =============================================================================

create type public.ticket_status as enum ('open', 'answered', 'resolved', 'closed');

create table public.support_tickets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete restrict,
  order_id   uuid references public.orders(id) on delete restrict,
  subject    text not null check (char_length(subject) between 3 and 120),
  status     public.ticket_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_tickets_user on public.support_tickets (user_id, updated_at desc);
create index idx_tickets_queue on public.support_tickets (status, updated_at);
create index idx_tickets_order on public.support_tickets (order_id) where order_id is not null;

create table public.ticket_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.support_tickets(id) on delete cascade,
  sender_id    uuid not null references public.users(id) on delete restrict,   -- the customer, or the admin who answered
  is_admin     boolean not null,
  message_text text not null check (char_length(message_text) between 1 and 4000),
  created_at   timestamptz not null default now()
);
create index idx_ticket_messages_ticket on public.ticket_messages (ticket_id, created_at, id);

create trigger trg_ticket_messages_no_update before update on public.ticket_messages
  for each row execute function public.forbid_mutation();
create trigger trg_ticket_messages_no_delete before delete on public.ticket_messages
  for each row execute function public.forbid_mutation();
create trigger trg_ticket_messages_no_truncate before truncate on public.ticket_messages
  for each statement execute function public.forbid_mutation();

alter table public.support_tickets enable row level security;
alter table public.ticket_messages enable row level security;
revoke all on table public.support_tickets, public.ticket_messages from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. Triggers: what a ticket may change, and how a message moves its status
-- -----------------------------------------------------------------------------
-- Who owns a ticket, what it is about and when it was opened never change; a closed ticket stays closed.
create function public.guard_ticket()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.user_id is distinct from old.user_id or new.order_id is distinct from old.order_id
     or new.subject is distinct from old.subject or new.created_at is distinct from old.created_at then
    raise exception 'a ticket''s owner, order and subject cannot change' using errcode = 'restrict_violation';
  end if;
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'ticket_closed: a closed ticket cannot be reopened' using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger trg_tickets_guard before update on public.support_tickets
  for each row execute function public.guard_ticket();

-- Nothing can be written to a closed ticket, and a message must come from who it says it comes from.
create function public.guard_ticket_message()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  t support_tickets%rowtype;
begin
  select * into t from support_tickets where id = new.ticket_id for update;   -- serialises the messages of one ticket
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';
  end if;
  if t.status = 'closed' then
    raise exception 'ticket_closed: this ticket is closed' using errcode = 'restrict_violation';
  end if;
  if new.is_admin then
    if not exists (select 1 from users where id = new.sender_id and is_admin and not is_banned) then
      raise exception 'forbidden: only an admin can answer as support' using errcode = 'insufficient_privilege';
    end if;
  elsif new.sender_id <> t.user_id then
    raise exception 'forbidden: only the ticket owner can write as the customer' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger trg_ticket_messages_guard before insert on public.ticket_messages
  for each row execute function public.guard_ticket_message();

-- The status follows the conversation: support replies -> answered; the customer writes -> open (also reopens a resolved ticket).
create function public.trg_ticket_message_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update support_tickets
     set status = case when new.is_admin then 'answered'::ticket_status else 'open'::ticket_status end
   where id = new.ticket_id and status <> 'closed';   -- the guard trigger stamps updated_at
  return null;
end;
$$;
create trigger trg_ticket_messages_status after insert on public.ticket_messages
  for each row execute function public.trg_ticket_message_status();

-- -----------------------------------------------------------------------------
-- 2. Customer functions (the user id comes from the verified JWT, never from the request)
-- -----------------------------------------------------------------------------
create function public.support_ticket_json(t support_tickets)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', t.id, 'subject', t.subject, 'status', t.status, 'created_at', t.created_at, 'updated_at', t.updated_at,
    'order', case when o.id is null then null else jsonb_build_object('id', o.id, 'status', o.status, 'quantity', o.quantity,
               'charge_amount', o.charge_amount, 'service_name', s.name) end)
  from (select 1) x
  left join orders o on o.id = t.order_id
  left join services s on s.id = o.service_id
$$;

create function public.support_messages_json(p_ticket uuid)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'is_admin', m.is_admin, 'text', m.message_text, 'created_at', m.created_at)
                            order by m.created_at, m.id), '[]'::jsonb)
    from ticket_messages m where m.ticket_id = p_ticket
$$;

create function public.support_create_ticket(p_user_id uuid, p_subject text, p_message text, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text := btrim(coalesce(p_subject, ''));
  v_message text := btrim(coalesce(p_message, ''));
  t         support_tickets%rowtype;
begin
  if char_length(v_subject) not between 3 and 120 then
    raise exception 'invalid_parameter_value: the subject must be 3 to 120 characters' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_message) not between 1 and 4000 then
    raise exception 'invalid_parameter_value: the message must be 1 to 4000 characters' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from users where id = p_user_id for update;   -- serialises this customer's tickets, so the caps below hold under load
  if not found then
    raise exception 'user % not found', p_user_id using errcode = 'no_data_found';
  end if;
  -- an order can only be attached by its owner; any other id is "not found", exactly like one that does not exist
  if p_order_id is not null and not exists (select 1 from orders where id = p_order_id and user_id = p_user_id) then
    raise exception 'order_not_found: that order is not yours or does not exist' using errcode = 'no_data_found';
  end if;
  if (select count(*) from support_tickets where user_id = p_user_id and status in ('open', 'answered')) >= 5 then
    raise exception 'too_many_open_tickets: please wait for an answer to your open tickets' using errcode = 'check_violation';
  end if;
  if (select count(*) from ticket_messages where sender_id = p_user_id and not is_admin and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited: too many messages, try again later' using errcode = 'check_violation';
  end if;

  insert into support_tickets (user_id, order_id, subject) values (p_user_id, p_order_id, v_subject) returning * into t;
  insert into ticket_messages (ticket_id, sender_id, is_admin, message_text) values (t.id, p_user_id, false, v_message);
  select * into t from support_tickets where id = t.id;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;

create function public.support_list_my_tickets(p_user_id uuid, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(support_ticket_json(t) || jsonb_build_object(
           'last_message', (select left(m.message_text, 140) from ticket_messages m where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1),
           'last_from_support', (select m.is_admin from ticket_messages m where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1)
         ) order by t.updated_at desc, t.id), '[]'::jsonb)
    from (select * from support_tickets where user_id = p_user_id order by updated_at desc, id
           limit least(greatest(coalesce(p_limit, 30), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) t
$$;

create function public.support_get_ticket(p_user_id uuid, p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  t support_tickets%rowtype;
begin
  select * into t from support_tickets where id = p_ticket_id and user_id = p_user_id;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';   -- someone else's ticket reads exactly like a missing one
  end if;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;

create function public.support_add_message(p_user_id uuid, p_ticket_id uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  t      support_tickets%rowtype;
begin
  if char_length(v_text) not between 1 and 4000 then
    raise exception 'invalid_parameter_value: the message must be 1 to 4000 characters' using errcode = 'invalid_parameter_value';
  end if;
  select * into t from support_tickets where id = p_ticket_id and user_id = p_user_id for update;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';
  end if;
  if t.status = 'closed' then
    raise exception 'ticket_closed: this ticket is closed' using errcode = 'restrict_violation';
  end if;
  if (select count(*) from ticket_messages where sender_id = p_user_id and not is_admin and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited: too many messages, try again later' using errcode = 'check_violation';
  end if;
  insert into ticket_messages (ticket_id, sender_id, is_admin, message_text) values (t.id, p_user_id, false, v_text);
  select * into t from support_tickets where id = t.id;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Admin functions
-- -----------------------------------------------------------------------------
-- The queue: tickets waiting for support first, the one waiting longest on top; then the rest, newest activity first.
create function public.admin_support_list(p_actor uuid, p_status public.ticket_status default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform assert_catalog_admin(p_actor);
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from support_tickets group by status) c),
    'tickets', coalesce((
      select jsonb_agg(support_ticket_json(t) || jsonb_build_object(
               'user', jsonb_build_object('id', u.id, 'first_name', u.first_name, 'username', u.username),
               'last_message', (select left(m.message_text, 140) from ticket_messages m where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1)
             ) order by (t.status <> 'open'), case when t.status = 'open' then extract(epoch from t.updated_at) else -extract(epoch from t.updated_at) end, t.id)
        from (select * from support_tickets where p_status is null or status = p_status
               order by (status <> 'open'), case when status = 'open' then extract(epoch from updated_at) else -extract(epoch from updated_at) end, id
               limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) t
        join users u on u.id = t.user_id), '[]'::jsonb));
end;
$$;

create function public.admin_support_get(p_actor uuid, p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  t support_tickets%rowtype;
  u users%rowtype;
begin
  perform assert_catalog_admin(p_actor);
  select * into t from support_tickets where id = p_ticket_id;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';
  end if;
  select * into u from users where id = t.user_id;
  return support_ticket_json(t) || jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'first_name', u.first_name, 'username', u.username),
    'messages', support_messages_json(t.id));
end;
$$;

create function public.admin_support_reply(p_actor uuid, p_ticket_id uuid, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  t      support_tickets%rowtype;
  v_msg  uuid;
begin
  perform assert_catalog_admin(p_actor);
  if char_length(v_text) not between 1 and 4000 then
    raise exception 'invalid_parameter_value: the message must be 1 to 4000 characters' using errcode = 'invalid_parameter_value';
  end if;
  select * into t from support_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';
  end if;
  if t.status = 'closed' then
    raise exception 'ticket_closed: this ticket is closed' using errcode = 'restrict_violation';
  end if;
  insert into ticket_messages (ticket_id, sender_id, is_admin, message_text) values (t.id, p_actor, true, v_text) returning id into v_msg;
  insert into admin_audit_log (admin_id, action, target_id, details) values (p_actor, 'support_reply', t.id::text, jsonb_build_object('message_id', v_msg));
  select * into t from support_tickets where id = t.id;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id), 'message_id', v_msg, 'user_id', t.user_id);
end;
$$;

-- resolved: solved (the customer may still reply and reopen it); closed: final.
create function public.admin_support_set_status(p_actor uuid, p_ticket_id uuid, p_status public.ticket_status)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t   support_tickets%rowtype;
  old public.ticket_status;
begin
  perform assert_catalog_admin(p_actor);
  if p_status not in ('resolved', 'closed') then
    raise exception 'invalid_parameter_value: a ticket can be set to resolved or closed; the conversation moves the other statuses' using errcode = 'invalid_parameter_value';
  end if;
  select * into t from support_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'ticket_not_found' using errcode = 'no_data_found';
  end if;
  old := t.status;
  if old = 'closed' then
    raise exception 'ticket_closed: this ticket is closed' using errcode = 'restrict_violation';
  end if;
  if old <> p_status then
    update support_tickets set status = p_status where id = t.id;
    insert into admin_audit_log (admin_id, action, target_id, details)
    values (p_actor, 'support_' || p_status::text, t.id::text, jsonb_build_object('status', jsonb_build_array(old, p_status)));
  end if;
  select * into t from support_tickets where id = t.id;
  return support_ticket_json(t) || jsonb_build_object('messages', support_messages_json(t.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Access: service role only
-- -----------------------------------------------------------------------------
revoke all on function public.guard_ticket() from public, anon, authenticated;
revoke all on function public.guard_ticket_message() from public, anon, authenticated;
revoke all on function public.trg_ticket_message_status() from public, anon, authenticated;
revoke all on function public.support_ticket_json(support_tickets) from public, anon, authenticated;
revoke all on function public.support_messages_json(uuid) from public, anon, authenticated;
revoke all on function public.support_create_ticket(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.support_list_my_tickets(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.support_get_ticket(uuid, uuid) from public, anon, authenticated;
revoke all on function public.support_add_message(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_support_list(uuid, public.ticket_status, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_support_get(uuid, uuid) from public, anon, authenticated;
revoke all on function public.admin_support_reply(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_support_set_status(uuid, uuid, public.ticket_status) from public, anon, authenticated;
grant execute on function public.support_create_ticket(uuid, text, text, uuid) to service_role;
grant execute on function public.support_list_my_tickets(uuid, integer, integer) to service_role;
grant execute on function public.support_get_ticket(uuid, uuid) to service_role;
grant execute on function public.support_add_message(uuid, uuid, text) to service_role;
grant execute on function public.admin_support_list(uuid, public.ticket_status, integer, integer) to service_role;
grant execute on function public.admin_support_get(uuid, uuid) to service_role;
grant execute on function public.admin_support_reply(uuid, uuid, text) to service_role;
grant execute on function public.admin_support_set_status(uuid, uuid, public.ticket_status) to service_role;
