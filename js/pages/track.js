import { $, esc, money, waLink, toast } from '../core/utils.js';
import { t, getLang, applyI18n, initLangToggle } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { verifyOrderPayment, startOrderPayment } from '../services/payments.service.js';
import { recallTrack } from '../core/track-token.js';
import { trackOrder, customerMessages, customerSend, subscribeChat } from '../services/messages.service.js';

// Le jeton est dans le fragment (#...) : il n'est jamais envoyé au serveur dans l'URL ni dans les en-têtes Referer.
const query = new URLSearchParams(location.search);
// Au retour du paiement FedaPay, le fragment est perdu : on reprend le jeton gardé sur cet appareil.
const token = (location.hash.slice(1) || query.get('t') || (query.get('paid') ? recallTrack() : '')).trim().toLowerCase();
const STEPS = ['pending', 'confirmed', 'preparing', 'ready', 'completed'];
let data = null, messages = [], stop = null, lastCount = -1;

const time = iso => new Intl.DateTimeFormat(getLang(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(iso));

function fail(text) { $('loading').classList.add('hidden'); $('track').classList.add('hidden'); $('error').textContent = text; $('error').classList.remove('hidden'); }

function renderOrder() {
  const o = data.order, lang = getLang();
  document.title = `${t('trk.order', { n: o.number })} — ${data.restaurant.name}`;
  $('trRestaurant').textContent = data.restaurant.name;
  $('trTitle').textContent = t('trk.order', { n: o.number });
  const st = $('trStatus'); st.textContent = t(`trk.s.${o.status}`);
  st.className = `pill ${o.status === 'cancelled' ? 'bad' : o.status === 'completed' ? 'grey' : o.status === 'ready' ? 'ok' : 'warn'}`;
  const reached = new Set((o.timeline || []).map(e => e.status)); reached.add('pending');
  $('trSteps').innerHTML = o.status === 'cancelled' ? `<li class="done">${esc(t('trk.s.cancelled'))}</li>`
    : STEPS.map(s => `<li class="${reached.has(s) ? 'done' : ''} ${s === o.status ? 'now' : ''}">${esc(t(`trk.s.${s}`))}</li>`).join('');
  $('trItems').innerHTML = o.items.map(i => `<li><span>${esc(i.quantity)} × ${esc(i.name)}</span><b>${money(i.line_total_xof, lang)}</b></li>`).join('');
  $('trTotal').textContent = `${t('trk.total')} : ${money(o.total_xof, lang)}`;
  const wa = waLink(data.restaurant.whatsapp || data.restaurant.phone, t('trk.wa', { n: o.number }));
  $('trWa').innerHTML = wa ? `<a class="btn wa" href="${esc(wa)}" target="_blank" rel="noopener">💬 ${esc(t('trk.whatsapp'))}</a>` : '';
  const paid = o.payment_status === 'paid';
  $('trPay').innerHTML = `<span class="pill ${paid ? 'ok' : 'warn'}">${esc(t(`pay.${o.payment_status || 'unpaid'}`))}</span>`
    + (data.can_pay_online ? ` <button type="button" class="btn" id="payNow">${esc(t('trk.payNow'))}</button> <small class="muted">${esc(t('trk.payHint'))}</small>` : '');
  $('chatForm').classList.toggle('hidden', !data.can_message);
  $('chatClosed').classList.toggle('hidden', data.can_message);
}

function renderChat() {
  const log = $('chatLog');
  log.innerHTML = messages.map(m => `<div class="bubble ${m.sender_type === 'customer' ? 'me' : 'them'}"><p>${esc(m.content)}</p>
    <small>${esc(time(m.created_at))}${m.sender_type === 'customer' ? ` · ${esc(t(m.read_at ? 'trk.read' : 'trk.sent'))}` : ''}</small></div>`).join('')
    || `<p class="empty">${esc(t('trk.noMessages'))}</p>`;
  if (messages.length !== lastCount) { log.scrollTop = log.scrollHeight; lastCount = messages.length; }
}

async function refresh({ order = true } = {}) {
  try {
    const [d, m] = await Promise.all([order ? trackOrder(token) : Promise.resolve(data), customerMessages(token, !document.hidden)]);
    data = d; messages = m; renderOrder(); renderChat(); $('chatOffline').classList.add('hidden');
  } catch (error) {
    if (!data) return fail(friendlyError(error));
    $('chatOffline').classList.remove('hidden');
  }
}

async function pay(button) {
  button.disabled = true;
  try { const { url } = await startOrderPayment(token); location.assign(url); }
  catch (error) { toast(friendlyError(error), 'error'); button.disabled = false; }
}

// Retour de FedaPay : le serveur relit l'état auprès de FedaPay (on ne fait pas confiance à l'URL).
async function checkReturn() {
  if (!query.get('paid')) return;
  toast(t('trk.payChecking'));
  try {
    const r = await verifyOrderPayment(token);
    await refresh({ order: true });
    toast(t(r.status === 'approved' || data?.order.payment_status === 'paid' ? 'trk.payOk' : r.status === 'pending' ? 'trk.payWait' : 'trk.payFail'), data?.order.payment_status === 'paid' ? 'success' : undefined);
  } catch (error) { toast(friendlyError(error), 'error'); }
  history.replaceState(null, '', `/suivi#${token}`);
}

async function send(event) {
  event.preventDefault();
  const area = $('chatText'), msg = $('chatMsg'), content = area.value.trim();
  msg.textContent = '';
  if (!content) return;
  const btn = event.submitter; btn.disabled = true;
  try { await customerSend(token, content); area.value = ''; await refresh({ order: false }); }
  catch (error) { msg.textContent = friendlyError(error); }
  finally { btn.disabled = false; }
}

async function init() {
  initLangToggle(() => { if (data) { renderOrder(); renderChat(); } });
  if (!/^[0-9a-f]{32,128}$/.test(token)) return fail(t('trk.noToken'));
  await refresh();
  if (!data) return;
  $('loading').classList.add('hidden'); $('track').classList.remove('hidden'); applyI18n();
  $('chatForm').addEventListener('submit', send);
  $('trPay').addEventListener('click', e => { const b = e.target.closest('#payNow'); if (b) pay(b); });
  checkReturn();
  $('chatText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('chatForm').requestSubmit(); });
  // Temps réel : ping de diffusion (sans contenu) puis relecture sécurisée ; sondage de secours si la connexion tombe.
  stop = subscribeChat(data.channel, () => refresh(), status => { if (status === 'SUBSCRIBED') $('chatOffline').classList.add('hidden'); });
  setInterval(() => { if (!document.hidden) refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => stop?.());
}
init();
