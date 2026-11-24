import { sb } from '../core/supabase.js';

const ORDER_COLS = 'id,order_number,customer_name,customer_phone,customer_note,order_type,delivery_address,source,status,payment_status,total_xof,created_at,order_items(product_name,quantity,unit_price_xof,line_total_xof)';

export async function listOrders(restaurantId, limit = 150) {
  const { data, error } = await sb.from('orders')
    .select(ORDER_COLS)
    .eq('restaurant_id', restaurantId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}
export async function updateOrderStatus(id, status) {
  const { error } = await sb.from('orders').update({ status }).eq('id', id);
  if (error) throw error;
}
export async function updatePaymentStatus(id, payment_status) {
  const { error } = await sb.from('orders').update({ payment_status }).eq('id', id);
  if (error) throw error;
}
export async function listOrderEvents(orderId) {
  const { data, error } = await sb.from('order_events').select('event_type,details,created_at').eq('order_id', orderId).order('created_at');
  if (error) throw error;
  return data || [];
}
/** Nouvelles commandes en direct (RLS appliquée par Realtime). Retourne une fonction d'arrêt. */
export function subscribeOrders(restaurantId, onChange) {
  const channel = sb.channel(`orders:${restaurantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${restaurantId}` }, onChange)
    .subscribe();
  return () => { sb.removeChannel(channel); };
}

const OPEN_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];
/** Historique paginé : période [from, to[, statut ('open' = en cours), recherche n° / nom / téléphone. Lecture seule. */
export async function searchOrders(restaurantId, { from, to, status = 'all', q = '', offset = 0, limit = 30 }) {
  let query = sb.from('orders').select(ORDER_COLS, { count: 'exact' })
    .eq('restaurant_id', restaurantId).gte('created_at', from).lt('created_at', to)
    .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (status === 'open') query = query.in('status', OPEN_STATUSES);
  else if (status !== 'all') query = query.eq('status', status);
  const term = q.replace(/[%*,()\\]/g, ' ').trim().slice(0, 60);
  if (term) {
    const parts = [`customer_name.ilike.%${term}%`, `customer_phone.ilike.%${term}%`];
    if (/^#?\d{1,9}$/.test(term)) parts.push(`order_number.eq.${term.replace('#', '')}`);
    query = query.or(parts.join(','));
  }
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data || [];
  return { rows, total: Math.max(count ?? 0, offset + rows.length) };
}
/** Chiffres de la période, calculés par la base à partir des vraies commandes. */
export async function getHistoryStats(restaurantId, from, to) {
  const { data, error } = await sb.rpc('order_history_stats', { p_restaurant_id: restaurantId, p_from: from, p_to: to });
  if (error) throw error;
  return data;
}
