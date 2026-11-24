-- Messagerie restaurant <-> client, suivi de commande par lien sécurisé, statistiques d'historique.
-- order_events (déjà en place, alimentée par le trigger log_order_changes) sert d'historique des statuts : non recréée.

-- 1) Jetons de suivi : seul le hash SHA-256 est stocké ; expiration et révocation ; table privée (hors API).
create table if not exists private.order_access_tokens (
  order_id    uuid primary key references public.orders(id) on delete cascade,
  token_hash  text not null unique,
  channel_key text not null default encode(extensions.gen_random_bytes(16), 'hex'), -- topic Realtime non devinable
  expires_at  timestamptz not null default now() + interval '30 days',
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
alter table private.order_access_tokens enable row level security; -- aucune politique : inaccessible via l'API

create or replace function private.resolve_order_token(p_token text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_order uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32,128}$' then
    raise exception 'Invalid or expired link' using errcode = 'P0002';
  end if;
  select t.order_id into v_order from private.order_access_tokens t
   where t.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and t.revoked_at is null and t.expires_at > now();
  if v_order is null then raise exception 'Invalid or expired link' using errcode = 'P0002'; end if;
  return v_order;
end; $$;
revoke all on function private.resolve_order_token(text) from public, anon, authenticated;

-- 2) submit_public_order : la fonction existante devient le « cœur » privé, le wrapper public ajoute le jeton (aucune duplication).
alter function public.submit_public_order(text,text,text,text,text,text,jsonb,text) set schema private;
alter function private.submit_public_order(text,text,text,text,text,text,jsonb,text) rename to submit_public_order_core;
revoke all on function private.submit_public_order_core(text,text,text,text,text,text,jsonb,text) from public, anon, authenticated, service_role;

create or replace function public.submit_public_order(
  p_restaurant_slug text, p_customer_name text, p_customer_phone text, p_customer_note text default null,
  p_order_type text default 'pickup', p_delivery_address text default null, p_items jsonb default '[]'::jsonb,
  p_source text default 'public_menu')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_token text;
begin
  v := private.submit_public_order_core(p_restaurant_slug, p_customer_name, p_customer_phone, p_customer_note,
                                        p_order_type, p_delivery_address, p_items, p_source);
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into private.order_access_tokens(order_id, token_hash)
  values ((v->>'order_id')::uuid, encode(extensions.digest(v_token, 'sha256'), 'hex'));
  return v || jsonb_build_object('tracking_token', v_token); -- renvoyé une seule fois ; jamais relisible
end; $$;
revoke all on function public.submit_public_order(text,text,text,text,text,text,jsonb,text) from public;
grant execute on function public.submit_public_order(text,text,text,text,text,text,jsonb,text) to anon, authenticated, service_role;

-- 3) Messages
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  sender_type   text not null check (sender_type in ('restaurant', 'customer')),
  sender_id     uuid references auth.users(id) on delete set null,
  content       text not null check (char_length(content) between 1 and 1000),
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists messages_order_created_idx on public.messages (order_id, created_at);
create index if not exists messages_restaurant_created_idx on public.messages (restaurant_id, created_at desc);
create index if not exists messages_unread_idx on public.messages (restaurant_id, order_id) where read_at is null;
create index if not exists messages_sender_id_idx on public.messages (sender_id);

alter table public.messages enable row level security;
revoke all on public.messages from anon, authenticated;
grant select on public.messages to authenticated;
drop policy if exists messages_staff_read on public.messages;
create policy messages_staff_read on public.messages for select to authenticated
  using ((select private.has_restaurant_role(restaurant_id)) or (select private.is_platform_admin()));
-- Aucune politique INSERT/UPDATE/DELETE : toute écriture passe par les fonctions ci-dessous.

create or replace function private.clean_message(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(replace(coalesce(p, ''), E'\r', ''), E'[\\x01-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F\\u200B-\\u200F\\u2028-\\u202E\\u2060\\uFEFF]', '', 'g'),
    E'\n{3,}', E'\n\n', 'g')), '');
$$;
revoke all on function private.clean_message(text) from public, anon, authenticated;

-- Temps réel : ping minimal (jamais le contenu) sur un topic non devinable ; le client relit via RPC.
create or replace function private.notify_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_key text;
begin
  select channel_key into v_key from private.order_access_tokens where order_id = new.order_id;
  if v_key is not null then
    perform realtime.send(jsonb_build_object('id', new.id, 'sender', new.sender_type), tg_op, 'order-chat:' || v_key, false);
  end if;
  return null;
exception when others then return null; -- une panne Realtime ne doit jamais bloquer un message
end; $$;
revoke all on function private.notify_message() from public, anon, authenticated;
drop trigger if exists messages_notify on public.messages;
create trigger messages_notify after insert or update of read_at on public.messages
  for each row execute function private.notify_message();

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- 4) Côté restaurant (JWT)
create or replace function public.send_restaurant_message(p_order_id uuid, p_content text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.orders%rowtype; v_text text; v_msg public.messages%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found or not (select private.has_restaurant_role(v_order.restaurant_id)) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if exists (select 1 from public.restaurants where id = v_order.restaurant_id and status = 'suspended') then
    raise exception 'This restaurant is suspended' using errcode = '42501';
  end if;
  v_text := private.clean_message(p_content);
  if v_text is null or char_length(v_text) > 1000 then raise exception 'Invalid message' using errcode = '22023'; end if;
  if (select count(*) from public.messages where sender_id = (select auth.uid()) and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many messages. Please wait' using errcode = 'P0001';
  end if;
  insert into public.messages(order_id, restaurant_id, sender_type, sender_id, content)
  values (v_order.id, v_order.restaurant_id, 'restaurant', (select auth.uid()), v_text) returning * into v_msg;
  return to_jsonb(v_msg) - 'sender_id';
end; $$;
revoke all on function public.send_restaurant_message(uuid, text) from public, anon;
grant execute on function public.send_restaurant_message(uuid, text) to authenticated;

create or replace function public.mark_order_messages_read(p_order_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_rest uuid; v_n integer;
begin
  select restaurant_id into v_rest from public.orders where id = p_order_id;
  if v_rest is null or not (select private.has_restaurant_role(v_rest)) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  update public.messages set read_at = now() where order_id = p_order_id and sender_type = 'customer' and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end; $$;
revoke all on function public.mark_order_messages_read(uuid) from public, anon;
grant execute on function public.mark_order_messages_read(uuid) to authenticated;

create or replace function public.list_conversations(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not ((select private.has_restaurant_role(p_restaurant_id)) or (select private.is_platform_admin())) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(c order by (c->>'last_at') desc) from (
    select jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'customer_name', o.customer_name, 'customer_phone', o.customer_phone,
      'status', o.status, 'last_content', lm.content, 'last_sender', lm.sender_type, 'last_at', lm.created_at,
      'unread', (select count(*) from public.messages m where m.order_id = o.id and m.sender_type = 'customer' and m.read_at is null)) as c
    from public.orders o
    cross join lateral (select content, sender_type, created_at from public.messages m where m.order_id = o.id order by m.created_at desc limit 1) lm
    where o.restaurant_id = p_restaurant_id order by lm.created_at desc limit 200) s), '[]'::jsonb);
end; $$;
revoke all on function public.list_conversations(uuid) from public, anon;
grant execute on function public.list_conversations(uuid) to authenticated;

-- Lien de suivi : régénération (nouvel accès, ancien lien invalidé) et révocation.
create or replace function public.reissue_order_tracking(p_order_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_rest uuid; v_token text;
begin
  select restaurant_id into v_rest from public.orders where id = p_order_id;
  if v_rest is null or not (select private.has_restaurant_role(v_rest)) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into private.order_access_tokens(order_id, token_hash) values (p_order_id, encode(extensions.digest(v_token, 'sha256'), 'hex'))
  on conflict (order_id) do update set token_hash = excluded.token_hash, revoked_at = null, created_at = now(),
    expires_at = now() + interval '30 days', channel_key = encode(extensions.gen_random_bytes(16), 'hex');
  return v_token;
end; $$;
revoke all on function public.reissue_order_tracking(uuid) from public, anon;
grant execute on function public.reissue_order_tracking(uuid) to authenticated;

create or replace function public.revoke_order_tracking(p_order_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_rest uuid;
begin
  select restaurant_id into v_rest from public.orders where id = p_order_id;
  if v_rest is null or not (select private.has_restaurant_role(v_rest, array['owner','admin'])) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  update private.order_access_tokens set revoked_at = now() where order_id = p_order_id;
end; $$;
revoke all on function public.revoke_order_tracking(uuid) from public, anon;
grant execute on function public.revoke_order_tracking(uuid) to authenticated;

-- 5) Côté client (sans compte) : tout passe par le jeton, jamais par un identifiant de commande.
create or replace function public.track_order(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; o public.orders%rowtype; r public.restaurants%rowtype; v_key text;
begin
  v_id := private.resolve_order_token(p_token);
  select * into o from public.orders where id = v_id;
  select * into r from public.restaurants where id = o.restaurant_id;
  select channel_key into v_key from private.order_access_tokens where order_id = v_id;
  return jsonb_build_object(
    'order', jsonb_build_object('number', o.order_number, 'status', o.status, 'type', o.order_type, 'customer_name', o.customer_name,
      'total_xof', o.total_xof, 'created_at', o.created_at, 'updated_at', o.updated_at,
      'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity, 'line_total_xof', i.line_total_xof) order by i.created_at)
                           from public.order_items i where i.order_id = o.id), '[]'::jsonb),
      'timeline', coalesce((select jsonb_agg(jsonb_build_object('status', e.details->>'to', 'at', e.created_at) order by e.created_at)
                              from public.order_events e where e.order_id = o.id and e.event_type = 'status_changed'), '[]'::jsonb)),
    'restaurant', jsonb_build_object('name', r.name, 'slug', r.slug, 'whatsapp', r.whatsapp, 'phone', r.phone),
    'channel', 'order-chat:' || v_key,
    'can_message', r.status = 'active' and not (o.status in ('completed', 'cancelled') and o.updated_at < now() - interval '48 hours'));
end; $$;

create or replace function public.customer_messages(p_token text, p_mark_read boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  v_id := private.resolve_order_token(p_token);
  if p_mark_read then
    update public.messages set read_at = now() where order_id = v_id and sender_type = 'restaurant' and read_at is null;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'sender_type', m.sender_type, 'content', m.content, 'created_at', m.created_at, 'read_at', m.read_at) order by m.created_at)
                     from (select * from public.messages where order_id = v_id order by created_at desc limit 200) m), '[]'::jsonb);
end; $$;

create or replace function public.customer_send_message(p_token text, p_content text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; o public.orders%rowtype; v_text text; v_msg public.messages%rowtype;
begin
  v_id := private.resolve_order_token(p_token);
  select * into o from public.orders where id = v_id;
  if not exists (select 1 from public.restaurants where id = o.restaurant_id and status = 'active')
     or (o.status in ('completed', 'cancelled') and o.updated_at < now() - interval '48 hours') then
    raise exception 'Messaging is closed for this order' using errcode = 'P0001';
  end if;
  v_text := private.clean_message(p_content);
  if v_text is null or char_length(v_text) > 1000 then raise exception 'Invalid message' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('msg:' || v_id::text, 0));
  if (select count(*) from public.messages where order_id = v_id and sender_type = 'customer' and created_at > now() - interval '5 minutes') >= 8
     or (select count(*) from public.messages where order_id = v_id and sender_type = 'customer') >= 200 then
    raise exception 'Too many messages. Please wait' using errcode = 'P0001';
  end if;
  insert into public.messages(order_id, restaurant_id, sender_type, content) values (v_id, o.restaurant_id, 'customer', v_text)
  returning * into v_msg;
  return jsonb_build_object('id', v_msg.id, 'sender_type', v_msg.sender_type, 'content', v_msg.content, 'created_at', v_msg.created_at, 'read_at', v_msg.read_at);
end; $$;

revoke all on function public.track_order(text), public.customer_messages(text, boolean), public.customer_send_message(text, text) from public;
grant execute on function public.track_order(text), public.customer_messages(text, boolean), public.customer_send_message(text, text) to anon, authenticated;

-- 6) Statistiques de l'historique (période choisie, données réelles). L'évolution 7/30 jours réutilise restaurant_stats (soumise au plan).
create or replace function public.order_history_stats(p_restaurant_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not ((select private.has_restaurant_role(p_restaurant_id)) or (select private.is_platform_admin())) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'Invalid period' using errcode = '22023';
  end if;
  return (select jsonb_build_object(
      'total', count(*),
      'completed', count(*) filter (where status = 'completed'),
      'cancelled', count(*) filter (where status = 'cancelled'),
      'in_progress', count(*) filter (where status not in ('completed', 'cancelled')),
      'revenue', coalesce(sum(total_xof) filter (where status <> 'cancelled'), 0))
    from public.orders where restaurant_id = p_restaurant_id and created_at >= p_from and created_at < p_to);
end; $$;
revoke all on function public.order_history_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.order_history_stats(uuid, timestamptz, timestamptz) to authenticated;
