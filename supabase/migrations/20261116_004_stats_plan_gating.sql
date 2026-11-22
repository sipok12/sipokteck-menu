-- SipokMenu — migration C. Appliquée : sipokmenu_stats_plan_gating.
-- Les statistiques détaillées sont réservées aux plans dont features.basic_stats = true (contrôle serveur, pas seulement UI).
alter function public.restaurant_stats(uuid, integer) set schema private;
revoke all on function private.restaurant_stats(uuid, integer) from public, anon, authenticated;

create or replace function public.restaurant_stats(p_restaurant_id uuid, p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_allowed boolean;
begin
  if not ((select private.has_restaurant_role(p_restaurant_id)) or (select private.is_platform_admin())) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  select coalesce((p.features ->> 'basic_stats')::boolean, false) into v_allowed
    from private.restaurant_limits(p_restaurant_id) l join public.plans p on p.code = l.plan_code;
  if not coalesce(v_allowed, false) and not (select private.is_platform_admin()) then
    return jsonb_build_object('locked', true, 'plan_required', 'business');
  end if;
  return private.restaurant_stats(p_restaurant_id, p_days);
end; $$;

revoke all on function public.restaurant_stats(uuid, integer) from public, anon;
grant execute on function public.restaurant_stats(uuid, integer) to authenticated;
