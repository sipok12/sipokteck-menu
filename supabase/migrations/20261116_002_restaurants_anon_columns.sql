-- SipokMenu — migration A2 (correctif). Appliquée : sipokmenu_restaurants_anon_columns_fix.
-- Un droit colonne ne retire pas un droit table : on retire le droit table puis on accorde
-- explicitement les colonnes publiques (created_by, l'identifiant du propriétaire, est exclu).
revoke select on public.restaurants from anon;
grant select (id, name, slug, description, logo_url, cover_url, phone, whatsapp, address, city, country,
              default_language, currency, status, created_at, updated_at)
  on public.restaurants to anon;
