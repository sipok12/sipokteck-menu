import { esc, money, formatDate, toast, waLink, copyText } from '../core/utils.js';
import { t, getLang } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { searchOrders, getHistoryStats, listOrderEvents } from '../services/orders.service.js';
import { getStats } from '../services/billing.service.js';
import { reissueTracking } from '../services/messages.service.js';
import { drawSalesChart } from './sales-chart.js';

const PAGE = 30;
const TONE = { pending: 'warn', confirmed: '', preparing: '', ready: 'ok', completed: 'grey', cancelled: 'bad' };
const STATUS_FILTERS = ['all', 'open', 'pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStart = value => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (date, n) => { const x = new Date(date); x.setDate(x.getDate() + n); return x; };

/** Historique en lecture seule : aucune action de changement de statut n'est proposée ici. */
export function mountHistory(ctx, el) {
  const rid = ctx.restaurant.id;
  const today = ymd(new Date());
  const view = { from: today, to: today, status: 'all', q: '', rows: [], total: 0, days: 7 };
  let chart = null, seq = 0;

  const range = () => ({ from: dayStart(view.from).toISOString(), to: addDays(dayStart(view.to), 1).toISOString() });

  el.innerHTML = `<section class="panel"><h2>${esc(t('hist.title'))}</h2>
    <div class="range" id="hQuick" role="group" aria-label="${esc(t('hist.period'))}">
      ${['today', 'yesterday', 'd7', 'd30'].map(k => `<button type="button" class="outline sm" data-quick="${k}">${esc(t(`hist.q.${k}`))}</button>`).join('')}</div>
    <div class="toolbar">
      <label class="sub">${esc(t('hist.from'))} <input id="hFrom" type="date" value="${today}" max="${today}"></label>
      <label class="sub">${esc(t('hist.to'))} <input id="hTo" type="date" value="${today}" max="${today}"></label>
      <select id="hStatus" aria-label="${esc(t('ord.filter'))}">${STATUS_FILTERS.map(s => `<option value="${s}">${esc(t(`hist.s.${s}`))}</option>`).join('')}</select>
      <input id="hSearch" type="search" placeholder="${esc(t('ord.search'))}" aria-label="${esc(t('ord.search'))}" maxlength="60"></div>
    <div id="hStats" class="cards"></div>
    <div id="hList"><p class="loading">${esc(t('common.loading'))}</p></div>
    <p class="btn-row"><button type="button" class="outline hidden" id="hMore">${esc(t('hist.more'))}</button></p></section>
  <section class="panel"><h2>${esc(t('hist.evolution'))}</h2><div id="hChart"></div></section>`;

  const $ = id => el.querySelector(`#${id}`);

  function renderStats(s) {
    const lang = getLang();
    $('hStats').innerHTML = [['hist.k.orders', s.total], ['hist.k.revenue', money(s.revenue, lang)], ['hist.k.completed', s.completed],
      ['hist.k.cancelled', s.cancelled], ['hist.k.inProgress', s.in_progress]]
      .map(([k, v]) => `<div class="stat"><span>${esc(t(k))}</span><strong>${esc(v)}</strong></div>`).join('');
  }

  function renderList() {
    const lang = getLang();
    $('hList').innerHTML = view.rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr>
      <th>${esc(t('bill.date'))}</th><th>${esc(t('hist.number'))}</th><th>${esc(t('hist.customer'))}</th><th>${esc(t('bill.amount'))}</th><th>${esc(t('bill.status'))}</th><th></th></tr></thead><tbody>
      ${view.rows.map(o => `<tr><td>${esc(formatDate(o.created_at, lang, true))}</td><td>#${esc(o.order_number)}</td>
        <td>${esc(o.customer_name)}<br><small class="muted">${esc(o.customer_phone)}</small></td><td>${money(o.total_xof, lang)}</td>
        <td><span class="pill ${TONE[o.status]}">${esc(t(`status.${o.status}`))}</span></td>
        <td><button type="button" class="outline sm" data-detail="${esc(o.id)}">${esc(t('hist.details'))}</button></td></tr>`).join('')}</tbody></table></div>
      <p class="muted">${esc(t('hist.shown', { n: view.rows.length, total: view.total }))}</p>`
      : `<p class="empty">${esc(t('hist.empty'))}</p>`;
    $('hMore').classList.toggle('hidden', view.rows.length >= view.total);
  }

  async function load(append = false) {
    const my = ++seq, { from, to } = range();
    if (!append) $('hList').innerHTML = `<p class="loading">${esc(t('common.loading'))}</p>`;
    try {
      const [page, stats] = await Promise.all([
        searchOrders(rid, { from, to, status: view.status, q: view.q, offset: append ? view.rows.length : 0, limit: PAGE }),
        append ? null : getHistoryStats(rid, from, to)]);
      if (my !== seq) return; // une recherche plus récente a pris le relais
      view.rows = append ? [...view.rows, ...page.rows] : page.rows; view.total = page.total;
      if (stats) renderStats(stats);
      renderList();
    } catch (error) { if (my === seq) $('hList').innerHTML = `<p class="notice" role="alert">${esc(friendlyError(error))}</p>`; }
  }

  async function drawEvolution() {
    const box = $('hChart');
    try {
      const s = await getStats(rid, view.days);
      if (s.locked) {
        box.innerHTML = `<div class="locked"><p>🔒 ${esc(t('ov.locked'))}</p>${ctx.canManage ? `<button type="button" class="btn" id="hUpgrade">${esc(t('ov.upgrade'))}</button>` : ''}</div>`;
        box.querySelector('#hUpgrade')?.addEventListener('click', () => ctx.go('billing'));
        return;
      }
      box.innerHTML = `<div class="range" role="group" aria-label="${esc(t('ov.range'))}">${[7, 30].map(d => `<button type="button" class="outline sm" data-days="${d}" aria-pressed="${d === view.days}">${esc(t('ov.days', { n: d }))}</button>`).join('')}</div>
        <div class="chart-box"><canvas id="hCanvas" role="img" aria-label="${esc(t('ov.chartLabel'))}"></canvas></div>`;
      box.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => { view.days = Number(b.dataset.days); drawEvolution(); }));
      chart?.destroy();
      chart = await drawSalesChart(box.querySelector('#hCanvas'), s.daily);
      if (!chart) box.querySelector('.chart-box').innerHTML = `<p class="muted">${esc(t('ov.chartUnavailable'))}</p>`;
    } catch (error) { box.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; }
  }

  async function showDetail(id) {
    const o = view.rows.find(r => r.id === id); if (!o) return;
    const lang = getLang();
    let events = [];
    try { events = await listOrderEvents(id); } catch { /* le détail reste lisible sans la chronologie */ }
    const wa = waLink(o.customer_phone, t('wa.order', { n: o.order_number, restaurant: ctx.restaurant.name }));
    openModal(`<h2>${esc(t('ord.order'))} #${esc(o.order_number)} <span class="pill ${TONE[o.status]}">${esc(t(`status.${o.status}`))}</span></h2>
      <p class="sub">${esc(formatDate(o.created_at, lang, true))} · ${esc(t(`type.${o.order_type}`))} · ${esc(t(`pay.${o.payment_status}`))}</p>
      <p><strong>${esc(o.customer_name)}</strong> · <a href="tel:${esc(o.customer_phone.replace(/[^0-9+]/g, ''))}">${esc(o.customer_phone)}</a></p>
      <ul>${(o.order_items || []).map(i => `<li>${esc(i.quantity)} × ${esc(i.product_name)} — ${money(i.line_total_xof, lang)}</li>`).join('')}</ul>
      ${o.delivery_address ? `<p class="sub">📍 ${esc(o.delivery_address)}</p>` : ''}${o.customer_note ? `<p class="sub">📝 ${esc(o.customer_note)}</p>` : ''}
      <p><strong>${esc(t('hist.total'))} : ${money(o.total_xof, lang)}</strong></p>
      <h3>${esc(t('ord.history'))}</h3><ul class="history">${events.map(ev => `<li>${esc(formatDate(ev.created_at, lang, true))} — ${esc(ev.event_type === 'created' ? t('ord.ev.created') : ev.event_type === 'status_changed' ? t('ord.ev.status', { to: t(`status.${ev.details?.to}`) }) : t('ord.ev.payment', { to: t(`pay.${ev.details?.to}`) }))}</li>`).join('') || `<li>${esc(t('ord.noHistory'))}</li>`}</ul>
      <div class="btn-row"><button type="button" class="btn" data-msg>${esc(t('msg.open'))}</button>
        ${wa ? `<a class="btn wa" href="${esc(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
        <button type="button" class="outline" data-link>${esc(t('hist.trackLink'))}</button></div>`, {
      onMount: (wrap, close) => {
        wrap.querySelector('[data-msg]').onclick = () => { close(); ctx.openConversation(id); };
        wrap.querySelector('[data-link]').onclick = async () => {
          if (!await confirmDialog(esc(t('hist.trackConfirm')), t('hist.trackCreate'), t('common.cancel'))) return;
          try { const token = await reissueTracking(id); await copyText(`${location.origin}/suivi#${token}`); toast(t('hist.trackCopied'), 'success'); }
          catch (error) { toast(friendlyError(error), 'error'); }
        };
      }
    });
  }

  const apply = () => { view.from = $('hFrom').value || today; view.to = $('hTo').value || today; if (view.to < view.from) view.to = view.from; $('hTo').value = view.to; load(); };
  $('hQuick').addEventListener('click', e => {
    const k = e.target.closest('[data-quick]')?.dataset.quick; if (!k) return;
    const now = new Date(), span = { today: [0, 0], yesterday: [1, 1], d7: [6, 0], d30: [29, 0] }[k];
    $('hFrom').value = ymd(addDays(now, -span[0])); $('hTo').value = ymd(addDays(now, -span[1])); apply();
  });
  $('hFrom').addEventListener('change', apply); $('hTo').addEventListener('change', apply);
  $('hStatus').addEventListener('change', e => { view.status = e.target.value; load(); });
  let timer; $('hSearch').addEventListener('input', e => { clearTimeout(timer); timer = setTimeout(() => { view.q = e.target.value; load(); }, 300); });
  $('hMore').addEventListener('click', () => load(true));
  el.addEventListener('click', e => { const b = e.target.closest('[data-detail]'); if (b) showDetail(b.dataset.detail); });

  load(); drawEvolution();
}
