import { sb } from '../core/supabase.js';

// ---------- Catégories ----------
export async function listCategories(restaurantId) {
  const { data, error } = await sb.from('categories').select('*').eq('restaurant_id', restaurantId)
    .order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}
export async function addCategory(restaurantId, { name, name_en }, sortOrder = 0) {
  const { error } = await sb.from('categories').insert({ restaurant_id: restaurantId, name, name_en: name_en || null, sort_order: sortOrder, is_active: true });
  if (error) throw error;
}
export async function updateCategory(id, patch) {
  const { error } = await sb.from('categories').update(patch).eq('id', id);
  if (error) throw error;
}
/** Les produits de la catégorie sont conservés (déplacés « sans catégorie »). */
export async function deleteCategory(id) {
  const detach = await sb.from('products').update({ category_id: null }).eq('category_id', id);
  if (detach.error) throw detach.error;
  const { error } = await sb.from('categories').delete().eq('id', id);
  if (error) throw error;
}
export async function reorderCategories(orderedIds) {
  const results = await Promise.all(orderedIds.map((id, index) => sb.from('categories').update({ sort_order: index }).eq('id', id)));
  const failed = results.find(r => r.error);
  if (failed) throw failed.error;
}

// ---------- Produits ----------
export async function listProducts(restaurantId) {
  const { data, error } = await sb.from('products').select('*').eq('restaurant_id', restaurantId)
    .order('sort_order').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
const productFields = p => ({
  category_id: p.category_id || null, name: p.name, name_en: p.name_en || null,
  description: p.description || null, description_en: p.description_en || null,
  price_xof: p.price_xof, image_url: p.image_url || null, is_available: p.is_available !== false
});
export async function addProduct(restaurantId, product) {
  const { error } = await sb.from('products').insert({ restaurant_id: restaurantId, is_active: true, ...productFields(product) });
  if (error) throw error;
}
export async function updateProduct(id, product) {
  const { error } = await sb.from('products').update(productFields(product)).eq('id', id);
  if (error) throw error;
}
export async function setProductAvailable(id, available) {
  const { error } = await sb.from('products').update({ is_available: available }).eq('id', id);
  if (error) throw error;
}
/** Supprime ; si le produit figure dans des commandes (FK), il est archivé à la place. */
export async function deleteProduct(id) {
  const { error } = await sb.from('products').delete().eq('id', id);
  if (!error) return 'deleted';
  if (error.code === '23503') {
    const archive = await sb.from('products').update({ is_active: false, is_available: false }).eq('id', id);
    if (archive.error) throw archive.error;
    return 'archived';
  }
  throw error;
}
