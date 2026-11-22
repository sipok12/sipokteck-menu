import { $, esc, toast } from '../core/utils.js';
import { t, applyI18n, initLangToggle } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { requireSession, getProfile, bindLogout } from '../core/auth.js';
import { listMyRestaurants, chooseRestaurant, rememberRestaurant } from '../services/restaurant.service.js';
import { getBilling } from '../services/billing.service.js';
import { renderOnboarding } from '../dashboard/onboarding.js';
import { mountOverview, updateOverviewCounts } from '../dashboard/overview.js';
import { createOrders } from '../dashboard/orders.js';
import { mountProducts } from '../dashboard/products.js';
import { mountCategories } from '../dashboard/categories.js';
import { mountBilling } from '../dashboard/billing.js';
import { mountSettings } from '../dashboard/settings.js';

const app = $('app');
const ALL_TABS = ['overview', 'orders', 'products', 'categories', 'billing', 'settings'];
const STAFF_TABS = ['overview', 'orders', 'products', 'categories']; // le personnel ne gère ni abonnement ni paramètres
const badges = {};
let ctx, ordersModule, restaurants, tabs, active, mounted;

function bannerHtml(r) {
  if (r.status === 'pending') return `<div class="banner">${esc(t('dash.pendingBanner'))}</div>`;
  if (r.status === 'suspended') return `<div class="banner bad">${esc(t('dash.suspendedBanner'))}</div>`;
  return '';
}

function headerHtml() {
  const r = ctx.restaurant;
  return `<small class="eyebrow">${esc(t('dash.eyebrow'))}</small><h1>${esc(r.name)}</h1>
    ${restaurants.length > 1 ? `<select id="restoSwitch" aria-label="${esc(t('dash.switch'))}">${restaurants.map(x => `<option value="${esc(x.id)}" ${x.id === r.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
    <p class="muted">${esc(t('dash.hello', { name: ctx.profile?.full_name || ctx.user.email }))}</p><div id="banner">${bannerHtml(r)}</div>`;
}

function setBadge(tab, n) {
  badges[tab] = n;
  const btn = app.querySelector(`[data-tab="${tab}"]`);
  if (!btn) return;
  btn.querySelector('.dot')?.remove();
  if (n > 0) btn.insertAdjacentHTML('beforeend', `<span class="dot" aria-label="${n}">${n}</span>`);
}

function activate(tab, push = true) {
  if (!tabs.includes(tab)) tab = tabs[0];
  active = tab;
  app.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  app.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  if (push) history.replaceState(null, '', `#${tab}`);
  const el = $(`tab-${tab}`);
  if (tab === 'orders') ordersModule.mount(el);
  else if (tab === 'overview' || !mounted.has(tab)) {
    mounted.add(tab);
    const run = { overview: () => mountOverview(ctx, el, ordersModule.list()), products: () => mountProducts(ctx, el),
      categories: () => mountCategories(ctx, el), billing: () => mountBilling(ctx, el), settings: () => mountSettings(ctx, el) }[tab];
    Promise.resolve(run()).catch(error => { el.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; });
  }
}

function renderShell() {
  mounted = new Set();
  app.innerHTML = `${headerHtml()}<div class="tabs" role="tablist">${tabs.map(tab => `<button type="button" role="tab" data-tab="${tab}" aria-selected="false">${esc(t(`tab.${tab}`))}</button>`).join('')}</div>
    ${tabs.map(tab => `<section class="tab-panel hidden" id="tab-${tab}" role="tabpanel"></section>`).join('')}`;
  Object.entries(badges).forEach(([tab, n]) => setBadge(tab, n));
  app.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) activate(b.dataset.tab); });
  $('restoSwitch')?.addEventListener('change', e => { rememberRestaurant(e.target.value); location.reload(); });
  activate(location.hash.slice(1) || 'overview', false);
}

async function init() {
  initLangToggle(() => { if (ctx) { renderShell(); } else location.reload(); });
  bindLogout();
  try {
    const session = await requireSession();
    if (!session) return;
    const user = session.user;
    const profile = await getProfile(user.id);
    if (profile?.platform_role === 'platform_admin') $('adminLink').classList.remove('hidden');
    restaurants = await listMyRestaurants(user.id);
    const restaurant = chooseRestaurant(restaurants);
    if (!restaurant) return renderOnboarding(app, user);

    const canManage = restaurant.my_role === 'owner' || restaurant.my_role === 'admin';
    tabs = canManage ? ALL_TABS : STAFF_TABS;
    ctx = {
      user, profile, restaurant, canManage, setBadge,
      go: tab => activate(tab),
      refreshHeader() { $('banner').innerHTML = bannerHtml(ctx.restaurant); app.querySelector('h1').textContent = ctx.restaurant.name; },
      ordersChanged: list => updateOverviewCounts($('tab-overview'), list),
      getBilling: () => (canManage ? getBilling(restaurant.id).catch(() => null) : Promise.resolve(null))
    };
    ordersModule = createOrders(ctx);
    await ordersModule.start(); // première lecture des commandes avant d'afficher l'aperçu
    renderShell();
    window.addEventListener('pagehide', () => ordersModule.destroy());
    window.addEventListener('hashchange', () => activate(location.hash.slice(1), false));
    applyI18n();
  } catch (error) {
    app.innerHTML = `<p class="notice" role="alert">${esc(friendlyError(error))}</p>`;
    toast(friendlyError(error), 'error');
  }
}
init();
