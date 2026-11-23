-- Paiement en ligne des abonnements via FedaPay.
-- Principes : le montant vient toujours de plans ; seules les fonctions service_role
-- (appelées par les Edge Functions après revérification auprès de l'API FedaPay) confirment un paiement.

alter table public.payments
  add column if not exists provider text,
  add column if not exists provider_transaction_id text,
  add column if not exists provider_status text,
  add column if not exists paid_at timestamptz;

alter table public.payments drop constraint if exists payments_method_check;
alter table public.payments add constraint payments_method_check
  check (method = any (array['tmoney','flooz','bank_transfer','cash','other','fedapay']));
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check
  check (provider is null or provider = 'fedapay');
create unique index if not exists payments_provider_tx_uidx
  on public.payments (provider, provider_transaction_id) where provider_transaction_id is not null;

-- Un restaurateur ne peut pas fabriquer lui-même un paiement « fedapay ».
drop policy if exists payments_manager_submit on public.payments;
create policy payments_manager_submit on public.payments for insert to authenticated
  with check (submitted_by = (select auth.uid()) and status = 'pending' and method <> 'fedapay'
              and (select private.has_restaurant_role(restaurant_id, array['owner','admin'])));
-- Les colonnes provider_* ne sont pas accordées à authenticated (GRANT par colonne) : lecture/écriture impossibles côté client.

-- Activation d'un abonnement (logique unique, partagée avec la validation manuelle).
create or replace function private.activate_subscription(p_sub_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_sub public.subscriptions%rowtype; v_interval text; v_base timestamptz; v_end timestamptz;
begin
  select * into v_sub from public.subscriptions where id = p_sub_id for update;
  if not found then return; end if;
  select billing_interval into v_interval from public.plans where id = v_sub.plan_id;
  select coalesce(max(ends_at), now()) into v_base from public.subscriptions
   where restaurant_id = v_sub.restaurant_id and status = 'active' and ends_at > now() and id <> v_sub.id;
  v_base := greatest(v_base, now());
  v_end := v_base + (case when v_interval = 'year' then interval '1 year' else interval '1 month' end);
  update public.subscriptions set status = 'expired'
   where restaurant_id = v_sub.restaurant_id and status = 'active' and id <> v_sub.id;
  update public.subscriptions set status = 'active', starts_at = now(), ends_at = v_end where id = v_sub.id;
end; $$;
revoke all on function private.activate_subscription(uuid) from public, anon, authenticated;

create or replace function public.admin_review_payment(p_payment_id uuid, p_decision text, p_admin_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pay public.payments%rowtype;
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
    if p_decision = 'approved' then perform private.activate_subscription(v_pay.subscription_id);
    else update public.subscriptions set status = 'cancelled' where id = v_pay.subscription_id and status = 'pending'; end if;
  end if;
  return jsonb_build_object('success', true, 'payment_id', p_payment_id, 'status', p_decision,
                            'subscription_activated', p_decision = 'approved' and v_pay.subscription_id is not null);
end; $$;

-- Abandonne les paiements en ligne non terminés (un paiement tardif reste activable, voir finalize).
create or replace function private.abandon_online_payments(p_restaurant_id uuid)
returns void language sql security definer set search_path = '' as $$
  with p as (
    update public.payments set status = 'rejected', admin_note = 'online_abandoned', reviewed_at = now()
     where restaurant_id = p_restaurant_id and status = 'pending' and provider = 'fedapay' returning subscription_id)
  update public.subscriptions set status = 'cancelled'
   where id in (select subscription_id from p) and status = 'pending';
$$;
revoke all on function private.abandon_online_payments(uuid) from public, anon, authenticated;

-- Le paiement manuel en attente bloque toujours ; un paiement en ligne en attente est simplement abandonné.
create or replace function public.request_subscription(p_restaurant_id uuid, p_plan_code text, p_method text,
  p_reference text default null, p_proof_path text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rest public.restaurants%rowtype; v_plan public.plans%rowtype; v_sub uuid; v_pay uuid; v_ref text; v_proof text;
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
  perform private.abandon_online_payments(p_restaurant_id);
  if exists (select 1 from public.payments where restaurant_id = p_restaurant_id and status = 'pending') then
    raise exception 'A payment is already waiting for review' using errcode = 'P0001';
  end if;
  insert into public.subscriptions(restaurant_id, plan_id, status) values (p_restaurant_id, v_plan.id, 'pending') returning id into v_sub;
  insert into public.payments(restaurant_id, subscription_id, amount_xof, method, transaction_reference, proof_path, status, submitted_by)
  values (p_restaurant_id, v_sub, v_plan.price_xof, p_method, v_ref, v_proof, 'pending', (select auth.uid()))
  returning id into v_pay;
  return jsonb_build_object('subscription_id', v_sub, 'payment_id', v_pay, 'plan', v_plan.code, 'amount_xof', v_plan.price_xof);
end; $$;

-- 1) Appelée avec le JWT du restaurateur : mêmes contrôles que request_subscription, montant lu dans plans.
create or replace function public.start_online_payment(p_restaurant_id uuid, p_plan_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rest public.restaurants%rowtype; v_plan public.plans%rowtype; v_sub uuid; v_pay uuid;
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
  perform private.abandon_online_payments(p_restaurant_id);
  if exists (select 1 from public.payments where restaurant_id = p_restaurant_id and status = 'pending') then
    raise exception 'A payment is already waiting for review' using errcode = 'P0001';
  end if;
  insert into public.subscriptions(restaurant_id, plan_id, status) values (p_restaurant_id, v_plan.id, 'pending') returning id into v_sub;
  insert into public.payments(restaurant_id, subscription_id, amount_xof, method, provider, status, submitted_by)
  values (p_restaurant_id, v_sub, v_plan.price_xof, 'fedapay', 'fedapay', 'pending', (select auth.uid()))
  returning id into v_pay;
  return jsonb_build_object('payment_id', v_pay, 'amount_xof', v_plan.price_xof, 'plan_code', v_plan.code, 'plan_name', v_plan.name);
end; $$;
revoke all on function public.start_online_payment(uuid, text) from public, anon;
grant execute on function public.start_online_payment(uuid, text) to authenticated;

-- 2) Service_role uniquement : rattache la transaction FedaPay au paiement.
create or replace function public.attach_online_transaction(p_payment_id uuid, p_tx_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.payments set provider_transaction_id = p_tx_id, provider_status = 'pending'
   where id = p_payment_id and provider = 'fedapay' and provider_transaction_id is null;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;
end; $$;
revoke all on function public.attach_online_transaction(uuid, text) from public, anon, authenticated;
grant execute on function public.attach_online_transaction(uuid, text) to service_role;

-- 3) Service_role uniquement : clôt un paiement dont la transaction n'a pas pu être créée.
create or replace function public.close_online_payment(p_payment_id uuid, p_note text)
returns void language sql security definer set search_path = '' as $$
  with p as (update public.payments set status = 'rejected', admin_note = left(p_note, 200), reviewed_at = now()
              where id = p_payment_id and provider = 'fedapay' and status = 'pending' returning subscription_id)
  update public.subscriptions set status = 'cancelled' where id in (select subscription_id from p) and status = 'pending';
$$;
revoke all on function public.close_online_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.close_online_payment(uuid, text) to service_role;

-- 4) Service_role uniquement : applique l'état de la transaction relu auprès de FedaPay. Idempotent.
create or replace function public.finalize_online_payment(p_tx_id text, p_status text, p_amount integer, p_payment_ref uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pay public.payments%rowtype;
begin
  select * into v_pay from public.payments where provider = 'fedapay' and provider_transaction_id = p_tx_id for update;
  if not found then raise exception 'Payment not found' using errcode = 'P0002'; end if;
  if p_payment_ref is not null and p_payment_ref <> v_pay.id then
    raise exception 'Payment reference mismatch' using errcode = '22023';
  end if;
  if v_pay.status = 'approved' then
    return jsonb_build_object('payment_id', v_pay.id, 'status', 'approved', 'changed', false);
  end if;
  if p_status = 'approved' then
    if p_amount is distinct from v_pay.amount_xof then
      raise exception 'Amount mismatch' using errcode = '22023';
    end if;
    -- Accepte aussi un paiement abandonné (payé après coup), jamais un rejet manuel de l'administrateur.
    if v_pay.status = 'rejected' and v_pay.admin_note is distinct from 'online_abandoned' then
      return jsonb_build_object('payment_id', v_pay.id, 'status', v_pay.status, 'changed', false);
    end if;
    update public.payments set status = 'approved', provider_status = 'approved', paid_at = now(), reviewed_at = now(),
           admin_note = 'online_confirmed' where id = v_pay.id;
    if v_pay.subscription_id is not null then
      update public.subscriptions set status = 'pending' where id = v_pay.subscription_id and status = 'cancelled';
      perform private.activate_subscription(v_pay.subscription_id);
    end if;
    return jsonb_build_object('payment_id', v_pay.id, 'status', 'approved', 'changed', true);
  elsif p_status in ('canceled','declined','refunded','transferred','expired') then
    if v_pay.status = 'pending' then
      update public.payments set status = 'rejected', provider_status = p_status, reviewed_at = now(),
             admin_note = 'online_' || p_status where id = v_pay.id;
      update public.subscriptions set status = 'cancelled' where id = v_pay.subscription_id and status = 'pending';
      return jsonb_build_object('payment_id', v_pay.id, 'status', 'rejected', 'changed', true);
    end if;
  end if;
  update public.payments set provider_status = left(coalesce(p_status,''), 30) where id = v_pay.id and status = 'pending';
  return jsonb_build_object('payment_id', v_pay.id, 'status', v_pay.status, 'changed', false);
end; $$;
revoke all on function public.finalize_online_payment(text, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.finalize_online_payment(text, text, integer, uuid) to service_role;
