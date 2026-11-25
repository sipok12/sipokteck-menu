// Edge Function « fedapay-orders » — paiement en ligne des commandes de plats (T-Money, Moov Money, carte).
// Chaque restaurant utilise SON compte FedaPay (clés chiffrées dans Supabase Vault) : l'argent va directement chez lui.
//   Public (jeton de suivi de la commande) : {action:'checkout', token} -> { url } ; {action:'verify', token} -> { status }
//   Restaurateur (JWT owner/admin)         : {action:'settings_status'|'settings_save'|'settings_disable', restaurant_id, ...}
//   Webhook FedaPay du restaurant          : POST ?r=<restaurant_id> + en-tête X-FEDAPAY-SIGNATURE
// Le statut et le montant sont toujours relus auprès de l'API FedaPay avec la clé du restaurant avant de confirmer.
import { createClient } from "npm:@supabase/supabase-js@2.109.0";
import { corsHeaders, fedapayRequest, FedaPayError, unwrap, validSignature } from "../_shared/fedapay-lib.ts";

const SITE = (Deno.env.get("SITE_URL") || "https://sipokmenu-nine.vercel.app").replace(/\/$/, "");
const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = corsHeaders(SITE);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw error;
  return data;
}
const fail = (e: any) => {
  const code = e?.code;
  if (code === "P0002") return json({ error: "Invalid or expired link", code }, 404);
  if (code === "P0001" || code === "22023") return json({ error: e.message, code }, 400);
  if (code === "42501" || code === "28000") return json({ error: e.message, code }, code === "28000" ? 401 : 403);
  console.error("fedapay-orders error", e?.message ?? e);
  return json({ error: "Payment service error" }, 502);
};

async function credentials(restaurantId: string) {
  const c = await rpc("get_restaurant_payment", { p_restaurant_id: restaurantId });
  if (!c?.secret_key) throw Object.assign(new Error("Online payment is not available"), { code: "P0001" });
  return c as { env: string; secret_key: string; webhook_secret: string | null };
}

async function settle(restaurantId: string, c: { env: string; secret_key: string }, txId: string | number, ref: string | null, known?: any) {
  const tx = known ?? unwrap(await fedapayRequest(c.env, c.secret_key, `/transactions/${encodeURIComponent(String(txId))}`));
  if (tx.currency?.iso && tx.currency.iso !== "XOF") throw Object.assign(new Error("Unsupported currency"), { code: "22023" });
  return await rpc("finalize_order_payment", {
    p_restaurant_id: restaurantId, p_tx_id: String(tx.id), p_status: String(tx.status ?? ""),
    p_amount: Math.round(Number(tx.amount)), p_ref: ref,
  }) as { status: string; changed: boolean };
}

async function webhook(req: Request, raw: string) {
  const restaurantId = new URL(req.url).searchParams.get("r") ?? "";
  if (!UUID.test(restaurantId)) return json({ error: "invalid endpoint" }, 400);
  try {
    const c = await credentials(restaurantId);
    if (!c.webhook_secret || !(await validSignature(c.webhook_secret, raw, req.headers.get("x-fedapay-signature") ?? ""))) {
      return json({ error: "invalid signature" }, 400);
    }
    const event = JSON.parse(raw);
    const name = String(event.name ?? event.type ?? "");
    const txId = event.entity?.id ?? event.object?.id ?? event.data?.id;
    if (!name.startsWith("transaction.") || txId === undefined) return json({ ignored: true });
    // finalize_order_payment n'accepte que les transactions déjà rattachées à un paiement de CE restaurant.
    const tx = unwrap(await fedapayRequest(c.env, c.secret_key, `/transactions/${encodeURIComponent(String(txId))}`));
    const ref = tx.custom_metadata?.order_payment_id;
    return json(await settle(restaurantId, c, txId, typeof ref === "string" && UUID.test(ref) ? ref : null, tx));
  } catch (e: any) {
    if (e?.code === "P0002") return json({ ignored: "unknown transaction" });
    if (e instanceof SyntaxError) return json({ error: "invalid payload" }, 400);
    console.error("webhook error", e?.message ?? e);
    return json({ error: "processing failed" }, 500); // FedaPay réessaiera
  }
}

async function publicActions(body: any) {
  const token = String(body.token ?? "");
  if (body.action === "checkout") {
    const p = await rpc("start_order_payment", { p_token: token });
    try {
      const c = await credentials(p.restaurant_id);
      const tx = unwrap(await fedapayRequest(c.env, c.secret_key, "/transactions", {
        method: "POST",
        body: JSON.stringify({
          description: `Commande n° ${p.order_number} — ${p.restaurant_name}`.slice(0, 200),
          amount: p.amount_xof, // total relu en base : jamais fourni par le navigateur
          currency: { iso: "XOF" },
          callback_url: `${SITE}/suivi?paid=${p.payment_id}`,
          custom_metadata: { order_payment_id: p.payment_id, order_id: p.order_id },
          customer: { firstname: String(p.customer_name).slice(0, 60) },
        }),
      }));
      await rpc("attach_order_transaction", { p_payment_id: p.payment_id, p_tx_id: String(tx.id) });
      const tok = await fedapayRequest(c.env, c.secret_key, `/transactions/${tx.id}/token`, { method: "POST" });
      const url = (tok.url ?? unwrap(tok).url) as string;
      if (!url?.startsWith("https://")) throw new Error("No payment url");
      return json({ url, payment_id: p.payment_id });
    } catch (e) {
      console.error("checkout error", (e as Error)?.message);
      await rpc("close_order_payment", { p_payment_id: p.payment_id });
      return json({ error: "Could not start the payment" }, 502);
    }
  }
  if (body.action === "verify") {
    const lp = await rpc("latest_order_payment", { p_token: token });
    if (!lp.tx_id || lp.status !== "pending") return json({ status: lp.status ?? "none", payment_status: lp.payment_status });
    const r = await settle(lp.restaurant_id, await credentials(lp.restaurant_id), lp.tx_id, lp.payment_id);
    return json({ status: r.status });
  }
  return null;
}

async function settingsActions(req: Request, body: any) {
  const restaurantId = String(body.restaurant_id ?? "");
  if (!UUID.test(restaurantId)) return json({ error: "Invalid restaurant" }, 400);
  const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { error: denied } = await user.rpc("authorize_payment_settings", { p_restaurant_id: restaurantId });
  if (denied) return fail(denied);

  if (body.action === "settings_status") {
    const { data, error } = await user.rpc("payment_settings_status", { p_restaurant_id: restaurantId });
    return error ? fail(error) : json(data);
  }
  if (body.action === "settings_disable") {
    await rpc("disable_restaurant_payment", { p_restaurant_id: restaurantId });
    return json({ enabled: false });
  }
  if (body.action === "settings_save") {
    const env = body.env === "live" ? "live" : "sandbox";
    const key = String(body.secret_key ?? "").trim(), hook = String(body.webhook_secret ?? "").trim();
    if (key.length < 20 || key.length > 200 || /\s/.test(key) || hook.length > 200) return json({ error: "Invalid payment settings", code: "22023" }, 400);
    if ((key.startsWith("sk_live_") && env !== "live") || (key.startsWith("sk_sandbox_") && env !== "sandbox")) {
      return json({ error: "The key does not match the selected environment", code: "22023" }, 400);
    }
    try { await fedapayRequest(env, key, "/transactions?per_page=1"); } // la clé doit être acceptée par FedaPay
    catch (e) {
      if (e instanceof FedaPayError && [401, 403].includes(e.status)) return json({ error: "FedaPay rejected this key", code: "22023" }, 400);
      throw e;
    }
    await rpc("save_restaurant_payment", { p_restaurant_id: restaurantId, p_env: env, p_secret: key, p_webhook: hook });
    const { data } = await user.rpc("payment_settings_status", { p_restaurant_id: restaurantId });
    return json(data);
  }
  return json({ error: "Unknown action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const raw = await req.text();
  if (raw.length > 4000 && !req.headers.has("x-fedapay-signature")) return json({ error: "Payload too large" }, 413);
  if (req.headers.has("x-fedapay-signature")) return webhook(req, raw);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  try {
    if (String(body.action ?? "").startsWith("settings_")) return await settingsActions(req, body);
    return (await publicActions(body)) ?? json({ error: "Unknown action" }, 400);
  } catch (e) { return fail(e); }
});
