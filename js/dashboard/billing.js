import { esc, money, formatDate, withBusy, toast } from '../core/utils.js';
import { t, getLang } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { openModal } from '../core/modal.js';
import { config } from '../core/supabase.js';
import { getBilling, listPlans, listPayments, requestSubscription, startOnlinePayment, verifyOnlinePayment } from '../services/billing.service.js';

const METHODS = ['tmoney', 'flooz', 'bank_transfer', 'cash', 'other']; // moyens du paiement manuel (fedapay est géré à part)
const TONE = { pending: 'warn', approved: 'ok', rejected: 'bad' };
const FEATURES = ['qr_code', 'whatsapp_orders', 'basic_stats', 'customization', 'priority_support'];

export async function mountBilling(ctx, el) {
  const rid = ctx.restaurant.id;
  let billing, plans, payments;

  const bar = (n, max) => (max == null ? '' : `<div class="bar"><i class="${n >= max ? 'full' : ''}" style="width:${Math.min(100, Math.round(n / max * 100))}%"></i></div>`);

  async function load() {
    [billing, plans, payments] = await Promise.all([getBilling(rid), listPlans(), listPayments(rid)]);
    render();
  }

  // Retour depuis FedaPay (?payment=<id>) : le serveur relit la transaction, le navigateur ne prouve rien.
  async function checkReturn() {
    const url = new URL(location.href), id = url.searchParams.get('payment');
    if (!id) return;
    url.searchParams.delete('payment'); url.searchParams.delete('status'); url.searchParams.delete('id');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    try {
      const { status } = await verifyOnlinePayment(id);
      toast(t(`bill.online.${status === 'approved' ? 'ok' : status === 'rejected' ? 'failed' : 'wait'}`), status === 'approved' ? 'success' : 'info');
      await load();
    } catch (error) { toast(friendlyError(error), 'error'); }
  }

  // Les paiements en ligne enregistrent un code (online_*) que l'on traduit ici.
  const noteText = n => (n.startsWith('online_') ? t(`note.${n}`) : n);
  const onlineEnabled = () => config.onlinePayment === true;
  const pendingManual = () => payments.some(p => p.status === 'pending' && p.method !== 'fedapay');
  const pendingOnline = () => payments.some(p => p.status === 'pending' && p.method === 'fedapay');

  function paymentInfo() {
    // Les coordonnées de paiement viennent de config.js (paymentInfo) — jamais codées en dur ici.
    const info = config.paymentInfo || {};
    const lines = METHODS.filter(m => info[m]).map(m => `<li><b>${esc(t(`method.${m}`))}</b> : ${esc(info[m])}</li>`);
    return lines.length ? `<ul>${lines.join('')}</ul>` : `<p class="muted">${esc(t('bill.contactForDetails'))}</p>`;
  }

  function render() {
    const lang = getLang();
    const active = billing.state === 'active';
    el.innerHTML = `<section class="panel"><h2>${esc(t('bill.current'))}</h2>
      <p><span class="pill ${active ? 'ok' : 'warn'}">${esc(t(active ? 'bill.active' : 'bill.trial'))}</span> <strong>${esc(billing.plan_name)}</strong>
      ${active ? ` — ${esc(t('bill.until', { date: formatDate(billing.ends_at, lang), days: billing.days_left }))}` : ` — ${esc(t('bill.trialNote'))}`}</p>
      <p class="muted">${esc(t('ov.products'))} : ${billing.products}${billing.max_products != null ? ` / ${billing.max_products}` : ''}</p>${bar(billing.products, billing.max_products)}
      <p class="muted">${esc(t('ov.categories'))} : ${billing.categories}${billing.max_categories != null ? ` / ${billing.max_categories}` : ''}</p>${bar(billing.categories, billing.max_categories)}
      ${pendingManual() ? `<div class="banner">${esc(t('bill.pendingBanner'))}</div>` : ''}
      ${pendingOnline() ? `<div class="banner">${esc(t('bill.online.pendingBanner'))}</div>` : ''}</section>
      <section class="panel"><h2>${esc(t('bill.plans'))}</h2><div class="plan-pick">${plans.map(p => {
        const current = active && p.code === billing.plan_code;
        const feats = FEATURES.filter(k => p.features?.[k]).map(k => `<li>${esc(t(`feat.${k}`))}</li>`).join('');
        return `<article class="${current ? 'current' : ''}"><h3>${esc(p.name)}</h3><strong>${money(p.price_xof, lang)} <small>${esc(t('plans.perMonth'))}</small></strong>
          <ul><li>${esc(p.max_products == null ? t('plans.unlimitedProducts') : t('plans.upToProducts', { n: p.max_products }))}</li>
          <li>${esc(p.max_categories == null ? t('plans.unlimitedCategories') : t('plans.upToCategories', { n: p.max_categories }))}</li>${feats}</ul>
          ${onlineEnabled() ? `<button type="button" class="btn" data-online="${esc(p.code)}">${esc(t('bill.online.pay'))}</button>` : ''}
          <button type="button" class="btn ${onlineEnabled() ? 'secondary' : ''}" data-plan="${esc(p.code)}" ${pendingManual() ? 'disabled' : ''}>${esc(t(onlineEnabled() ? 'bill.manual' : current ? 'bill.renew' : 'bill.choose'))}</button></article>`;
      }).join('')}</div></section>
      <section class="panel"><h2>${esc(t('bill.history'))}</h2>${payments.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>${esc(t('bill.date'))}</th><th>${esc(t('bill.plan'))}</th><th>${esc(t('bill.amount'))}</th><th>${esc(t('bill.method'))}</th><th>${esc(t('bill.status'))}</th></tr></thead><tbody>
        ${payments.map(p => `<tr><td>${esc(formatDate(p.created_at, lang))}</td><td>${esc(p.subscriptions?.plans?.name || '—')}</td><td>${money(p.amount_xof, lang)}</td><td>${esc(t(`method.${p.method}`))}</td>
        <td><span class="pill ${TONE[p.status]}">${esc(t(`pstatus.${p.status}`))}</span>${p.admin_note ? `<br><small>${esc(noteText(p.admin_note))}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="empty">${esc(t('bill.noPayments'))}</p>`}</section>`;
  }

  function requestModal(plan) {
    openModal(`<h2>${esc(t('bill.requestTitle', { plan: plan.name }))}</h2>
      <p><strong>${money(plan.price_xof, getLang())}</strong> ${esc(t('plans.perMonth'))}</p>
      <h3>${esc(t('bill.howToPay'))}</h3>${paymentInfo()}
      <form id="reqForm" class="stack" novalidate>
        <label class="field">${esc(t('bill.method'))}<select id="rqMethod">${METHODS.map(m => `<option value="${m}">${esc(t(`method.${m}`))}</option>`).join('')}</select></label>
        <label class="field">${esc(t('bill.reference'))}<input id="rqRef" maxlength="100" autocomplete="off"></label>
        <label class="field">${esc(t('bill.proof'))}<input id="rqFile" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"><small>${esc(t('bill.proofHint'))}</small></label>
        <button class="btn lg" type="submit">${esc(t('bill.submit'))}</button><p id="rqMsg" class="notice" role="alert"></p></form>`, {
      onMount: (wrap, close) => wrap.querySelector('#reqForm').addEventListener('submit', async e => {
        e.preventDefault();
        const q = id => wrap.querySelector('#' + id);
        const file = q('rqFile').files[0], reference = q('rqRef').value.trim();
        if (!file && !reference) return void (q('rqMsg').textContent = t('err.proofRequired'));
        await withBusy(e.submitter, async () => {
          try {
            await requestSubscription({ restaurantId: rid, planCode: plan.code, method: q('rqMethod').value, reference, file });
            toast(t('bill.sent'), 'success'); close(); await load();
          } catch (error) { q('rqMsg').textContent = friendlyError(error); }
        });
      })
    });
  }

  el.addEventListener('click', async e => {
    const online = e.target.closest('[data-online]');
    if (online) {
      return void withBusy(online, async () => {
        try {
          const { url } = await startOnlinePayment(rid, online.dataset.online);
          location.assign(url); // paiement hébergé par FedaPay : aucune donnée de carte ou mobile money ne transite par SipokMenu
        } catch (error) { toast(friendlyError(error), 'error'); await load(); }
      });
    }
    const b = e.target.closest('[data-plan]');
    if (b) requestModal(plans.find(p => p.code === b.dataset.plan));
  });

  try { await load(); await checkReturn(); } catch (error) { el.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; }
}
