// Client Supabase unique. La clé publishable/anon est publique par conception ;
// la sécurité repose sur les politiques RLS et les RPC côté base.
// La configuration (URL, clé publishable, coordonnées de paiement) est lue dans /config.js (public/config.js),
// modifiable sans reconstruire le site.
import { createClient } from '@supabase/supabase-js';

const cfg = globalThis.window?.SIPOKMENU_CONFIG;
if (!cfg?.supabaseUrl || !cfg?.supabaseKey) {
  throw new Error('Configuration Supabase introuvable (config.js non chargé).');
}
// Les tests unitaires injectent un client simulé via cette fabrique ; en production c'est createClient.
const factory = globalThis.__SIPOKMENU_CLIENT_FACTORY__ || createClient;

export const config = cfg;
export const sb = factory(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
