-- Paiement en ligne des commandes de plats (Mobile Money T-Money / Moov Money / carte) via FedaPay.
-- Chaque restaurant utilise SON compte FedaPay : l'argent va directement chez lui, SipokMenu ne détient aucun fonds.
-- Les clés sont chiffrées dans Supabase Vault et ne sont jamais renvoyées au navigateur.

alter table public.restaurants add column if not exists online_payments boolean not null default false;
grant select (online_payments) on public.restaurants to anon, authenticated; -- lecture seule : aucune colonne UPDATE accordée

create table if not exists private.restaurant_payment_settings (
  restaurant_id    uuid primary key references public.restaurants(id) on delete cascade,
  env              text not null check (env in ('sandbox', 'live')),
  secret_id        uuid not null,
  webhook_secret_id uuid,
  key_hint         text not null,
  updated_at       timestamptz not null default now()
);
alter table private.restaurant_payment_settings enable row level security;

create table if not exists public.order_payments (
  id                      uuid primary key default gen_random_uuid(),
  order_id                uuid not null references public.orders(id) on delete cascade,
  restaurant_id           uuid not null references public.restaurants(id) on delete cascade,
  amount_xof              integer not null check (amount_xof > 0),
  provider                text not null default 'fedapay' check (provider = 'fedapay'),
  provider_transaction_id text,
  status                  text not null default 'pending' check (status in ('pending', 'approved', 'failed')),
  provider_status         text,
  paid_at                 timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index if not exists order_payments_tx_uidx on public.order_payments (provider, provider_transaction_id) where provider_transaction_id is not null;
create index if not exists order_payments_order_idx on public.order_payments (order_id, created_at desc);
create index if not exists order_payments_restaurant_idx on public.order_payments (restaurant_id, created_at desc);
alter table public.order_payments enable row level security;
revoke all on public.order_payments from anon, authenticated;
grant select on public.order_payments to authenticated;
drop policy if exists order_payments_staff_read on public.order_payments;
create policy order_payments_staff_read on public.order_payments for select to authenticated
  using ((select private.has_restaurant_role(restaurant_id)) or (select private.is_platform_admin()));
drop trigger if exists set_updated_at on public.order_payments;
create trigger set_updated_at before update on public.order_payments for each row execute function private.set_updated_at();

-- ---- Réglages du restaurateur (contrôle de rôle avec son JWT, écriture par service_role) ----
create or replace function public.authorize_payment_settings(p_restaurant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not (select private.has_restaurant_role(p_restaurant_id, array['owner','admin'])) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
end; $$;
revoke all on function public.authorize_payment_settings(uuid) from public, anon;
grant execute on function public.authorize_payment_settings(uuid) to authenticated;

create or replace function public.payment_settings_status(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.restaurant_payment_settings%rowtype;
begin
  if not (select private.has_restaurant_role(p_restaurant_id, array['owner','admin'])) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  select * into s from private.restaurant_payment_settings where restaurant_id = p_restaurant_id;
  if not found then return jsonb_build_object('enabled', false); end if;
  return jsonb_build_object('enabled', true, 'env', s.env, 'key_hint', s.key_hint, 'has_webhook', s.webhook_secret_id is not null);
end; $$;
revoke all on function public.payment_settings_status(uuid) from public, anon;
grant execute on function public.payment_settings_status(uuid) to authenticated;

create or replace function public.save_restaurant_payment(p_restaurant_id uuid, p_env text, p_secret text, p_webhook text)
returns void language plpgsql security definer set search_path = '' as $$
declare s private.restaurant_payment_settings%rowtype; v_secret uuid; v_hook uuid;
begin
  if p_env not in ('sandbox', 'live') or coalesce(length(p_secret), 0) < 20 then raise exception 'Invalid payment settings' using errcode = '22023'; end if;
  select * into s from private.restaurant_payment_settings where restaurant_id = p_restaurant_id;
  if found then
    perform vault.update_secret(s.secret_id, p_secret);
    v_secret := s.secret_id; v_hook := s.webhook_secret_id;
    if nullif(p_webhook, '') is not null then
      if v_hook is null then v_hook := vault.create_secret(p_webhook, 'fedapay:' || p_restaurant_id || ':webhook');
      else perform vault.update_secret(v_hook, p_webhook); end if;
    end if;
  else
    v_secret := vault.create_secret(p_secret, 'fedapay:' || p_restaurant_id || ':key');
    if nullif(p_webhook, '') is not null then v_hook := vault.create_secret(p_webhook, 'fedapay:' || p_restaurant_id || ':webhook'); end if;
  end if;
  insert into private.restaurant_payment_settings(restaurant_id, env, secret_id, webhook_secret_id, key_hint)
  values (p_restaurant_id, p_env, v_secret, v_hook, right(p_secret, 4))
  on conflict (restaurant_id) do update set env = excluded.env, secret_id = excluded.secret_id,
    webhook_secret_id = excluded.webhook_secret_id, key_hint = excluded.key_hint, updated_at = now();
  update public.restaurants set online_payments = true where id = p_restaurant_id;
end; $$;

create or replace function public.disable_restaurant_payment(p_restaurant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s private.restaurant_payment_settings%rowtype;
begin
  select * into s from private.restaurant_payment_settings where restaurant_id = p_restaurant_id;
  update public.restaurants set online_payments = false where id = p_restaurant_id;
  if found then
    delete from private.restaurant_payment_settings where restaurant_id = p_restaurant_id;
    delete from vault.secrets where id in (s.secret_id, s.webhook_secret_id);
  end if;
end; $$;

create or replace function public.get_restaurant_payment(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.restaurant_payment_settings%rowtype;
begin
  select * into s from private.restaurant_payment_settings where restaurant_id = p_restaurant_id;
  if not found then return null; end if;
  return jsonb_build_object('env', s.env,
    'secret_key', (select decrypted_secret from vault.decrypted_secrets where id = s.secret_id),
    'webhook_secret', (select decrypted_secret from vault.decrypted_secrets where id = s.webhook_secret_id));
end; $$;
revoke all on function public.save_restaurant_payment(uuid,text,text,text), public.disable_restaurant_payment(uuid), public.get_restaurant_payment(uuid) from public, anon, authenticated;
grant execute on function public.save_restaurant_payment(uuid,text,text,text), public.disable_restaurant_payment(uuid), public.get_restaurant_payment(uuid) to service_role;

-- ---- Paiement d'une commande (service_role ; le client est identifié par son jeton de suivi) ----
create or replace function public.start_order_payment(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; o public.orders%rowtype; r public.restaurants%rowtype; v_pay uuid;
begin
  v_id := private.resolve_order_token(p_token);
  select * into o from public.orders where id = v_id for update;
  select * into r from public.restaurants where id = o.restaurant_id;
  if r.status <> 'active' or not r.online_payments then raise exception 'Online payment is not available' using errcode = 'P0001'; end if;
  if o.status = 'cancelled' or o.payment_status in ('paid', 'refunded') or o.total_xof < 1 then
    raise exception 'This order cannot be paid online' using errcode = 'P0001';
  end if;
  if (select count(*) from public.order_payments where order_id = v_id and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many attempts. Please wait' using errcode = 'P0001';
  end if;
  update public.order_payments set status = 'failed', provider_status = coalesce(provider_status, 'abandoned') where order_id = v_id and status = 'pending';
  insert into public.order_payments(order_id, restaurant_id, amount_xof) values (v_id, o.restaurant_id, o.total_xof) returning id into v_pay;
  if o.payment_status = 'unpaid' then update public.orders set payment_status = 'pending' where id = v_id; end if;
  return jsonb_build_object('payment_id', v_pay, 'order_id', v_id, 'restaurant_id', o.restaurant_id, 'restaurant_name', r.name,
                            'order_number', o.order_number, 'amount_xof', o.total_xof, 'customer_name', o.customer_name);
end; $$;

create or replace function public.attach_order_transaction(p_payment_id uuid, p_tx_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.order_payments set provider_transaction_id = p_tx_id where id = p_payment_id and provider_transaction_id is null;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;
end; $$;

create or replace function private.release_order_payment(p_order_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.orders set payment_status = 'unpaid'
   where id = p_order_id and payment_status = 'pending' and not exists (select 1 from public.order_payments where order_id = p_order_id and status = 'pending');
$$;
revoke all on function private.release_order_payment(uuid) from public, anon, authenticated;

create or replace function public.close_order_payment(p_payment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_order uuid;
begin
  update public.order_payments set status = 'failed', provider_status = 'start_failed' where id = p_payment_id and status = 'pending' returning order_id into v_order;
  if v_order is not null then perform private.release_order_payment(v_order); end if;
end; $$;

create or replace function public.latest_order_payment(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; p public.order_payments%rowtype; o public.orders%rowtype;
begin
  v_id := private.resolve_order_token(p_token);
  select * into o from public.orders where id = v_id;
  select * into p from public.order_payments where order_id = v_id and provider_transaction_id is not null order by created_at desc limit 1;
  return jsonb_build_object('restaurant_id', o.restaurant_id, 'payment_status', o.payment_status,
    'payment_id', p.id, 'tx_id', p.provider_transaction_id, 'status', p.status);
end; $$;

create or replace function public.finalize_order_payment(p_restaurant_id uuid, p_tx_id text, p_status text, p_amount integer, p_ref uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.order_payments%rowtype;
begin
  select * into p from public.order_payments where provider = 'fedapay' and provider_transaction_id = p_tx_id and restaurant_id = p_restaurant_id for update;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;
  if p_ref is not null and p_ref <> p.id then raise exception 'Payment reference mismatch' using errcode = '22023'; end if;
  if p.status = 'approved' then return jsonb_build_object('status', 'approved', 'changed', false); end if;
  if p_status = 'approved' then
    if p_amount is distinct from p.amount_xof then raise exception 'Amount mismatch' using errcode = '22023'; end if;
    update public.order_payments set status = 'approved', provider_status = 'approved', paid_at = now() where id = p.id;
    update public.orders set payment_status = 'paid' where id = p.order_id and payment_status in ('unpaid', 'pending'); -- journalisé par log_order_changes
    return jsonb_build_object('status', 'approved', 'changed', true);
  elsif p_status in ('canceled', 'declined', 'expired', 'refunded', 'transferred') then
    update public.order_payments set status = 'failed', provider_status = p_status where id = p.id and status = 'pending';
    perform private.release_order_payment(p.order_id);
    return jsonb_build_object('status', 'failed', 'changed', true);
  end if;
  return jsonb_build_object('status', p.status, 'changed', false);
end; $$;

revoke all on function public.start_order_payment(text), public.attach_order_transaction(uuid,text), public.close_order_payment(uuid),
  public.latest_order_payment(text), public.finalize_order_payment(uuid,text,text,integer,uuid) from public, anon, authenticated;
grant execute on function public.start_order_payment(text), public.attach_order_transaction(uuid,text), public.close_order_payment(uuid),
  public.latest_order_payment(text), public.finalize_order_payment(uuid,text,text,integer,uuid) to service_role;

-- Le suivi client indique l'état du paiement et si le paiement en ligne est proposé.
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
      'total_xof', o.total_xof, 'created_at', o.created_at, 'updated_at', o.updated_at, 'payment_status', o.payment_status,
      'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.product_name, 'quantity', i.quantity, 'line_total_xof', i.line_total_xof) order by i.created_at)
                           from public.order_items i where i.order_id = o.id), '[]'::jsonb),
      'timeline', coalesce((select jsonb_agg(jsonb_build_object('status', e.details->>'to', 'at', e.created_at) order by e.created_at)
                              from public.order_events e where e.order_id = o.id and e.event_type = 'status_changed'), '[]'::jsonb)),
    'restaurant', jsonb_build_object('name', r.name, 'slug', r.slug, 'whatsapp', r.whatsapp, 'phone', r.phone),
    'channel', 'order-chat:' || v_key,
    'can_pay_online', r.status = 'active' and r.online_payments and o.status <> 'cancelled' and o.payment_status in ('unpaid', 'pending'),
    'can_message', r.status = 'active' and not (o.status in ('completed', 'cancelled') and o.updated_at < now() - interval '48 hours'));
end; $$;
