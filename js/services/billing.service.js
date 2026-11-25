import { sb } from '../core/supabase.js';
import { callFunction } from './functions.js';
import { uploadPrivate } from './storage.service.js';

export async function listPlans() {
  const { data, error } = await sb.from('plans').select('*').eq('is_active', true).order('sort_order');
  if (error) throw error;
  return data || [];
}
export async function getBilling(restaurantId) {
  const { data, error } = await sb.rpc('my_billing', { p_restaurant_id: restaurantId });
  if (error) throw error;
  return data;
}
export async function listPayments(restaurantId) {
  const { data, error } = await sb.from('payments')
    .select('id,amount_xof,method,transaction_reference,status,admin_note,created_at,subscriptions(plans(name))')
    .eq('restaurant_id', restaurantId).order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  return data || [];
}
/** Le montant n'est jamais envoyé : il est lu dans la table plans côté serveur. */
export async function requestSubscription({ restaurantId, planCode, method, reference, file }) {
  const proofPath = file ? await uploadPrivate('payment-proofs', restaurantId, file) : null;
  const { data, error } = await sb.rpc('request_subscription', {
    p_restaurant_id: restaurantId, p_plan_code: planCode, p_method: method,
    p_reference: reference || null, p_proof_path: proofPath
  });
  if (error) throw error;
  return data;
}
export async function getStats(restaurantId, days) {
  const { data, error } = await sb.rpc('restaurant_stats', { p_restaurant_id: restaurantId, p_days: days });
  if (error) throw error;
  return data;
}

const callFedapay = body => callFunction('fedapay', body); // le montant n'est jamais envoyé : il est relu côté serveur
/** Retourne l'URL de paiement FedaPay vers laquelle rediriger le restaurateur. */
export const startOnlinePayment = (restaurantId, planCode) => callFedapay({ action: 'checkout', restaurant_id: restaurantId, plan_code: planCode });
/** Redemande au serveur de relire l'état de la transaction chez FedaPay (retour de paiement). */
export const verifyOnlinePayment = paymentId => callFedapay({ action: 'verify', payment_id: paymentId });
