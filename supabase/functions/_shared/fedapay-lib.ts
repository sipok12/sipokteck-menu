// Utilitaires FedaPay partagés par les Edge Functions « fedapay » (abonnements) et « fedapay-orders » (commandes).
export const corsHeaders = (site: string) => ({
  "Access-Control-Allow-Origin": site,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

export const apiBase = (env: string) => env === "live" ? "https://api.fedapay.com/v1" : "https://sandbox-api.fedapay.com/v1";

export class FedaPayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function fedapayRequest(env: string, secretKey: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${apiBase(env)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json", Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FedaPayError(res.status, `FedaPay ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// FedaPay enveloppe les objets (« v1/transaction »).
export function unwrap(data: any) {
  if (data && data.id !== undefined) return data;
  const inner = data && Object.values(data).find((v: any) => v && typeof v === "object" && v.id !== undefined);
  return (inner ?? data) as any;
}

async function hmacHex(key: string, message: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** En-tête « t=<horodatage>,s=<hmac-sha256 de t.corps> », tolérance de 10 minutes contre le rejeu. */
export async function validSignature(secret: string, raw: string, header: string) {
  if (!secret) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.trim().split("=").map(s => s.trim())) as [string, string][]);
  const t = parts.t, s = parts.s;
  if (!t || !s || !/^\d+$/.test(t)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  return safeEqual(await hmacHex(secret, `${t}.${raw}`), s.toLowerCase());
}
