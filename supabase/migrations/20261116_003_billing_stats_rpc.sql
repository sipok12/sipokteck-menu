-- SipokMenu — migration B : facturation manuelle, statistiques, source des commandes.
-- Appliquée : sipokmenu_billing_stats_rpc_01. Corrige notamment admin_review_payment (SECURITY INVOKER sans droit UPDATE
-- sur payments/subscriptions : la validation des paiements échouait avec « permission denied »).

create or replace function public.request_subscription(
  p_restaurant_id uuid, p_plan_code text, p_method text,
  p_reference text default null, p_proof_path text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_rest public.restaurants%rowtype; v_plan public.plans%rowtype;
  v_sub uuid; v_pay uuid; v_ref text; v_proof text;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not (select private.has_restaurant_role(p_restaurant_id, array['owner','admin'])) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  select * into v_rest from public.restaurants where id = p_restaurant_id;
  if not found then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
  if v_rest.status = 'suspended' then raise exception 'This restaurant is suspended' using errcode = '42501'; end if;
  select * into v_plan from public.plans where code = lower(trim(coalesce(p_plan_code,''))) and is_active = true;
  if not found then raise exception 'Plan not found' using errcode = 'P0002'; end if;
  if p_method is null or p_method not in ('tmoney','flooz','bank_transfer','cash','other') then
    raise exception 'Invalid payment method' using errcode = '22023';
  end if;
  v_ref := nullif(left(trim(coalesce(p_reference,'')), 100), '');
  v_proof := nullif(trim(coalesce(p_proof_path,'')), '');
  if v_ref is null and v_proof is null then
    raise exception 'A transaction reference or a proof is required' using errcode = '22023';
  end if;
  if v_proof is not null and (left(v_proof, length(p_restaurant_id::text) + 1) <> p_restaurant_id::text || '/' or length(v_proof) > 300) then
    raise exception 'Invalid proof path' using errcode = '22023';
  end if;
  if exists (select 1 from public.payments where restaurant_id = p_restaurant_id and status = 'pending') then
    raise exception 'A payment is already waiting for review' using errcode = 'P0001';
  end if;
  insert into public.subscriptions(restaurant_id, plan_id, status) values (p_restaurant_id, v_plan.id, 'pending') returning id into v_sub;
  insert into public.payments(restaurant_id, subscription_id, amount_xof, method, transaction_reference, proof_path, status, submitted_by)
  values (p_restaurant_id, v_sub, v_plan.price_xof, p_method, v_ref, v_proof, 'pending', (select auth.uid()))
  returning id into v_pay;
  return jsonb_build_object('subscription_id', v_sub, 'payment_id', v_pay, 'plan', v_plan.code, 'amount_xof', v_plan.price_xof);
end; $$;

create or replace function public.admin_review_payment(p_payment_id uuid, p_decision text, p_admin_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_pay public.payments%rowtype; v_sub public.subscriptions%rowtype;
  v_interval text; v_base timestamptz; v_end timestamptz;
begin
  if not (select private.is_platform_admin()) then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved','rejected') then
    raise exception 'Invalid payment decision' using errcode = '22023';
  end if;
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;
  if v_pay.status <> 'pending' then raise exception 'Payment already reviewed' using errcode = 'P0001'; end if;

  update public.payments
     set status = p_decision, reviewed_by = (select auth.uid()), reviewed_at = now(),
         admin_note = nullif(left(coalesce(p_admin_note,''), 1000), '')
   where id = p_payment_id;

  if v_pay.subscription_id is not null then
    select * into v_sub from public.subscriptions where id = v_pay.subscription_id for update;
    if p_decision = 'approved' then
      select billing_interval into v_interval from public.plans where id = v_sub.plan_id;
      -- Renouvellement : la nouvelle période s'ajoute à la fin de la période encore active.
      select coalesce(max(ends_at), now()) into v_base from public.subscriptions
       where restaurant_id = v_sub.restaurant_id and status = 'active' and ends_at > now() and id <> v_sub.id;
      v_base := greatest(v_base, now());
      v_end := v_base + (case when v_interval = 'year' then interval '1 year' else interval '1 month' end);
      update public.subscriptions set status = 'expired'
       where restaurant_id = v_sub.restaurant_id and status = 'active' and id <> v_sub.id;
      update public.subscriptions set status = 'active', starts_at = now(), ends_at = v_end where id = v_sub.id;
    else
      update public.subscriptions set status = 'cancelled' where id = v_sub.id and status = 'pending';
    end if;
  end if;
  return jsonb_build_object('success', true, 'payment_id', p_payment_id, 'status', p_decision,
                            'subscription_activated', p_decision = 'approved' and v_pay.subscription_id is not null);
end; $$;

create or replace function public.admin_update_plan(
  p_plan_id uuid, p_price_xof integer, p_max_products integer, p_max_categories integer, p_is_active boolean)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not (select private.is_platform_admin()) then raise exception 'Platform administrator access required' using errcode = '42501'; end if;
  if p_price_xof is null or p_price_xof < 0 or p_price_xof > 10000000 then raise exception 'Invalid price' using errcode = '22023'; end if;
  if p_max_products is not null and p_max_products < 1 then raise exception 'Invalid product limit' using errcode = '22023'; end if;
  if p_max_categories is not null and p_max_categories < 1 then raise exception 'Invalid category limit' using errcode = '22023'; end if;
  update public.plans set price_xof = p_price_xof, max_products = p_max_products,
         max_categories = p_max_categories, is_active = coalesce(p_is_active, is_active)
   where id = p_plan_id;
  if not found then raise exception 'Plan not found' using errcode = 'P0002'; end if;
end; $$;

create or replace function public.my_billing(p_restaurant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_sub record; v_lim record; v_products integer; v_categories integer; v_pending boolean;
begin
  if not ((select private.has_restaurant_role(p_restaurant_id, array['owner','admin'])) or (select private.is_platform_admin())) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  select s.id, s.status, s.starts_at, s.ends_at, p.code, p.name, p.price_xof into v_sub
    from public.subscriptions s join public.plans p on p.id = s.plan_id
   where s.restaurant_id = p_restaurant_id and s.status = 'active' and (s.ends_at is null or s.ends_at > now())
   order by s.ends_at desc nulls first limit 1;
  select * into v_lim from private.restaurant_limits(p_restaurant_id);
  select count(*) into v_products from public.products where restaurant_id = p_restaurant_id;
  select count(*) into v_categories from public.categories where restaurant_id = p_restaurant_id;
  select exists (select 1 from public.payments where restaurant_id = p_restaurant_id and status = 'pending') into v_pending;
  return jsonb_build_object(
    'state', case when v_sub.id is null then 'trial' else 'active' end,
    'plan_code', v_lim.plan_code, 'plan_name', coalesce(v_sub.name, 'Starter'),
    'ends_at', v_sub.ends_at,
    'days_left', case when v_sub.ends_at is null then null else greatest(0, ceil(extract(epoch from (v_sub.ends_at - now())) / 86400))::int end,
    'max_products', v_lim.max_products, 'max_categories', v_lim.max_categories,
    'products', v_products, 'categories', v_categories, 'pending_payment', v_pending);
end; $$;

create or replace function public.restaurant_stats(p_restaurant_id uuid, p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_days integer := least(greatest(coalesce(p_days, 30), 1), 365); v_from date;
begin
  if not ((select private.has_restaurant_role(p_restaurant_id)) or (select private.is_platform_admin())) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  v_from := current_date - (v_days - 1);
  return jsonb_build_object(
    'days', v_days,
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'orders', coalesce(o.cnt, 0), 'revenue', coalesce(o.rev, 0)) order by d.day)
      from (select generate_series(v_from, current_date, interval '1 day')::date as day) d
      left join (select created_at::date as day, count(*) as cnt, sum(total_xof) as rev
                   from public.orders where restaurant_id = p_restaurant_id and status <> 'cancelled' and created_at::date >= v_from
                  group by 1) o on o.day = d.day), '[]'::jsonb),
    'by_status', coalesce((select jsonb_object_agg(status, cnt) from (
        select status, count(*) as cnt from public.orders where restaurant_id = p_restaurant_id and created_at::date >= v_from group by status) s), '{}'::jsonb),
    'top_products', coalesce((select jsonb_agg(jsonb_build_object('name', t.product_name, 'quantity', t.qty, 'revenue', t.rev) order by t.qty desc) from (
        select i.product_name, sum(i.quantity) as qty, sum(i.line_total_xof) as rev
          from public.order_items i join public.orders o on o.id = i.order_id
         where o.restaurant_id = p_restaurant_id and o.status <> 'cancelled' and o.created_at::date >= v_from
         group by i.product_name order by sum(i.quantity) desc limit 5) t), '[]'::jsonb),
    'totals', (select jsonb_build_object('orders', count(*), 'revenue', coalesce(sum(total_xof), 0))
                 from public.orders where restaurant_id = p_restaurant_id and status <> 'cancelled' and created_at::date >= v_from));
end; $$;

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select private.is_platform_admin()) then raise exception 'Platform administrator access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'restaurants', (select jsonb_build_object('total', count(*), 'pending', count(*) filter (where status = 'pending'),
                      'active', count(*) filter (where status = 'active'), 'suspended', count(*) filter (where status = 'suspended')) from public.restaurants),
    'active_subscriptions', (select count(*) from public.subscriptions where status = 'active' and (ends_at is null or ends_at > now())),
    'monthly_recurring_xof', coalesce((select sum(case when p.billing_interval = 'year' then p.price_xof / 12 else p.price_xof end)
                      from public.subscriptions s join public.plans p on p.id = s.plan_id
                     where s.status = 'active' and (s.ends_at is null or s.ends_at > now())), 0),
    'pending_payments', (select count(*) from public.payments where status = 'pending'),
    'approved_30d_xof', coalesce((select sum(amount_xof) from public.payments where status = 'approved' and reviewed_at > now() - interval '30 days'), 0),
    'orders_30d', (select count(*) from public.orders where created_at > now() - interval '30 days'));
end; $$;

-- Commande publique : ajout de la source (public_menu | whatsapp), rétro-compatible (paramètre avec valeur par défaut)
drop function if exists public.submit_public_order(text, text, text, text, text, text, jsonb);
create or replace function public.submit_public_order(
  p_restaurant_slug text, p_customer_name text, p_customer_phone text,
  p_customer_note text default null, p_order_type text default 'pickup',
  p_delivery_address text default null, p_items jsonb default '[]'::jsonb,
  p_source text default 'public_menu')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_restaurant public.restaurants%rowtype; v_order_id uuid; v_order_number bigint; v_subtotal numeric;
  v_phone text; v_fingerprint text; v_item_count integer; v_matched_count integer; v_unique_count integer;
begin
  if p_restaurant_slug is null or length(trim(p_restaurant_slug)) < 2 or length(p_restaurant_slug) > 140 then
    raise exception 'Invalid restaurant' using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('public_menu','whatsapp') then raise exception 'Invalid order source' using errcode = '22023'; end if;
  select * into v_restaurant from public.restaurants r where r.slug = lower(trim(p_restaurant_slug)) and r.status = 'active' limit 1;
  if not found then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) < 2 or length(trim(p_customer_name)) > 120 then
    raise exception 'Customer name must contain 2 to 120 characters' using errcode = '22023';
  end if;
  v_phone := regexp_replace(coalesce(p_customer_phone,''), '[^0-9+]', '', 'g');
  if length(v_phone) < 8 or length(v_phone) > 20 then raise exception 'Invalid customer phone' using errcode = '22023'; end if;
  if p_order_type is null or p_order_type not in ('pickup','delivery','dine_in') then raise exception 'Invalid order type' using errcode = '22023'; end if;
  if p_order_type = 'delivery' and length(trim(coalesce(p_delivery_address,''))) not between 5 and 500 then
    raise exception 'Delivery address must contain 5 to 500 characters' using errcode = '22023';
  end if;
  if p_customer_note is not null and length(p_customer_note) > 1000 then raise exception 'Customer note is too long' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Items must be an array' using errcode = '22023'; end if;
  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 30 then raise exception 'An order must contain between 1 and 30 lines' using errcode = '22023'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as e(value)
    where jsonb_typeof(e.value) <> 'object'
       or coalesce(e.value->>'product_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e.value->>'quantity','') !~ '^[1-9][0-9]?$'
  ) then raise exception 'Invalid product or quantity' using errcode = '22023'; end if;
  select count(distinct e.value->>'product_id') into v_unique_count from jsonb_array_elements(p_items) as e(value);
  if v_unique_count <> v_item_count then raise exception 'Duplicate products are not allowed; update the quantity instead' using errcode = '22023'; end if;
  v_fingerprint := encode(extensions.digest(lower(v_phone), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_restaurant.id::text || ':' || v_fingerprint, 0));
  delete from private.public_order_rate_limits where created_at < now() - interval '1 day';
  if (select count(*) from private.public_order_rate_limits l where l.restaurant_id = v_restaurant.id and l.phone_fingerprint = v_fingerprint and l.created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Too many orders. Please try again later' using errcode = 'P0001';
  end if;
  select count(*) into v_matched_count from jsonb_array_elements(p_items) as e(value)
    join public.products p on p.id = (e.value->>'product_id')::uuid and p.restaurant_id = v_restaurant.id and p.is_active = true and p.is_available = true;
  if v_matched_count <> v_item_count then raise exception 'One or more products are unavailable' using errcode = 'P0002'; end if;
  select sum(p.price_xof::numeric * (e.value->>'quantity')::integer) into v_subtotal
    from jsonb_array_elements(p_items) as e(value)
    join public.products p on p.id = (e.value->>'product_id')::uuid and p.restaurant_id = v_restaurant.id and p.is_active = true and p.is_available = true;
  if v_subtotal is null or v_subtotal < 1 or v_subtotal > 2147483647 then raise exception 'Order total is outside the allowed range' using errcode = '22003'; end if;
  insert into public.orders (restaurant_id, customer_name, customer_phone, customer_note, order_type, delivery_address, source, status, payment_status, subtotal_xof, delivery_fee_xof, total_xof, created_by)
  values (v_restaurant.id, trim(p_customer_name), v_phone, nullif(trim(coalesce(p_customer_note,'')),''), p_order_type,
          case when p_order_type = 'delivery' then trim(p_delivery_address) else null end, p_source, 'pending', 'unpaid', v_subtotal::integer, 0, v_subtotal::integer, null)
  returning id, order_number into v_order_id, v_order_number;
  insert into public.order_items (order_id, product_id, product_name, quantity, unit_price_xof, line_total_xof)
  select v_order_id, p.id, p.name, (e.value->>'quantity')::integer, p.price_xof, p.price_xof * (e.value->>'quantity')::integer
    from jsonb_array_elements(p_items) as e(value)
    join public.products p on p.id = (e.value->>'product_id')::uuid and p.restaurant_id = v_restaurant.id and p.is_active = true and p.is_available = true;
  insert into public.order_events (order_id, restaurant_id, actor_id, event_type, details)
  values (v_order_id, v_restaurant.id, null, 'created', jsonb_build_object('source', p_source));
  insert into private.public_order_rate_limits (restaurant_id, phone_fingerprint) values (v_restaurant.id, v_fingerprint);
  return jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number, 'subtotal_xof', v_subtotal::integer,
                            'delivery_fee_xof', 0, 'total_xof', v_subtotal::integer, 'currency', 'XOF');
end; $$;

-- Droits d'exécution : jamais anon, sauf la commande publique
revoke all on function public.request_subscription(uuid, text, text, text, text) from public, anon;
revoke all on function public.admin_review_payment(uuid, text, text) from public, anon;
revoke all on function public.admin_update_plan(uuid, integer, integer, integer, boolean) from public, anon;
revoke all on function public.my_billing(uuid) from public, anon;
revoke all on function public.restaurant_stats(uuid, integer) from public, anon;
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.submit_public_order(text, text, text, text, text, text, jsonb, text) from public;
grant execute on function public.request_subscription(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_review_payment(uuid, text, text) to authenticated;
grant execute on function public.admin_update_plan(uuid, integer, integer, integer, boolean) to authenticated;
grant execute on function public.my_billing(uuid) to authenticated;
grant execute on function public.restaurant_stats(uuid, integer) to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.submit_public_order(text, text, text, text, text, text, jsonb, text) to anon, authenticated;
