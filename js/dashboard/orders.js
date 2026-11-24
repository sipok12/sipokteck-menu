import { esc, money, waLink, formatDate, toast } from '../core/utils.js';
import { t, getLang } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { confirmDialog } from '../core/modal.js';
import { listOrders, updateOrderStatus, updatePaymentStatus, listOrderEvents, subscribeOrders } from '../services/orders.service.js';

const NEXT = { pending: 'confirmed', confirmed: 'preparing', preparing: 'ready', ready: 'completed' };
const TONE = { pending: 'warn', confirmed: '', preparing: '', ready: 'ok', completed: 'grey', cancelled: 'bad' };
const isOpen = o => o.status !== 'completed' && o.status !== 'cancelled';

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.frequency.value = 880; gain.gain.setValueAtTime(0.15, ac.currentTime);
    osc.start(); osc.stop(ac.currentTime + 0.18);
  } catch { /* son indisponible : sans importance */ }
}

/** Module actif dès l'ouverture du tableau de bord : badge « nouvelles commandes » + temps réel. */
export function createOrders(ctx) {
  const rid = ctx.restaurant.id;
  let orders = [], el = null, first = true, stop = null, timer = null;
  const known = new Set(), fresh = new Set();
  const view = { filter: 'open', q: '' };

  async function refresh(silent = true) {
    try {
      const list = await listOrders(rid);
      const added = list.filter(o => !known.has(o.id));
      if (!first && added.length) { added.forEach(o => fresh.add(o.id)); beep(); toast(t('ord.new', { n: added.length }), 'success'); }
      list.forEach(o => known.add(o.id));
      first = false; orders = list;
      ctx.setBadge('orders', orders.filter(o => o.status === 'pending').length);
      ctx.ordersChanged?.(orders);
      if (el) render();
    } catch (error) { if (!silent) toast(friendlyError(error), 'error'); }
  }

  function card(o) {
    const lang = getLang(), next = NEXT[o.status], wa = waLink(o.customer_phone, t('wa.order', { n: o.order_number, restaurant: ctx.restaurant.name }));
    return `<article class="order ${fresh.has(o.id) ? 'new' : ''}" data-id="${esc(o.id)}">
      <header><strong>${esc(t('ord.order'))} #${esc(o.order_number)}</strong>
        <span><span class="pill ${TONE[o.status]}">${esc(t(`status.${o.status}`))}</span> <span class="pill grey">${esc(t(`type.${o.order_type}`))}</span>
        ${o.source === 'whatsapp' ? '<span class="pill ok">WhatsApp</span>' : ''}</span></header>
      <p class="sub">${esc(formatDate(o.created_at, lang, true))} · <strong>${esc(o.customer_name)}</strong> ·
        <a href="tel:${esc(o.customer_phone.replace(/[^0-9+]/g, ''))}">${esc(o.customer_phone)}</a>${wa ? ` · <a href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</p>
      <ul>${(o.order_items || []).map(i => `<li>${esc(i.quantity)} × ${esc(i.product_name)} — ${money(i.line_total_xof, lang)}</li>`).join('')}</ul>
      ${o.delivery_address ? `<p class="sub">📍 ${esc(o.delivery_address)}</p>` : ''}${o.customer_note ? `<p class="sub">📝 ${esc(o.customer_note)}</p>` : ''}
      <div class="foot"><strong>${money(o.total_xof, lang)}</strong>
        <label class="sub">${esc(t('ord.payment'))} <select data-pay="${esc(o.id)}" aria-label="${esc(t('ord.payment'))}">
          ${['unpaid', 'paid', 'refunded'].map(s => `<option value="${s}" ${o.payment_status === s ? 'selected' : ''}>${esc(t(`pay.${s}`))}</option>`).join('')}${o.payment_status === 'pending' ? `<option value="pending" selected>${esc(t('pay.pending'))}</option>` : ''}</select></label>
        <span class="acts">${next ? `<button type="button" class="btn sm" data-next="${esc(o.id)}" data-to="${next}">${esc(t(`act.${next}`))}</button>` : ''}
        ${isOpen(o) ? `<button type="button" class="outline sm" data-cancel="${esc(o.id)}">${esc(t('act.cancelled'))}</button>` : ''}
        <button type="button" class="outline sm" data-msg="${esc(o.id)}">${esc(t('msg.open'))}</button>
        <button type="button" class="outline sm" data-history="${esc(o.id)}">${esc(t('ord.history'))}</button></span></div>
      <ul class="history hidden" id="hist-${esc(o.id)}"></ul></article>`;
  }

  function render() {
    const q = view.q.trim().toLowerCase();
    const items = orders.filter(o => (view.filter === 'all' || (view.filter === 'open' ? isOpen(o) : !isOpen(o)))
      && (!q || `${o.order_number} ${o.customer_name} ${o.customer_phone}`.toLowerCase().includes(q)));
    el.innerHTML = `<section class="panel"><div class="toolbar">
      <input id="oSearch" type="search" placeholder="${esc(t('ord.search'))}" value="${esc(view.q)}" aria-label="${esc(t('ord.search'))}">
      <select id="oFilter" aria-label="${esc(t('ord.filter'))}">${['open', 'done', 'all'].map(f => `<option value="${f}" ${view.filter === f ? 'selected' : ''}>${esc(t(`ord.f.${f}`))}</option>`).join('')}</select>
      <button type="button" class="outline" id="oRefresh">↻ ${esc(t('common.refresh'))}</button></div>
      <div id="oList">${items.map(card).join('') || `<p class="empty">${esc(t('ord.empty'))}</p>`}</div></section>`;
  }

  async function change(id, status) {
    try { await updateOrderStatus(id, status); fresh.delete(id); toast(t('ord.updated'), 'success'); await refresh(false); }
    catch (error) { toast(friendlyError(error), 'error'); await refresh(); }
  }

  function bind() {
    el.addEventListener('input', e => { if (e.target.id === 'oSearch') { view.q = e.target.value; const pos = e.target.selectionStart; render(); const s = el.querySelector('#oSearch'); s.focus(); s.setSelectionRange(pos, pos); } });
    el.addEventListener('change', async e => {
      if (e.target.id === 'oFilter') { view.filter = e.target.value; render(); }
      if (e.target.dataset.pay) {
        try { await updatePaymentStatus(e.target.dataset.pay, e.target.value); toast(t('ord.updated'), 'success'); }
        catch (error) { toast(friendlyError(error), 'error'); await refresh(); }
      }
    });
    el.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'oRefresh') return refresh(false);
      if (b.dataset.msg) return ctx.openConversation(b.dataset.msg);
      if (b.dataset.next) return change(b.dataset.next, b.dataset.to);
      if (b.dataset.cancel && await confirmDialog(esc(t('ord.confirmCancel')), t('act.cancelled'), t('common.back'))) return change(b.dataset.cancel, 'cancelled');
      if (b.dataset.history) {
        const box = el.querySelector(`#hist-${CSS.escape(b.dataset.history)}`);
        if (!box.classList.contains('hidden')) return box.classList.add('hidden');
        try {
          const events = await listOrderEvents(b.dataset.history);
          box.innerHTML = events.map(ev => `<li>${esc(formatDate(ev.created_at, getLang(), true))} — ${esc(ev.event_type === 'created' ? t('ord.ev.created') : ev.event_type === 'status_changed' ? t('ord.ev.status', { to: t(`status.${ev.details?.to}`) }) : t('ord.ev.payment', { to: t(`pay.${ev.details?.to}`) }))}</li>`).join('') || `<li>${esc(t('ord.noHistory'))}</li>`;
          box.classList.remove('hidden');
        } catch (error) { toast(friendlyError(error), 'error'); }
      }
    });
  }

  return {
    mount(target) { const rebind = el !== target; el = target; if (rebind) bind(); render(); },
    refresh,
    list: () => orders,
    start() {
      const first = refresh(); // promesse de la première lecture (attendue par le tableau de bord)
      stop = subscribeOrders(rid, () => refresh());
      timer = setInterval(() => { if (!document.hidden) refresh(); }, 30000); // filet de sécurité si Realtime est indisponible
      return first;
    },
    destroy() { stop?.(); clearInterval(timer); }
  };
}
