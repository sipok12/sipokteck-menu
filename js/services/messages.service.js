import { sb } from '../core/supabase.js';

const rpc = async (name, args) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
};

// ---- Côté restaurant (session connectée, RLS + contrôle de rôle côté base) ----
export const listConversations = restaurantId => rpc('list_conversations', { p_restaurant_id: restaurantId });
export const sendMessage = (orderId, content) => rpc('send_restaurant_message', { p_order_id: orderId, p_content: content });
export const markRead = orderId => rpc('mark_order_messages_read', { p_order_id: orderId });
export const reissueTracking = orderId => rpc('reissue_order_tracking', { p_order_id: orderId });

export async function listMessages(orderId) {
  const { data, error } = await sb.from('messages').select('id,sender_type,content,read_at,created_at')
    .eq('order_id', orderId).order('created_at').limit(300);
  if (error) throw error;
  return data || [];
}
export async function getOrderBrief(orderId) {
  const { data, error } = await sb.from('orders').select('id,order_number,customer_name,customer_phone,status').eq('id', orderId).maybeSingle();
  if (error) throw error;
  return data;
}
/** Messages en direct pour le restaurant (RLS appliquée par Realtime). onStatus reçoit l'état de la connexion. */
export function subscribeMessages(restaurantId, onChange, onStatus = () => {}) {
  const channel = sb.channel(`messages:${restaurantId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `restaurant_id=eq.${restaurantId}` }, onChange)
    .subscribe(status => onStatus(status));
  return () => { sb.removeChannel(channel); };
}

// ---- Côté client sans compte : tout passe par le jeton du lien de suivi ----
export const trackOrder = token => rpc('track_order', { p_token: token });
export const customerMessages = (token, markAsRead = false) => rpc('customer_messages', { p_token: token, p_mark_read: markAsRead });
export const customerSend = (token, content) => rpc('customer_send_message', { p_token: token, p_content: content });
/** Signal temps réel (diffusion) : ne contient jamais le texte, le client relit via customerMessages. */
export function subscribeChat(channelName, onPing, onStatus = () => {}) {
  const channel = sb.channel(channelName, { config: { private: false } })
    .on('broadcast', { event: '*' }, onPing)
    .subscribe(status => onStatus(status));
  return () => { sb.removeChannel(channel); };
}
