import { sb } from '../core/supabase.js';

/** Appelle une Edge Function ; l'erreur renvoyée porte le message et le code du serveur (jamais de détail technique brut). */
export async function callFunction(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    const err = new Error(detail?.error || error.message);
    err.code = detail?.code;
    throw err;
  }
  return data;
}
