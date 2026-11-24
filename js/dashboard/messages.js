import { esc, formatDate, toast, waLink } from '../core/utils.js';
import { t, getLang } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { listConversations, listMessages, sendMessage, markRead, getOrderBrief, subscribeMessages } from '../services/messages.service.js';

const QUICK = ['confirmed', 'preparing', 'ready', 'delivery', 'clarify', 'cancelled'];
const time = (iso, lang) => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function ping() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination); osc.frequency.value = 660; gain.gain.setValueAtTime(0.12, ac.currentTime);
    osc.start(); osc.stop(ac.currentTime + 0.12);
  } catch { /* son indisponible */ }
}

/** Messagerie restaurant : démarre avec le tableau de bord (pastille de messages non lus + temps réel). */
export function createMessages(ctx) {
  const rid = ctx.restaurant.id;
  let el = null, convs = [], current = null, thread = [], stop = null, timer = null, online = true, first = true;
  const lastSeen = new Map(); // order_id -> dernier message client déjà signalé

  const unreadTotal = () => convs.reduce((n, c) => n + Number(c.unread || 0), 0);

  async function refreshList() {
    try {
      const list = await listConversations(rid);
      const fresh = list.filter(c => c.last_sender === 'customer' && Number(c.unread) > 0 && lastSeen.get(c.order_id) !== c.last_at && c.order_id !== current?.order_id);
      if (!first && fresh.length) { ping(); toast(t('msg.new', { n: fresh.length }), 'success'); }
      list.forEach(c => lastSeen.set(c.order_id, c.last_at));
      first = false; convs = list;
      ctx.setBadge('messages', unreadTotal());
      if (el) renderList();
    } catch (error) { if (el && !first) toast(friendlyError(error), 'error'); }
  }

  async function refreshThread() {
    if (!current) return;
    try {
      thread = await listMessages(current.order_id);
      renderThread();
      if (thread.some(m => m.sender_type === 'customer' && !m.read_at) && !document.hidden) { await markRead(current.order_id); await refreshList(); }
    } catch (error) { toast(friendlyError(error), 'error'); }
  }

  function renderList() {
    const box = el.querySelector('#mList'); if (!box) return;
    const lang = getLang();
    box.innerHTML = convs.map(c => `<button type="button" class="conv ${current?.order_id === c.order_id ? 'on' : ''}" data-conv="${esc(c.order_id)}">
      <span class="conv-top"><strong>#${esc(c.order_number)} · ${esc(c.customer_name)}</strong><small>${esc(formatDate(c.last_at, lang, true))}</small></span>
      <span class="conv-last">${c.last_sender === 'restaurant' ? `${esc(t('msg.you'))} : ` : ''}${esc(c.last_content)}</span>
      ${Number(c.unread) > 0 ? `<span class="dot" aria-label="${esc(t('msg.unread', { n: c.unread }))}">${esc(c.unread)}</span>` : ''}</button>`).join('')
      || `<p class="empty">${esc(t('msg.emptyList'))}</p>`;
  }

  function renderThread() {
    const box = el.querySelector('#mThread'); if (!box) return;
    el.querySelector('.chat-layout')?.classList.toggle('has-current', !!current); // mobile : liste OU discussion
    if (!current) { box.innerHTML = `<p class="empty">${esc(t('msg.pick'))}</p>`; box.classList.remove('open'); return; }
    const lang = getLang(), wa = waLink(current.customer_phone, t('wa.order', { n: current.order_number, restaurant: ctx.restaurant.name }));
    box.classList.add('open');
    box.innerHTML = `<header class="chat-head"><button type="button" class="outline sm back" id="mBack" aria-label="${esc(t('common.back'))}">←</button>
        <div><strong>#${esc(current.order_number)} · ${esc(current.customer_name)}</strong><small class="muted">${esc(current.customer_phone)}</small></div>
        ${wa ? `<a class="btn wa sm" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}</header>
      ${online ? '' : `<p class="notice" role="status">${esc(t('msg.offline'))}</p>`}
      <div class="chat-log" id="mLog" aria-live="polite">${thread.map(m => `<div class="bubble ${m.sender_type === 'restaurant' ? 'me' : 'them'}">
        <p>${esc(m.content)}</p><small>${esc(time(m.created_at, lang))}${m.sender_type === 'restaurant' ? ` · ${esc(t(m.read_at ? 'msg.read' : 'msg.sent'))}` : ''}</small></div>`).join('')
        || `<p class="empty">${esc(t('msg.noMessages'))}</p>`}</div>
      <div class="quick" role="group" aria-label="${esc(t('msg.quick'))}">${QUICK.map(k => `<button type="button" class="outline sm" data-quick="${k}">${esc(t(`msg.qs.${k}`))}</button>`).join('')}</div>
      <form id="mForm" class="chat-form"><textarea id="mText" rows="2" maxlength="1000" placeholder="${esc(t('msg.placeholder'))}" aria-label="${esc(t('msg.placeholder'))}"></textarea>
        <button class="btn" type="submit">${esc(t('msg.send'))}</button></form>`;
    const log = box.querySelector('#mLog'); log.scrollTop = log.scrollHeight;
  }

  async function open(orderId) {
    const known = convs.find(c => c.order_id === orderId);
    try {
      const brief = known || await getOrderBrief(orderId);
      if (!brief) throw new Error('Access denied');
      current = { order_id: orderId, order_number: brief.order_number, customer_name: brief.customer_name, customer_phone: brief.customer_phone };
      thread = []; if (el) { renderList(); renderThread(); }
      await refreshThread();
    } catch (error) { toast(friendlyError(error), 'error'); }
  }

  async function send(text) {
    const content = text.trim(); if (!content || !current) return;
    try { await sendMessage(current.order_id, content); await Promise.all([refreshThread(), refreshList()]); }
    catch (error) { toast(friendlyError(error), 'error'); }
  }

  function bind() {
    el.addEventListener('click', e => {
      const c = e.target.closest('[data-conv]'); if (c) return void open(c.dataset.conv);
      const q = e.target.closest('[data-quick]'); if (q) { el.querySelector('#mText').value = t(`msg.q.${q.dataset.quick}`); el.querySelector('#mText').focus(); return; }
      if (e.target.closest('#mBack')) { current = null; renderList(); renderThread(); }
    });
    el.addEventListener('submit', async e => {
      e.preventDefault();
      const area = el.querySelector('#mText'), btn = e.submitter, value = area.value;
      if (!value.trim()) return;
      btn.disabled = true; await send(value); btn.disabled = false; // succès : le fil est redessiné (zone vide) ; échec : le texte est conservé
    });
    el.addEventListener('keydown', e => { if (e.target.id === 'mText' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) el.querySelector('#mForm').requestSubmit(); });
  }

  return {
    mount(target) {
      const rebind = el !== target; el = target;
      el.innerHTML = `<section class="panel chat-layout ${current ? 'has-current' : ''}"><div class="conv-list" id="mList" aria-label="${esc(t('msg.conversations'))}"></div><div class="chat-pane" id="mThread"></div></section>`;
      if (rebind) bind();
      renderList(); renderThread(); refreshList(); if (current) refreshThread();
    },
    open,
    start() {
      const firstLoad = refreshList();
      stop = subscribeMessages(rid, () => { refreshList(); if (current) refreshThread(); }, status => {
        const ok = status === 'SUBSCRIBED';
        if (ok !== online) { online = ok; if (el && current) renderThread(); }
      });
      window.addEventListener('online', () => refreshList());
      timer = setInterval(() => { if (!document.hidden) { refreshList(); if (current) refreshThread(); } }, 20000); // filet de sécurité hors Realtime
      return firstLoad;
    },
    destroy() { stop?.(); clearInterval(timer); }
  };
}
