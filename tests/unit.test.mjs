// Tests unitaires (Node >= 20) : node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- Environnement navigateur minimal + client Supabase simulé ----
const mock = { log: [], filters: [], queue: [], rpcResult: { data: { ok: true }, error: null }, uploaded: [] };
const take = () => (mock.queue.length ? mock.queue.shift() : { data: [], error: null });
function query(table, op, payload) {
  const q = {
    select: () => (mock.log.push([table, 'select']), q), eq: (c, v) => (mock.filters.push([table, 'eq', c, v]), q), in: () => q, or: f => (mock.filters.push([table, 'or', f]), q), order: () => q, limit: () => q,
    gte: () => q, lt: () => q, range: (a, b) => (mock.filters.push([table, 'range', a, b]), q),
    insert: p => (mock.log.push([table, 'insert', p]), q), update: p => (mock.log.push([table, 'update', p]), q), delete: () => (mock.log.push([table, 'delete']), q),
    maybeSingle: () => Promise.resolve(take()), single: () => Promise.resolve(take()),
    then: (res, rej) => Promise.resolve(take()).then(res, rej)
  };
  return q;
}
globalThis.window = {
  SIPOKMENU_CONFIG: { supabaseUrl: 'https://x.supabase.co', supabaseKey: 'sb_publishable_test' }
};
globalThis.__SIPOKMENU_CLIENT_FACTORY__ = () => ({
  from: t => query(t),
  rpc: (name, args) => (mock.log.push(['rpc', name, args]), Promise.resolve(mock.rpcResult)),
  storage: { from: bucket => ({ upload: (path, file) => (mock.uploaded.push([bucket, path, file.type]), Promise.resolve({ error: null })), getPublicUrl: p => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/b/${p}` } }) }) },
  auth: {}, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {}
});
globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
const reset = () => { mock.log.length = 0; mock.filters.length = 0; mock.queue.length = 0; mock.uploaded.length = 0; };

const U = await import('../js/core/utils.js');
const I = await import('../js/core/i18n.js');
const E = await import('../js/core/errors.js');
const R = await import('../js/services/restaurant.service.js');
const C = await import('../js/services/catalog.service.js');
const B = await import('../js/services/billing.service.js');
const O = await import('../js/services/orders.service.js');
const S = await import('../js/services/storage.service.js');
const M = await import('../js/services/messages.service.js');
const { fr } = await import('../js/locales/fr.js');
const { en } = await import('../js/locales/en.js');

test('esc neutralise le HTML et les guillemets', () => {
  assert.equal(U.esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(U.esc(null), ''); assert.equal(U.esc(undefined), '');
});
test('safeUrl : https uniquement', () => {
  assert.equal(U.safeUrl('https://a.com/x.png'), 'https://a.com/x.png');
  for (const bad of ['javascript:alert(1)', 'http://a.com/x', 'data:text/html,x', '//a.com/x', '', null, 'https://']) assert.equal(U.safeUrl(bad), '', String(bad));
});
test('slugify, digits, money', () => {
  assert.equal(U.slugify('Chez Mama Éfua !'), 'chez-mama-efua');
  assert.equal(U.digits('+228 90-00 00.00'), '22890000000');
  assert.match(U.money(2500, 'fr'), /^2\s?500 F$/u);
});
test('dictionnaires FR/EN : mêmes clés, mêmes paramètres', () => {
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
  for (const k of Object.keys(fr)) assert.equal(ph(fr[k]), ph(en[k]), k);
});
test('t() : paramètres, repli, langue', () => {
  I.setLang('fr', false); assert.equal(I.t('dash.hello', { name: 'Ama' }), 'Bonjour Ama.');
  I.setLang('en', false); assert.equal(I.t('nav.login'), 'Log in'); assert.equal(I.t('cle.inconnue'), 'cle.inconnue');
  I.setLang('fr', false);
});
test('friendlyError : messages traduits, jamais de SQL brut', () => {
  I.setLang('fr', false);
  assert.match(E.friendlyError({ message: 'PLAN_LIMIT_PRODUCTS:30' }), /30 produits/);
  assert.match(E.friendlyError({ message: 'PLAN_LIMIT_CATEGORIES:5' }), /5 catégories/);
  assert.equal(E.friendlyError({ code: '23505', message: 'duplicate key value violates unique constraint "restaurants_slug_key"' }), fr['err.duplicate']);
  assert.equal(E.friendlyError({ code: '42501', message: 'permission denied for table payments' }), fr['err.denied']);
  assert.equal(E.friendlyError({ message: 'Too many orders. Please try again later' }), fr['err.tooManyOrders']);
  assert.equal(E.friendlyError({ message: 'Failed to fetch' }), fr['err.network']);
  const raw = 'relation "secret_table" does not exist at character 15';
  assert.equal(E.friendlyError({ message: raw }), fr['err.generic']);
  assert.ok(!E.friendlyError({ message: raw }).includes('secret_table'));
});

test('createRestaurant : statut pending forcé, sans RETURNING, retry uniquement sur slug dupliqué', async () => {
  reset(); mock.queue.push({ error: { code: '23505' } }, { error: { code: '23505' } }, { error: null });
  await R.createRestaurant('user-1', { name: 'Chez Ama', whatsapp: '22890000000' });
  const inserts = mock.log.filter(l => l[1] === 'insert');
  assert.equal(inserts.length, 3);
  assert.equal(inserts[0][2].status, 'pending'); assert.equal(inserts[0][2].created_by, 'user-1'); assert.equal(inserts[0][2].country, 'TG');
  assert.match(inserts[0][2].slug, /^chez-ama-[a-z0-9]{1,4}$/);
  assert.ok(!mock.log.some(l => l[1] === 'select'), 'pas de .select() (RETURNING) après insert');
  reset(); mock.queue.push({ error: { code: '42501', message: 'denied' } });
  await assert.rejects(() => R.createRestaurant('u', { name: 'X Y', whatsapp: '22890000000' }));
  assert.equal(mock.log.filter(l => l[1] === 'insert').length, 1, 'pas de retry sur une autre erreur');
  reset(); mock.queue.push(...Array(4).fill({ error: { code: '23505' } }));
  await assert.rejects(() => R.createRestaurant('u', { name: 'X Y', whatsapp: '22890000000' }));
  assert.equal(mock.log.filter(l => l[1] === 'insert').length, 4, 'abandon après 4 tentatives');
});
test('updateRestaurant : liste blanche (slug, status, created_by ignorés)', async () => {
  reset(); mock.queue.push({ error: null });
  await R.updateRestaurant('r1', { name: 'N', slug: 'pirate', status: 'active', created_by: 'x', city: 'Lomé', whatsapp: '228' });
  const patch = mock.log.find(l => l[1] === 'update')[2];
  assert.deepEqual(Object.keys(patch).sort(), ['city', 'name', 'whatsapp']);
});
test('deleteProduct : suppression, archivage si FK, erreur sinon', async () => {
  reset(); mock.queue.push({ error: null });
  assert.equal(await C.deleteProduct('p1'), 'deleted');
  reset(); mock.queue.push({ error: { code: '23503' } }, { error: null });
  assert.equal(await C.deleteProduct('p1'), 'archived');
  assert.deepEqual(mock.log.find(l => l[1] === 'update')[2], { is_active: false, is_available: false });
  reset(); mock.queue.push({ error: { code: '42501' } });
  await assert.rejects(() => C.deleteProduct('p1'));
});
test('deleteCategory : détache les produits avant suppression', async () => {
  reset(); mock.queue.push({ error: null }, { error: null });
  await C.deleteCategory('c1');
  assert.deepEqual(mock.log.map(l => l.slice(0, 2).join(':')), ['products:update', 'categories:delete']);
  assert.deepEqual(mock.log[0][2], { category_id: null });
});
test('addProduct : champs normalisés, restaurant imposé', async () => {
  reset(); mock.queue.push({ error: null });
  await C.addProduct('r1', { name: 'Riz', price_xof: 1500, category_id: '', image_url: '', name_en: '' });
  const row = mock.log.find(l => l[1] === 'insert')[2];
  assert.equal(row.restaurant_id, 'r1'); assert.equal(row.category_id, null); assert.equal(row.image_url, null); assert.equal(row.name_en, null); assert.equal(row.is_active, true);
});
test('requestSubscription : aucun montant envoyé par le navigateur', async () => {
  reset();
  await B.requestSubscription({ restaurantId: 'r1', planCode: 'business', method: 'tmoney', reference: 'TM1', file: null });
  const [, name, args] = mock.log.find(l => l[0] === 'rpc');
  assert.equal(name, 'request_subscription');
  assert.deepEqual(Object.keys(args).sort(), ['p_method', 'p_plan_code', 'p_proof_path', 'p_reference', 'p_restaurant_id']);
  assert.ok(!Object.keys(args).some(k => /amount|price/i.test(k)));
  assert.equal(args.p_proof_path, null);
});
test('requestSubscription avec justificatif : chemin <restaurant_id>/<fichier>, bucket privé', async () => {
  reset();
  const file = new File([new Uint8Array(100)], 'preuve.png', { type: 'image/png' });
  await B.requestSubscription({ restaurantId: 'r-123', planCode: 'starter', method: 'flooz', reference: '', file });
  assert.equal(mock.uploaded[0][0], 'payment-proofs');
  const args = mock.log.find(l => l[0] === 'rpc')[2];
  assert.match(args.p_proof_path, /^r-123\/[^/]+\.png$/);
  assert.equal(args.p_reference, null);
});
test('upload : types et tailles refusés avant tout envoi', async () => {
  reset();
  await assert.rejects(() => S.uploadPublicImage('product-images', 'r1', new File(['<script>'], 'x.html', { type: 'text/html' })), /not allowed/);
  await assert.rejects(() => S.uploadPublicImage('product-images', 'r1', new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })), /too large/);
  await assert.rejects(() => S.uploadPublicImage('product-images', 'r1', new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })), /not allowed/, 'PDF refusé pour une image publique');
  assert.equal(mock.uploaded.length, 0);
  const url = await S.uploadPublicImage('restaurant-logos', 'r1', new File([new Uint8Array(50)], 'l.png', { type: 'image/png' }));
  assert.match(url, /^https:\/\/.+\/r1\/[^/]+\.png$/);
});
test('commandes : seul le statut est envoyé', async () => {
  reset(); mock.queue.push({ error: null }, { error: null });
  await O.updateOrderStatus('o1', 'confirmed'); await O.updatePaymentStatus('o1', 'paid');
  const ups = mock.log.filter(l => l[1] === 'update').map(l => l[2]);
  assert.deepEqual(ups, [{ status: 'confirmed' }, { payment_status: 'paid' }]);
});
test('getStats / getBilling : appels RPC attendus', async () => {
  reset(); await B.getStats('r1', 30); await B.getBilling('r1');
  assert.deepEqual(mock.log.filter(l => l[0] === 'rpc').map(l => [l[1], l[2]]),
    [['restaurant_stats', { p_restaurant_id: 'r1', p_days: 30 }], ['my_billing', { p_restaurant_id: 'r1' }]]);
});

test('waLink : message prérempli, rien sans numéro valide', () => {
  assert.equal(U.waLink('+228 90 00 00 00', 'Bonjour #12'), 'https://wa.me/22890000000?text=Bonjour%20%2312');
  assert.equal(U.waLink('12', 'x'), ''); assert.equal(U.waLink('', 'x'), '');
});
test('historique : recherche assainie (pas d\'injection dans le filtre or)', async () => {
  reset(); mock.queue.push({ data: [], error: null, count: 0 });
  await O.searchOrders('r1', { from: 'a', to: 'b', status: 'open', q: 'x,customer_phone.eq.1)%', offset: 30, limit: 30 });
  const or = mock.filters.find(l => l[1] === 'or')[2];
  assert.ok(!/[()]/.test(or.replace(/\.ilike\./g, '')) && !or.includes('%)'), or);
  assert.equal(or.split(',').length, 2); // aucune virgule injectée : seulement nom et téléphone
  assert.deepEqual(mock.filters.find(l => l[1] === 'range').slice(2), [30, 59]);
  reset(); mock.queue.push({ data: [], error: null, count: 0 });
  await O.searchOrders('r1', { from: 'a', to: 'b', q: '#42' });
  assert.match(mock.filters.find(l => l[1] === 'or')[2], /order_number\.eq\.42/);
});
test('messagerie : le client passe uniquement par le jeton, le restaurant par l\'identifiant de commande', async () => {
  reset();
  await M.customerSend('abc', 'salut'); await M.customerMessages('abc', true); await M.trackOrder('abc');
  await M.sendMessage('o1', 'ok'); await M.markRead('o1'); await M.listConversations('r1');
  assert.deepEqual(mock.log.filter(l => l[0] === 'rpc').map(l => [l[1], l[2]]), [
    ['customer_send_message', { p_token: 'abc', p_content: 'salut' }], ['customer_messages', { p_token: 'abc', p_mark_read: true }],
    ['track_order', { p_token: 'abc' }], ['send_restaurant_message', { p_order_id: 'o1', p_content: 'ok' }],
    ['mark_order_messages_read', { p_order_id: 'o1' }], ['list_conversations', { p_restaurant_id: 'r1' }]]);
});
test('erreurs de messagerie traduites, jamais brutes', () => {
  I.setLang('fr', false);
  for (const m of ['Invalid or expired link', 'Too many messages. Please wait', 'Messaging is closed for this order', 'Invalid message']) {
    const text = E.friendlyError({ message: m });
    assert.notEqual(text, m); assert.ok(!/^err\./.test(text), text);
  }
});
