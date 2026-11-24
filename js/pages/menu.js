import { sb } from '../core/supabase.js';
import { $, esc, money, safeUrl, digits, debounce } from '../core/utils.js';
import { t, getLang, setLang, pick, applyI18n, initLangToggle } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { getPublicRestaurant } from '../services/restaurant.service.js';

const slug = new URLSearchParams(location.search).get('slug');
const CUSTOMER_KEY = 'sipokmenu.customer';
let restaurant, categories = [], products = [], active = 'all';
const cart = new Map(); // product_id -> quantité (prix toujours recalculés par le serveur)

const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const cartKey = () => `sipokmenu.cart.${slug}`;
const fmt = n => money(n, getLang());

function saveCart() { try { localStorage.setItem(cartKey(), JSON.stringify([...cart])); } catch { /* ignoré */ } }
function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(cartKey()) || '[]');
    saved.forEach(([id, qty]) => { if (products.some(p => p.id === id) && Number.isInteger(qty) && qty > 0) cart.set(id, Math.min(qty, 50)); });
  } catch { /* panier illisible : on repart de zéro */ }
}
const cartCount = () => [...cart.values()].reduce((a, b) => a + b, 0);
const cartTotal = () => products.reduce((s, p) => s + (cart.get(p.id) || 0) * p.price_xof, 0);

function fail(text) { $('loading').classList.add('hidden'); $('error').textContent = text; $('error').classList.remove('hidden'); }

function renderHeader() {
  const r = restaurant;
  document.title = `${r.name} — SipokMenu`;
  $('restaurantName').textContent = r.name;
  $('restaurantDesc').textContent = r.description || '';
  $('restaurantMeta').textContent = [r.city, r.address].filter(Boolean).join(' • ');
  const cover = safeUrl(r.cover_url);
  $('cover').innerHTML = cover ? `<img src="${esc(cover)}" alt="" loading="eager" referrerpolicy="no-referrer">` : '';
  const logo = safeUrl(r.logo_url);
  $('logo').classList.toggle('hidden', !logo);
  if (logo) $('logo').src = logo;
  const links = [];
  const tel = String(r.phone || '').replace(/[^0-9+]/g, '');
  if (tel) links.push(`<a href="tel:${esc(tel)}">📞 ${esc(t('menu.call'))}</a>`);
  const wa = digits(r.whatsapp);
  if (wa) links.push(`<a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a>`);
  $('contactLinks').innerHTML = links.join('');
}

function renderCategories() {
  const chips = [{ id: 'all', label: t('menu.all') }, ...categories.map(c => ({ id: c.id, label: pick(c, 'name') }))];
  $('categories').innerHTML = chips.map(c => `<button type="button" data-cat="${esc(c.id)}" class="${active === c.id ? 'active' : ''}">${esc(c.label)}</button>`).join('');
}

function renderProducts() {
  const q = norm($('search').value);
  const list = products.filter(p => (active === 'all' || p.category_id === active)
    && norm(`${p.name} ${p.name_en || ''} ${p.description || ''} ${p.description_en || ''}`).includes(q));
  $('products').innerHTML = list.map(p => {
    const image = safeUrl(p.image_url);
    const inCart = cart.get(p.id);
    return `<article class="product">${image ? `<img loading="lazy" src="${esc(image)}" alt="${esc(pick(p, 'name'))}" referrerpolicy="no-referrer">` : '<div class="product-placeholder" aria-hidden="true">🍽️</div>'}
      <div class="product-info"><h3>${esc(pick(p, 'name'))}</h3><p>${esc(pick(p, 'description'))}</p>
      <div class="product-foot"><b>${fmt(p.price_xof)}</b><button type="button" class="btn" data-add="${esc(p.id)}">${esc(t('menu.add'))}${inCart ? ` (${inCart})` : ''}</button></div></div></article>`;
  }).join('') || `<p class="empty">${esc(t('menu.none'))}</p>`;
}

function renderCart() {
  const count = cartCount();
  $('cartCount').textContent = count;
  $('cartBar').classList.toggle('hidden', count === 0 || !$('cartModal').classList.contains('hidden'));
  $('cartBarCount').textContent = t('menu.items', { n: count });
  $('cartBarTotal').textContent = fmt(cartTotal());
  const lines = products.filter(p => cart.has(p.id));
  $('cartLines').innerHTML = lines.length ? lines.map(p => `<div class="cart-line"><span>${esc(pick(p, 'name'))}<br><small>${fmt(p.price_xof)}</small></span>
    <span class="qty"><button type="button" data-minus="${esc(p.id)}" aria-label="−">−</button><b>${cart.get(p.id)}</b><button type="button" data-plus="${esc(p.id)}" aria-label="+">+</button></span></div>`).join('')
    : `<p class="muted">${esc(t('menu.cartEmpty'))}</p>`;
  $('cartTotal').textContent = `${t('menu.estimated')} ${fmt(cartTotal())}`;
  $('checkout').classList.toggle('hidden', lines.length === 0);
}

function renderAll() { renderHeader(); renderCategories(); renderProducts(); renderCart(); applyI18n(); }

const changeQty = (id, delta) => {
  const next = (cart.get(id) || 0) + delta;
  if (next <= 0) cart.delete(id); else cart.set(id, Math.min(next, 50));
  saveCart(); renderProducts(); renderCart();
};

function openCart() { $('confirmation').classList.add('hidden'); $('cartModal').classList.remove('hidden'); renderCart(); }
function closeCart() { $('cartModal').classList.add('hidden'); renderCart(); }

function buildWhatsAppLink(order, snapshot, customer) {
  const number = digits(restaurant.whatsapp || restaurant.phone);
  if (!number) return '';
  const lines = snapshot.map(i => `${i.qty} x ${i.name}`).join('\n');
  const text = t('menu.waText', { restaurant: restaurant.name, order: order.order_number ?? '', lines, total: fmt(order.total_xof), name: customer.name, phone: customer.phone });
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function showConfirmation(order, link, viaWhatsapp) {
  $('checkout').classList.add('hidden');
  $('cartLines').innerHTML = ''; $('cartTotal').textContent = '';
  $('confirmation').innerHTML = `<h3>✅ ${esc(t('menu.saved', { n: order.order_number ?? '' }))}</h3>
    <p>${esc(t('menu.savedText', { total: fmt(order.total_xof) }))}</p>
    ${viaWhatsapp ? (link ? `<a class="btn wa" href="${esc(link)}" target="_blank" rel="noopener">💬 ${esc(t('menu.sendWhatsapp'))}</a>` : `<p class="notice">${esc(t('menu.noWhatsapp'))}</p>`) : ''}
    ${order.tracking_token ? `<p><a class="btn" href="/suivi#${esc(order.tracking_token)}">${esc(t('menu.trackOrder'))}</a><br><small class="muted">${esc(t('menu.trackHint'))}</small></p>` : ''}
    <p><button type="button" class="btn secondary" id="newOrder">${esc(t('menu.newOrder'))}</button></p>`;
  $('confirmation').classList.remove('hidden');
  $('newOrder').onclick = closeCart;
}

async function checkout(event) {
  event.preventDefault();
  const msg = $('checkoutMessage');
  msg.textContent = '';
  const name = $('customerName').value.trim(), phone = $('customerPhone').value.trim();
  const type = $('orderType').value, address = $('deliveryAddress').value.trim();
  if (name.length < 2) return void (msg.textContent = t('err.customerName'));
  if (digits(phone).length < 8) return void (msg.textContent = t('err.phone'));
  if (type === 'delivery' && address.length < 5) return void (msg.textContent = t('err.deliveryAddress'));
  if (!cart.size) return;
  const channel = document.querySelector('input[name="channel"]:checked').value;
  const items = [...cart].map(([product_id, quantity]) => ({ product_id, quantity }));
  const snapshot = products.filter(p => cart.has(p.id)).map(p => ({ qty: cart.get(p.id), name: pick(p, 'name') }));
  const button = $('checkoutBtn');
  button.disabled = true; msg.textContent = t('menu.sending');
  try {
    const { data, error } = await sb.rpc('submit_public_order', {
      p_restaurant_slug: slug, p_customer_name: name, p_customer_phone: phone,
      p_customer_note: $('customerNote').value.trim() || null, p_order_type: type,
      p_delivery_address: type === 'delivery' ? address : null, p_items: items,
      p_source: channel === 'whatsapp' ? 'whatsapp' : 'public_menu'
    });
    if (error) throw error;
    try { localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name, phone })); } catch { /* ignoré */ }
    msg.textContent = '';
    cart.clear(); saveCart(); renderProducts();
    showConfirmation(data, channel === 'whatsapp' ? buildWhatsAppLink(data, snapshot, { name, phone }) : '', channel === 'whatsapp');
    $('cartCount').textContent = '0'; $('cartBar').classList.add('hidden');
  } catch (error) {
    msg.textContent = friendlyError(error);
  } finally { button.disabled = false; }
}

function bind() {
  $('categories').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { active = b.dataset.cat; renderCategories(); renderProducts(); } });
  $('products').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) changeQty(b.dataset.add, 1); });
  $('cartLines').addEventListener('click', e => {
    const plus = e.target.closest('[data-plus]'), minus = e.target.closest('[data-minus]');
    if (plus) changeQty(plus.dataset.plus, 1); if (minus) changeQty(minus.dataset.minus, -1);
  });
  $('search').addEventListener('input', debounce(renderProducts, 150));
  $('cartOpen').onclick = openCart; $('cartBarBtn').onclick = openCart; $('cartClose').onclick = closeCart;
  $('cartModal').addEventListener('click', e => { if (e.target.id === 'cartModal') closeCart(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCart(); });
  $('orderType').onchange = () => {
    const delivery = $('orderType').value === 'delivery';
    $('deliveryAddress').classList.toggle('hidden', !delivery);
    $('deliveryAddress').required = delivery;
  };
  $('checkout').addEventListener('submit', checkout);
}

async function init() {
  initLangToggle(() => { if (restaurant) renderAll(); });
  if (!slug) return fail(t('menu.badLink'));
  try {
    restaurant = await getPublicRestaurant(slug);
    if (!restaurant) return fail(t('menu.unavailable'));
    let hasPref = false;
    try { hasPref = Boolean(localStorage.getItem('sipokmenu.lang')); } catch { /* ignoré */ }
    if (!hasPref) setLang(restaurant.default_language === 'en' ? 'en' : 'fr', false);
    const [c, p] = await Promise.all([
      sb.from('categories').select('id,name,name_en,sort_order').eq('restaurant_id', restaurant.id).eq('is_active', true).order('sort_order').order('created_at'),
      sb.from('products').select('id,category_id,name,name_en,description,description_en,image_url,price_xof').eq('restaurant_id', restaurant.id).eq('is_active', true).eq('is_available', true).order('sort_order').order('created_at')
    ]);
    if (c.error || p.error) throw c.error || p.error;
    categories = c.data || []; products = p.data || [];
    loadCart();
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOMER_KEY) || 'null');
      if (saved) { $('customerName').value = saved.name || ''; $('customerPhone').value = saved.phone || ''; }
    } catch { /* ignoré */ }
    bind();
    $('loading').classList.add('hidden'); $('menu').classList.remove('hidden');
    renderAll();
  } catch (error) { fail(friendlyError(error)); }
}
init();
