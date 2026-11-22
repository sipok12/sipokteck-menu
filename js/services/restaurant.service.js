import { sb } from '../core/supabase.js';
import { slugify } from '../core/utils.js';

const PUBLIC_COLS = 'id,name,slug,description,logo_url,cover_url,phone,whatsapp,address,city,default_language,currency';
const EDITABLE = ['name', 'description', 'phone', 'whatsapp', 'address', 'city', 'default_language', 'logo_url', 'cover_url'];

/** Restaurants dont l'utilisateur est membre (owner/admin/staff). */
export async function listMyRestaurants(userId) {
  const { data, error } = await sb.from('restaurant_members')
    .select('role, restaurants(*)').eq('user_id', userId);
  if (error) throw error;
  return (data || []).filter(m => m.restaurants).map(m => ({ ...m.restaurants, my_role: m.role }));
}

const randomSuffix = () => Math.random().toString(36).slice(2, 6);

/** Création : le statut « pending » et le propriétaire sont imposés par un trigger côté base. */
export async function createRestaurant(userId, form) {
  const base = slugify(form.name).slice(0, 40) || 'restaurant';
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await sb.from('restaurants').insert({
      name: form.name, slug: `${base}-${randomSuffix()}`, phone: form.phone || null, whatsapp: form.whatsapp,
      city: form.city || null, address: form.address || null, description: form.description || null,
      default_language: form.default_language || 'fr', country: 'TG', currency: 'XOF', created_by: userId, status: 'pending'
    });
    if (!error) return; // pas de RETURNING : la lecture exige d'être membre, ajouté par trigger après l'insert
    if (error.code !== '23505') throw error; // seul un slug déjà pris justifie une nouvelle tentative
  }
  throw new Error('duplicate key');
}

export async function updateRestaurant(id, patch) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => EDITABLE.includes(k)));
  const { error } = await sb.from('restaurants').update(clean).eq('id', id);
  if (error) throw error;
}

export async function getPublicRestaurant(slug) {
  const { data, error } = await sb.from('restaurants').select(PUBLIC_COLS).eq('slug', slug).eq('status', 'active').maybeSingle();
  if (error) throw error;
  return data;
}

// Restaurant sélectionné (si le compte en possède plusieurs) — partagé entre tableau de bord et QR.
const SEL = 'sipokmenu.restaurant';
export function chooseRestaurant(list) {
  let saved = null;
  try { saved = localStorage.getItem(SEL); } catch { /* ignoré */ }
  return list.find(r => r.id === saved) || list[0] || null;
}
export function rememberRestaurant(id) { try { localStorage.setItem(SEL, id); } catch { /* ignoré */ } }
