-- SipokMenu — migration A : intégrité, quotas par plan, audit, Realtime.
-- Appliquée en production le 2026-11-16 (nom Supabase : sipokmenu_integrity_quotas_audit_01).
-- Compatible avec le frontend précédent (aucune colonne ni RPC retirée).

-- 1. Limites du plan courant (abonnement actif non expiré, sinon plan Starter)
create or replace function private.restaurant_limits(p_restaurant_id uuid)
returns table(plan_code text, max_products integer, max_categories integer)
language plpgsql stable security definer set search_path = ''
as $$
begin
  return query
    select p.code, p.max_products, p.max_categories
    from public.subscriptions s join public.plans p on p.id = s.plan_id
    where s.restaurant_id = p_restaurant_id and s.status = 'active'
      and (s.ends_at is null or s.ends_at > now())
    order by s.ends_at desc nulls first limit 1;
  if not found then
    return query select p.code, p.max_products, p.max_categories from public.plans p where p.code = 'starter';
  end if;
end;
$$;
revoke all on function private.restaurant_limits(uuid) from public, anon, authenticated;

-- 2. Journal d'audit : écriture réservée aux fonctions internes
create or replace function private.write_audit(p_action text, p_type text, p_id text, p_details jsonb)
returns void language sql security definer set search_path = ''
as $$
  insert into public.audit_logs(actor_id, action, resource_type, resource_id, details)
  values ((select auth.uid()), p_action, p_type, p_id, coalesce(p_details, '{}'::jsonb));
$$;
revoke all on function private.write_audit(text, text, text, jsonb) from public, anon, authenticated;

create or replace function private.audit_restaurant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit('restaurant_created', 'restaurant', new.id::text, jsonb_build_object('name', new.name, 'slug', new.slug));
  elsif new.status is distinct from old.status then
    perform private.write_audit('restaurant_status_changed', 'restaurant', new.id::text,
      jsonb_build_object('name', new.name, 'from', old.status, 'to', new.status));
  end if;
  return null;
end; $$;

create or replace function private.audit_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit('payment_submitted', 'payment', new.id::text,
      jsonb_build_object('restaurant_id', new.restaurant_id, 'amount_xof', new.amount_xof, 'method', new.method));
  elsif new.status is distinct from old.status then
    perform private.write_audit('payment_reviewed', 'payment', new.id::text,
      jsonb_build_object('restaurant_id', new.restaurant_id, 'from', old.status, 'to', new.status, 'amount_xof', new.amount_xof));
  end if;
  return null;
end; $$;

create or replace function private.audit_subscription() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    perform private.write_audit('subscription_status_changed', 'subscription', new.id::text,
      jsonb_build_object('restaurant_id', new.restaurant_id, 'from', old.status, 'to', new.status, 'ends_at', new.ends_at));
  end if;
  return null;
end; $$;

create or replace function private.audit_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.price_xof, new.max_products, new.max_categories, new.is_active)
     is distinct from (old.price_xof, old.max_products, old.max_categories, old.is_active) then
    perform private.write_audit('plan_updated', 'plan', new.id::text,
      jsonb_build_object('code', new.code, 'price_from', old.price_xof, 'price_to', new.price_xof,
                         'max_products', new.max_products, 'max_categories', new.max_categories, 'is_active', new.is_active));
  end if;
  return null;
end; $$;

drop trigger if exists audit_restaurant on public.restaurants;
create trigger audit_restaurant after insert or update on public.restaurants for each row execute function private.audit_restaurant();
drop trigger if exists audit_payment on public.payments;
create trigger audit_payment after insert or update on public.payments for each row execute function private.audit_payment();
drop trigger if exists audit_subscription on public.subscriptions;
create trigger audit_subscription after update on public.subscriptions for each row execute function private.audit_subscription();
drop trigger if exists audit_plan on public.plans;
create trigger audit_plan after update on public.plans for each row execute function private.audit_plan();

-- 3. Commandes : seuls status / payment_status modifiables depuis le client + historique
create or replace function private.guard_order_fields() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.id is distinct from old.id
       or new.restaurant_id is distinct from old.restaurant_id
       or new.order_number is distinct from old.order_number
       or new.customer_name is distinct from old.customer_name
       or new.customer_phone is distinct from old.customer_phone
       or new.customer_note is distinct from old.customer_note
       or new.order_type is distinct from old.order_type
       or new.delivery_address is distinct from old.delivery_address
       or new.source is distinct from old.source
       or new.subtotal_xof is distinct from old.subtotal_xof
       or new.delivery_fee_xof is distinct from old.delivery_fee_xof
       or new.total_xof is distinct from old.total_xof
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'Only the status and the payment status of an order can be changed' using errcode = '42501';
    end if;
    if old.status in ('completed', 'cancelled') and new.status is distinct from old.status
       and not (select private.is_platform_admin()) then
      raise exception 'A closed order cannot be reopened' using errcode = 'P0001';
    end if;
  end if;
  return new;
end; $$;

create or replace function private.log_order_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.order_events(order_id, restaurant_id, actor_id, event_type, details)
    values (new.id, new.restaurant_id, (select auth.uid()), 'status_changed', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.payment_status is distinct from old.payment_status then
    insert into public.order_events(order_id, restaurant_id, actor_id, event_type, details)
    values (new.id, new.restaurant_id, (select auth.uid()), 'payment_status_changed', jsonb_build_object('from', old.payment_status, 'to', new.payment_status));
  end if;
  return null;
end; $$;

drop trigger if exists guard_order_fields on public.orders;
create trigger guard_order_fields before update on public.orders for each row execute function private.guard_order_fields();
drop trigger if exists log_order_changes on public.orders;
create trigger log_order_changes after update on public.orders for each row execute function private.log_order_changes();

-- 4. Restaurants : slug verrouillé (QR codes imprimés), contacts normalisés, max 3 par compte
create or replace function private.guard_restaurant_owner_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not private.is_platform_admin() then
    if new.status is distinct from old.status then
      raise exception 'Restaurant status can only be changed by a platform administrator';
    end if;
    if new.created_by is distinct from old.created_by then
      raise exception 'Restaurant ownership cannot be reassigned directly';
    end if;
    if new.slug is distinct from old.slug then
      raise exception 'The restaurant web address cannot be changed (printed QR codes would break)';
    end if;
  end if;
  return new;
end; $$;

create or replace function private.normalize_restaurant() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  if new.phone is not null and length(new.phone) > 30 then raise exception 'Phone number is too long' using errcode = '22023'; end if;
  new.whatsapp := nullif(regexp_replace(coalesce(new.whatsapp, ''), '[^0-9]', '', 'g'), '');
  if new.whatsapp is not null and length(new.whatsapp) not between 8 and 15 then
    raise exception 'WhatsApp number must contain 8 to 15 digits' using errcode = '22023';
  end if;
  if new.description is not null and length(new.description) > 1000 then raise exception 'Description is too long' using errcode = '22023'; end if;
  if new.logo_url is not null and new.logo_url !~* '^https://' then raise exception 'Logo URL must use https' using errcode = '22023'; end if;
  if new.cover_url is not null and new.cover_url !~* '^https://' then raise exception 'Cover URL must use https' using errcode = '22023'; end if;
  return new;
end; $$;

create or replace function private.limit_restaurants_per_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.restaurants where created_by = new.created_by) >= 3 then
    raise exception 'Maximum number of restaurants reached' using errcode = 'P0001';
  end if;
  return new;
end; $$;

drop trigger if exists limit_restaurants_per_user on public.restaurants;
create trigger limit_restaurants_per_user before insert on public.restaurants for each row execute function private.limit_restaurants_per_user();
drop trigger if exists normalize_restaurant on public.restaurants;
create trigger normalize_restaurant before insert or update on public.restaurants for each row execute function private.normalize_restaurant();

-- (voir la migration 002 : ce revoke de colonne seul est sans effet tant que anon a SELECT sur la table)
revoke select (created_by) on public.restaurants from anon;

-- 5. Produits & catégories : cohérence multi-restaurant + quotas du plan
create or replace function private.enforce_product_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max integer; v_count integer;
begin
  if new.category_id is not null and not exists (
    select 1 from public.categories c where c.id = new.category_id and c.restaurant_id = new.restaurant_id
  ) then
    raise exception 'The category does not belong to this restaurant' using errcode = '23514';
  end if;
  if new.image_url is not null and new.image_url !~* '^https://' then
    raise exception 'Image URL must use https' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('products:' || new.restaurant_id::text, 0));
    select l.max_products into v_max from private.restaurant_limits(new.restaurant_id) l;
    if v_max is not null then
      select count(*) into v_count from public.products where restaurant_id = new.restaurant_id;
      if v_count >= v_max then raise exception 'PLAN_LIMIT_PRODUCTS:%', v_max using errcode = 'P0001'; end if;
    end if;
  end if;
  return new;
end; $$;

create or replace function private.enforce_category_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max integer; v_count integer;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('categories:' || new.restaurant_id::text, 0));
    select l.max_categories into v_max from private.restaurant_limits(new.restaurant_id) l;
    if v_max is not null then
      select count(*) into v_count from public.categories where restaurant_id = new.restaurant_id;
      if v_count >= v_max then raise exception 'PLAN_LIMIT_CATEGORIES:%', v_max using errcode = 'P0001'; end if;
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists enforce_product_rules on public.products;
create trigger enforce_product_rules before insert or update on public.products for each row execute function private.enforce_product_rules();
drop trigger if exists enforce_category_rules on public.categories;
create trigger enforce_category_rules before insert on public.categories for each row execute function private.enforce_category_rules();

alter table public.products drop constraint if exists products_price_upper_bound;
alter table public.products add constraint products_price_upper_bound check (price_xof <= 10000000) not valid;

-- 6. Commande publique : exécutable aussi par un utilisateur connecté
grant execute on function public.submit_public_order(text, text, text, text, text, text, jsonb) to authenticated;

-- 7. Realtime : nouvelles commandes en direct (RLS appliquée aux abonnés)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;
