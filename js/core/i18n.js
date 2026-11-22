import { fr } from '../locales/fr.js';
import { en } from '../locales/en.js';

const dictionaries = { fr, en };
const KEY = 'sipokmenu.lang';
let lang = 'fr';

try {
  const saved = localStorage.getItem(KEY);
  lang = saved === 'en' || saved === 'fr' ? saved : ((navigator.language || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr');
} catch { /* stockage indisponible */ }

export const getLang = () => lang;

export function setLang(next, persist = true) {
  if (!dictionaries[next]) return;
  lang = next;
  if (persist) { try { localStorage.setItem(KEY, next); } catch { /* ignoré */ } }
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

/** Traduit une clé ; remplace {param} ; retombe sur le français puis sur la clé. */
export function t(key, params = {}) {
  const raw = dictionaries[lang][key] ?? dictionaries.fr[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

/** Traduit les éléments marqués data-i18n / data-i18n-placeholder / data-i18n-aria. */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  root.querySelectorAll('[data-lang-toggle]').forEach(el => { el.textContent = lang === 'fr' ? 'EN' : 'FR'; });
}

/** Branche le bouton de langue ; onChange est rappelé après changement. */
export function initLangToggle(onChange = () => {}) {
  document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      setLang(lang === 'fr' ? 'en' : 'fr');
      applyI18n();
      onChange(lang);
    });
  });
  applyI18n();
}

/** Texte localisé d'un champ bilingue (name / name_en). */
export const pick = (row, field) => (lang === 'en' && row?.[`${field}_en`]) || row?.[field] || '';
