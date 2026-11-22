import { sb } from '../core/supabase.js';
import { $, esc, money } from '../core/utils.js';
import { t, getLang, applyI18n, initLangToggle } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { getSession } from '../core/auth.js';
import { listPlans } from '../services/billing.service.js';

let mode = 'login'; // login | signup | forgot
let plans = [];

function setMode(next) {
  mode = next;
  $('authModal').classList.remove('hidden');
  $('modalTitle').textContent = t(`auth.title.${mode}`);
  $('authSubmit').textContent = t(`auth.submit.${mode}`);
  $('switchMode').textContent = mode === 'signup' ? t('auth.haveAccount') : t('auth.createAccount');
  $('signupFields').classList.toggle('hidden', mode !== 'signup');
  $('password').classList.toggle('hidden', mode === 'forgot');
  $('password').required = mode !== 'forgot';
  $('password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('forgotBtn').classList.toggle('hidden', mode !== 'login');
  $('authMessage').textContent = '';
  $('authMessage').className = 'notice';
  setTimeout(() => $(mode === 'signup' ? 'fullName' : 'email').focus(), 30);
}
const closeModal = () => $('authModal').classList.add('hidden');
function message(text, ok = false) { const el = $('authMessage'); el.textContent = text; el.className = ok ? 'notice ok' : 'notice'; }

async function submit(event) {
  event.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email) return message(t('auth.emailRequired'));
  if (mode !== 'forgot' && password.length < 8) return message(t('err.passwordShort'));
  const button = $('authSubmit');
  button.disabled = true;
  try {
    if (mode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      location.href = '/dashboard';
    } else if (mode === 'signup') {
      const fullName = $('fullName').value.trim();
      if (fullName.length < 2) return message(t('auth.nameRequired'));
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { full_name: fullName }, emailRedirectTo: `${location.origin}/dashboard` }
      });
      if (error) throw error;
      if (data.session) {
        const phone = $('phone').value.trim();
        if (phone) await sb.from('profiles').update({ phone }).eq('id', data.session.user.id); // facultatif, sans blocage
        location.href = '/dashboard';
      } else message(t('auth.confirmEmail'), true);
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/reset` });
      if (error) throw error;
      message(t('auth.resetSent'), true); // message identique que le compte existe ou non
    }
  } catch (error) {
    message(friendlyError(error));
  } finally {
    button.disabled = false;
  }
}

const FEATURE_KEYS = ['qr_code', 'whatsapp_orders', 'basic_stats', 'customization', 'priority_support'];

function renderPlans() {
  const grid = $('plansGrid');
  if (!plans.length) { grid.innerHTML = `<p class="muted">${esc(t('home.plansError'))}</p>`; return; }
  grid.innerHTML = plans.map(p => {
    const features = FEATURE_KEYS.filter(k => p.features?.[k]).map(k => `<li>${esc(t(`feat.${k}`))}</li>`).join('');
    const products = p.max_products == null ? t('plans.unlimitedProducts') : t('plans.upToProducts', { n: p.max_products });
    const cats = p.max_categories == null ? t('plans.unlimitedCategories') : t('plans.upToCategories', { n: p.max_categories });
    return `<article class="${p.code === 'business' ? 'popular' : ''}">${p.code === 'business' ? `<span class="badge-pop">${esc(t('plans.popular'))}</span>` : ''}
      <h3>${esc(p.name)}</h3><strong>${money(p.price_xof, getLang())} <small>${esc(t('plans.perMonth'))}</small></strong>
      <ul><li>${esc(products)}</li><li>${esc(cats)}</li>${features}</ul></article>`;
  }).join('');
}

async function init() {
  initLangToggle(() => { renderPlans(); if (!$('authModal').classList.contains('hidden')) setMode(mode); });
  $('loginOpen').onclick = () => setMode('login');
  $('signupOpen').onclick = () => setMode('signup');
  $('closeModal').onclick = closeModal;
  $('authModal').addEventListener('click', e => { if (e.target.id === 'authModal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  $('switchMode').onclick = () => setMode(mode === 'signup' ? 'login' : 'signup');
  $('forgotBtn').onclick = () => setMode('forgot');
  $('authForm').addEventListener('submit', submit);

  try { plans = await listPlans(); } catch { plans = []; }
  renderPlans();

  try {
    const session = await getSession();
    if (session) { $('loginOpen').classList.add('hidden'); $('signupOpen').classList.add('hidden'); $('spaceLink').classList.remove('hidden'); }
    else if (new URLSearchParams(location.search).get('login') === '1') setMode('login');
  } catch { /* page publique : on ignore */ }
  applyI18n();
}
init();
