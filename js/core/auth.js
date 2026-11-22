import { sb } from './supabase.js';

export async function getSession() {
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** Redirige vers l'accueil (ouverture de la connexion) si aucune session. */
export async function requireSession() {
  const session = await getSession();
  if (!session) { location.replace('/?login=1'); return null; }
  return session;
}

export async function getProfile(userId) {
  const { data, error } = await sb.from('profiles').select('id, full_name, phone, platform_role').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function signOut() {
  try { await sb.auth.signOut(); } finally { location.replace('/'); }
}

export function bindLogout(id = 'logout') {
  document.getElementById(id)?.addEventListener('click', signOut);
}
