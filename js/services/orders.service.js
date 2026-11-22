import { sb } from '../core/supabase.js';

export async function listOrders(restaurantId, limit = 150) {
  const { data, error } = await sb.from('orders')
    .select('id,order_number,customer_name,customer_phone,customer_note,order_type,delivery_address,source,status,payment_status,total_xof,created_at,order_items(product_name,quantity,unit_price_xof,line_total_xof)')
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
