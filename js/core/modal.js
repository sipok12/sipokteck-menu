import { $ } from './utils.js';

/** Modale accessible : Échap et clic sur le fond ferment ; le focus revient à l'élément d'origine. */
export function openModal(html, { onMount, size = '' } = {}) {
  const root = $('modalRoot');
  const opener = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML = `<div class="modal-card ${size}"><button type="button" class="close" data-close aria-label="Close">×</button>${html}</div>`;
  const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); opener?.focus?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(wrap);
  wrap.querySelector('input,select,textarea,button:not(.close)')?.focus();
  onMount?.(wrap, close);
  return { el: wrap, close };
}

export function confirmDialog(message, okLabel, cancelLabel) {
  return new Promise(resolve => {
    const { el, close } = openModal(`<p>${message}</p><div class="btn-row"><button type="button" class="btn danger" data-ok>${okLabel}</button><button type="button" class="btn secondary" data-close>${cancelLabel}</button></div>`);
    el.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
    el.addEventListener('click', e => { if (e.target === el || e.target.closest('.close,[data-close]')) resolve(false); });
  });
}
