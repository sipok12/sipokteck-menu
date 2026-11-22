-- Un seul administrateur de plateforme peut exister (le propriétaire de SipokMenu).
-- Toute tentative de promouvoir un second compte échoue au niveau de la base.
create unique index if not exists profiles_single_platform_admin
  on public.profiles ((true))
  where platform_role = 'platform_admin';
