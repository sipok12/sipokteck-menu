// Configuration publique du frontend. La clé « publishable » est publique par conception :
// la sécurité repose sur les politiques RLS et les RPC de Supabase. Ne mettez JAMAIS de clé service_role ici.
window.SIPOKMENU_CONFIG = {
  supabaseUrl: "https://ydhumfbcnhydgtxuzuhb.supabase.co",
  supabaseKey: "sb_publishable_TWuSAtVaTJ-0-Ks9nTRtMQ_v_A2Hxqz",
  // Coordonnées de paiement affichées aux restaurateurs lors d'une demande d'abonnement.
  // Laissez vide un moyen non proposé. Exemple : tmoney: "90 00 00 00 (SipokTech)"
  paymentInfo: { tmoney: "", flooz: "", bank_transfer: "", cash: "", other: "" }
};
