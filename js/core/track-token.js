const KEY = 'sipokmenu.track';

/** Garde le jeton de suivi sur l'appareil du client pour qu'il retrouve sa commande après le retour de la page de paiement. */
export function rememberTrack(token) { try { localStorage.setItem(KEY, token); } catch { /* stockage indisponible */ } }
export function recallTrack() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
