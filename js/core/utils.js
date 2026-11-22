export const $ = (id, root = document) => root.getElementById ? root.getElementById(id) : root.querySelector('#' + id);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** Montant en FCFA, formaté selon la langue. */
export const money = (amount, lang = 'fr') =>
  new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'fr-FR').format(Math.round(Number(amount) || 0)) + ' F';

/** N'accepte que les URL https (images, liens). Retourne '' sinon. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

export const digits = value => String(value ?? '').replace(/\D/g, '');

export const slugify = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function debounce(fn, delay = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

export function formatDate(value, lang = 'fr', withTime = false) {
  if (!value) return '';
  const opts = withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'fr-FR', opts).format(new Date(value));
}

export const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Notification non bloquante (région aria-live). */
export function toast(message, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add('toast-out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

/** Désactive un bouton pendant une opération asynchrone. */
export async function withBusy(button, task) {
  if (button) button.disabled = true;
  try { return await task(); } finally { if (button) button.disabled = false; }
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text; document.body.appendChild(area); area.select();
  document.execCommand('copy'); area.remove();
  return Promise.resolve();
}
