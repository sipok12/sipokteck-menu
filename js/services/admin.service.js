import { sb } from '../core/supabase.js';

export async function overview() {
  const { data, error } = await sb.rpc('admin_overview');
  if (error) throw error;
  return data;
}
export async function listRestaurants() {
  const { data, error } = await sb.from('restaurants').select('id,name,slug,city,phone,whatsapp,status,created_at').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
export async function setRestaurantStatus(id, status) {
  const { error } = await sb.from('restaurants').update({ status }).eq('id', id);
  if (error) throw error;
}
export async function listPayments(status) {
  let query = sb.from('payments')
    .select('id,amount_xof,method,transaction_reference,proof_path,status,admin_note,created_at,reviewed_at,restaurants(name,slug),subscriptions(plans(name))')
    .order('created_at', { ascending: false }).limit(100);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
export async function reviewPayment(id, decision, note) {
  const { error } = await sb.rpc('admin_review_payment', { p_payment_id: id, p_decision: decision, p_admin_note: note || null });
  if (error) throw error;
}
export async function listPlans() {
  const { data, error } = await sb.from('plans').select('*').order('sort_order');
  if (error) throw error;
  return data || [];
}
export async function updatePlan(p) {
  const { error } = await sb.rpc('admin_update_plan', {
    p_plan_id: p.id, p_price_xof: p.price_xof, p_max_products: p.max_products, p_max_categories: p.max_categories, p_is_active: p.is_active
  });
  if (error) throw error;
}
export async function listSubscriptions() {
  const { data, error } = await sb.from('subscriptions')
    .select('id,status,starts_at,ends_at,created_at,restaurants(name),plans(name)').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}
export async function listAudit() {
  const { data, error } = await sb.from('audit_logs').select('id,actor_id,action,resource_type,resource_id,details,created_at').order('created_at', { ascending: false }).limit(150);
  if (error) throw error;
  const ids = [...new Set((data || []).map(x => x.actor_id).filter(Boolean))];
  let names = {};
  if (ids.length) {
    const p = await sb.from('profiles').select('id,full_name').in('id', ids);
    names = Object.fromEntries((p.data || []).map(x => [x.id, x.full_name]));
  }
  return (data || []).map(x => ({ ...x, actor_name: names[x.actor_id] || null }));
}
