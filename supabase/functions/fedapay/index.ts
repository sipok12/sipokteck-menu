// Edge Function « fedapay » — paiement en ligne des abonnements.
//   POST {action:'checkout', restaurant_id, plan_code}  (JWT restaurateur) -> { url }
//   POST {action:'verify', payment_id}                  (JWT restaurateur) -> { status }
//   POST webhook FedaPay (en-tête X-FEDAPAY-SIGNATURE)                      -> confirmation serveur à serveur
// Secrets : FEDAPAY_SECRET_KEY, FEDAPAY_WEBHOOK_SECRET, FEDAPAY_ENV (sandbox|live), SITE_URL.
// Rien n'est jamais accepté sur la seule foi du client ou du webhook : le statut et le montant
// sont toujours relus auprès de l'API FedaPay avant d'activer quoi que ce soit.
import { createClient } from "npm:@supabase/supabase-js@2.109.0";

const SITE = (Deno.env.get("SITE_URL") || "https://sipokmenu-nine.vercel.app").replace(/\/$/, "");
const API = Deno.env.get("FEDAPAY_ENV") === "live" ? "https://api.fedapay.com/v1" : "https://sandbox-api.fedapay.com/v1";
const SECRET = Deno.env.get("FEDAPAY_SECRET_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("FEDAPAY_WEBHOOK_SECRET") ?? "";
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": SITE,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function fedapay(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`FedaPay ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
// FedaPay enveloppe les objets (« v1/transaction »).
function unwrap(data: any) {
  if (data && data.id !== undefined) return data;
  const inner = data && Object.values(data).find((v: any) => v && typeof v === "object" && v.id !== undefined);
  return (inner ?? data) as any;
}
const getTransaction = async (id: string | number) => unwrap(await fedapay(`/transactions/${encodeURIComponent(String(id))}`));

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
async function validSignature(raw: string, header: string) {
  if (!WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(header.split(",").map(p => p.trim().split("=").map(s => s.trim())) as [string, string][]);
  const t = parts.t, s = parts.s;
  if (!t || !s || !/^\d+$/.test(t)) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false; // anti-rejeu : 10 minutes
  return safeEqual(await hmacHex(WEBHOOK_SECRET, `${t}.${raw}`), s.toLowerCase());
}

async function finalize(tx: any, paymentRef: string | null) {
  const { data, error } = await admin.rpc("finalize_online_payment", {
    p_tx_id: String(tx.id), p_status: String(tx.status ?? ""), p_amount: Math.round(Number(tx.amount)),
    p_payment_ref: paymentRef,
  });
  if (error) throw error;
  return data as { status: string; changed: boolean; payment_id: string };
}

async function handleWebhook(req: Request, raw: string) {
  if (!(await validSignature(raw, req.headers.get("x-fedapay-signature") ?? ""))) return json({ error: "invalid signature" }, 400);
  let event: any;
  try { event = JSON.parse(raw); } catch { return json({ error: "invalid payload" }, 400); }
  const name = String(event.name ?? event.type ?? "");
  const txId = event.entity?.id ?? event.object?.id ?? event.data?.id;
  if (!name.startsWith("transaction.") || txId === undefined) return json({ ignored: true });
  try {
    const tx = await getTransaction(txId); // source de vérité : l'API, pas le contenu du webhook
    if (tx.currency?.iso && tx.currency.iso !== "XOF") return json({ ignored: true });
    const ref = tx.custom_metadata?.payment_id ?? null;
    return json(await finalize(tx, typeof ref === "string" ? ref : null));
  } catch (e: any) {
    if (e?.code === "P0002") return json({ ignored: "unknown transaction" }); // transaction d'un autre usage : pas de rejeu
    console.error("webhook error", e?.message ?? e);
    return json({ error: "processing failed" }, 500); // FedaPay réessaiera
  }
}

async function handleClient(req: Request, body: any) {
  const auth = req.headers.get("authorization") ?? "";
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: who } = await user.auth.getUser();
  if (!who?.user) return json({ error: "Authentication required" }, 401);

  if (body.action === "checkout") {
    if (!SECRET) return json({ error: "Online payment is not configured" }, 503);
    const { data: p, error } = await user.rpc("start_online_payment", { p_restaurant_id: body.restaurant_id, p_plan_code: body.plan_code });
    if (error) return json({ error: error.message, code: error.code }, error.code === "42501" ? 403 : 400);
    try {
      const tx = unwrap(await fedapay("/transactions", {
        method: "POST",
        body: JSON.stringify({
          description: `Abonnement SipokMenu ${p.plan_name}`,
          amount: p.amount_xof, // montant lu dans la table plans par la base, jamais fourni par le client
          currency: { iso: "XOF" },
          callback_url: `${SITE}/dashboard?payment=${p.payment_id}#billing`,
          custom_metadata: { payment_id: p.payment_id, restaurant_id: body.restaurant_id },
          customer: { email: who.user.email },
        }),
      }));
      const { error: e1 } = await admin.rpc("attach_online_transaction", { p_payment_id: p.payment_id, p_tx_id: String(tx.id) });
      if (e1) throw e1;
      const tok = await fedapay(`/transactions/${tx.id}/token`, { method: "POST" });
      const url = (tok.url ?? unwrap(tok).url) as string;
      if (!url?.startsWith("https://")) throw new Error("No payment url");
      return json({ url, payment_id: p.payment_id });
    } catch (e: any) {
      console.error("checkout error", e?.message ?? e);
      await admin.rpc("close_online_payment", { p_payment_id: p.payment_id, p_note: "online_start_failed" });
      return json({ error: "Could not start the payment" }, 502);
    }
  }

  if (body.action === "verify") {
    const { data: pay } = await user.from("payments").select("id").eq("id", body.payment_id).maybeSingle(); // RLS : ses propres paiements
    if (!pay) return json({ error: "Payment not found" }, 404);
    const { data: row } = await admin.from("payments").select("provider_transaction_id,status").eq("id", pay.id).single();
    if (!row?.provider_transaction_id || row.status !== "pending") return json({ status: row?.status ?? "pending" });
    try {
      const r = await finalize(await getTransaction(row.provider_transaction_id), pay.id);
      return json({ status: r.status });
    } catch (e: any) {
      console.error("verify error", e?.message ?? e);
      return json({ error: "Verification failed" }, 502);
    }
  }
  return json({ error: "Unknown action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await req.text();
  if (req.headers.has("x-fedapay-signature")) return handleWebhook(req, raw);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  return handleClient(req, body);
});
