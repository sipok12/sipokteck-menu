-- Seule la fonction serveur (sans session utilisateur) ou l'administrateur de la plateforme peut activer/désactiver
-- restaurants.online_payments : le propriétaire passe par l'Edge Function fedapay-orders, qui valide et chiffre la clé.
create or replace function private.guard_online_payments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and not (select private.is_platform_admin())
     and new.online_payments is distinct from (case when tg_op = 'INSERT' then false else old.online_payments end) then
    raise exception 'Online payment can only be changed through the payment settings' using errcode = '42501';
  end if;
  return new;
end; $$;

drop trigger if exists guard_online_payments on public.restaurants;
create trigger guard_online_payments before insert or update on public.restaurants
  for each row execute function private.guard_online_payments();
