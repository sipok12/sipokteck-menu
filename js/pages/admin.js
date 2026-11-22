import { $, esc, money, formatDate, withBusy, toast } from '../core/utils.js';
import { setLang } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { requireSession, getProfile, bindLogout } from '../core/auth.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { signedProofUrl } from '../services/storage.service.js';
import * as api from '../services/admin.service.js';

setLang('fr', false); // console interne : français uniquement, sans modifier la préférence de l'utilisateur
bindLogout();

const TABS = [['overview', "Vue d'ensemble"], ['restaurants', 'Restaurants'], ['payments', 'Paiements'], ['plans', 'Offres'], ['subscriptions', 'Abonnements'], ['audit', 'Journal']];
const R_STATUS = { pending: ['En attente', 'warn'], active: ['Actif', 'ok'], suspended: ['Suspendu', 'bad'] };
const P_STATUS = { pending: ['À valider', 'warn'], approved: ['Approuvé', 'ok'], rejected: ['Refusé', 'bad'] };
const S_STATUS = { pending: 'En attente', active: 'Actif', past_due: 'Impayé', cancelled: 'Annulé', expired: 'Expiré' };
const METHOD = { tmoney: 'T-Money', flooz: 'Flooz', bank_transfer: 'Virement', cash: 'Espèces', other: 'Autre' };
const ACTION = { restaurant_created: 'Restaurant créé', restaurant_status_changed: 'Statut restaurant modifié', payment_submitted: 'Paiement soumis',
  payment_reviewed: 'Paiement traité', subscription_status_changed: 'Abonnement modifié', plan_updated: 'Offre modifiée' };
const pill = (map, key) => `<span class="pill ${map[key]?.[1] || 'grey'}">${esc(map[key]?.[0] || key)}</span>`;
const state = { tab: 'overview', rFilter: 'all', rQuery: '', pFilter: 'pending' };

async function view(tab) {
  const el = $('panel');
  el.innerHTML = '<p class="loading">Chargement…</p>';
  try { el.innerHTML = await VIEWS[tab](); } catch (error) { el.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; }
}

const VIEWS = {
  async overview() {
    const o = await api.overview();
    const c = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
    return `<div class="cards">${c('Restaurants', o.restaurants.total)}${c('À valider', o.restaurants.pending)}${c('Actifs', o.restaurants.active)}${c('Suspendus', o.restaurants.suspended)}
      ${c('Abonnements actifs', o.active_subscriptions)}${c('Revenu mensuel récurrent', money(o.monthly_recurring_xof))}${c('Paiements à valider', o.pending_payments)}
      ${c('Encaissé (30 j)', money(o.approved_30d_xof))}${c('Commandes (30 j)', o.orders_30d)}</div>`;
  },
  async restaurants() {
    const q = state.rQuery.toLowerCase();
    const list = (await api.listRestaurants()).filter(r => (state.rFilter === 'all' || r.status === state.rFilter) && (!q || `${r.name} ${r.slug} ${r.city || ''} ${r.phone || ''}`.toLowerCase().includes(q)));
    return `<div class="toolbar"><input id="rQuery" type="search" placeholder="Rechercher…" value="${esc(state.rQuery)}">
      <select id="rFilter">${[['all', 'Tous'], ['pending', 'En attente'], ['active', 'Actifs'], ['suspended', 'Suspendus']].map(([v, l]) => `<option value="${v}" ${state.rFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Nom</th><th>Ville</th><th>Contact</th><th>Statut</th><th>Créé le</th><th></th></tr></thead><tbody>
      ${list.map(r => `<tr><td><strong>${esc(r.name)}</strong><br><small><a href="/menu?slug=${encodeURIComponent(r.slug)}" target="_blank" rel="noopener">${esc(r.slug)}</a></small></td>
        <td>${esc(r.city || '—')}</td><td>${esc(r.phone || r.whatsapp || '—')}</td><td>${pill(R_STATUS, r.status)}</td><td>${esc(formatDate(r.created_at, 'fr'))}</td>
        <td class="actions">${r.status !== 'active' ? `<button type="button" class="btn sm" data-rs="${esc(r.id)}" data-to="active">${r.status === 'pending' ? 'Valider' : 'Réactiver'}</button>` : ''}
        ${r.status !== 'suspended' ? `<button type="button" class="btn sm danger" data-rs="${esc(r.id)}" data-to="suspended" data-name="${esc(r.name)}">Suspendre</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Aucun restaurant.</td></tr>'}</tbody></table></div>`;
  },
  async payments() {
    const list = await api.listPayments(state.pFilter === 'all' ? null : state.pFilter);
    return `<div class="toolbar"><select id="pFilter">${[['pending', 'À valider'], ['approved', 'Approuvés'], ['rejected', 'Refusés'], ['all', 'Tous']].map(([v, l]) => `<option value="${v}" ${state.pFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Restaurant</th><th>Offre</th><th>Montant</th><th>Moyen / référence</th><th>Statut</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr><td>${esc(formatDate(p.created_at, 'fr', true))}</td><td>${esc(p.restaurants?.name || '—')}</td><td>${esc(p.subscriptions?.plans?.name || '—')}</td><td>${money(p.amount_xof)}</td>
        <td>${esc(METHOD[p.method] || p.method)}<br><small>${esc(p.transaction_reference || 'sans référence')}</small>${p.proof_path ? `<br><button type="button" class="link-btn" data-proof="${esc(p.proof_path)}">Voir le justificatif</button>` : ''}</td>
        <td>${pill(P_STATUS, p.status)}${p.admin_note ? `<br><small>${esc(p.admin_note)}</small>` : ''}</td>
        <td class="actions">${p.status === 'pending' ? `<button type="button" class="btn sm" data-review="${esc(p.id)}" data-d="approved">Approuver</button> <button type="button" class="btn sm danger" data-review="${esc(p.id)}" data-d="rejected">Refuser</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Aucun paiement.</td></tr>'}</tbody></table></div>`;
  },
  async plans() {
    const list = await api.listPlans();
    return `<div class="table-wrap"><table class="tbl"><thead><tr><th>Offre</th><th>Prix FCFA / mois</th><th>Produits max</th><th>Catégories max</th><th>Active</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr data-plan="${esc(p.id)}"><td><strong>${esc(p.name)}</strong><br><small>${esc(p.code)}</small></td>
        <td><input type="number" min="0" max="10000000" step="500" data-f="price" value="${esc(p.price_xof)}"></td>
        <td><input type="number" min="1" placeholder="illimité" data-f="prod" value="${esc(p.max_products ?? '')}"></td>
        <td><input type="number" min="1" placeholder="illimité" data-f="cat" value="${esc(p.max_categories ?? '')}"></td>
        <td><input type="checkbox" data-f="active" ${p.is_active ? 'checked' : ''}></td><td><button type="button" class="btn sm" data-save="${esc(p.id)}">Enregistrer</button></td></tr>`).join('')}</tbody></table></div>
      <p class="muted">Un champ « Produits / Catégories max » vide signifie illimité. Les modifications sont journalisées.</p>`;
  },
  async subscriptions() {
    const list = await api.listSubscriptions();
    return `<div class="table-wrap"><table class="tbl"><thead><tr><th>Restaurant</th><th>Offre</th><th>Statut</th><th>Début</th><th>Fin</th></tr></thead><tbody>
      ${list.map(s => `<tr><td>${esc(s.restaurants?.name || '—')}</td><td>${esc(s.plans?.name || '—')}</td><td>${esc(S_STATUS[s.status] || s.status)}</td>
        <td>${esc(formatDate(s.starts_at, 'fr') || '—')}</td><td>${esc(formatDate(s.ends_at, 'fr') || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Aucun abonnement.</td></tr>'}</tbody></table></div>`;
  },
  async audit() {
    const list = await api.listAudit();
    return `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Auteur</th><th>Action</th><th>Détails</th></tr></thead><tbody>
      ${list.map(x => `<tr><td>${esc(formatDate(x.created_at, 'fr', true))}</td><td>${esc(x.actor_name || (x.actor_id ? x.actor_id.slice(0, 8) : 'système'))}</td>
        <td>${esc(ACTION[x.action] || x.action)}</td><td><small>${esc(Object.entries(x.details || {}).map(([k, v]) => `${k}: ${v}`).join(' · '))}</small></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Journal vide.</td></tr>'}</tbody></table></div>`;
  }
};

function reviewModal(id, decision) {
  const ok = decision === 'approved';
  openModal(`<h2>${ok ? 'Approuver' : 'Refuser'} le paiement</h2><p class="muted">${ok ? "L'abonnement sera activé immédiatement pour une période." : 'Le restaurant verra le motif du refus.'}</p>
    <form id="rvForm" class="stack"><label class="field">Note (facultatif)<textarea id="rvNote" rows="3" maxlength="1000"></textarea></label>
    <button class="btn ${ok ? '' : 'danger'}" type="submit">${ok ? 'Approuver' : 'Refuser'}</button></form>`, {
    onMount: (wrap, close) => wrap.querySelector('#rvForm').addEventListener('submit', async e => {
      e.preventDefault();
      await withBusy(e.submitter, async () => {
        try { await api.reviewPayment(id, decision, wrap.querySelector('#rvNote').value.trim()); toast(ok ? 'Paiement approuvé, abonnement activé.' : 'Paiement refusé.', 'success'); close(); view('payments'); }
        catch (error) { toast(friendlyError(error), 'error'); }
      });
    })
  });
}

async function onClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tab) { state.tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b))); return view(state.tab); }
  if (b.dataset.review) return reviewModal(b.dataset.review, b.dataset.d);
  if (b.dataset.proof) {
    const w = window.open('about:blank', '_blank'); if (w) w.opener = null;
    try { const url = await signedProofUrl(b.dataset.proof); if (w) w.location.href = url; else toast('Autorisez les fenêtres pop-up pour voir le justificatif.', 'error'); }
    catch (error) { w?.close(); toast(friendlyError(error), 'error'); }
    return;
  }
  if (b.dataset.rs) {
    const suspend = b.dataset.to === 'suspended';
    if (suspend && !await confirmDialog(esc(`Suspendre « ${b.dataset.name} » ? Son menu public sera inaccessible.`), 'Suspendre', 'Annuler')) return;
    try { await api.setRestaurantStatus(b.dataset.rs, b.dataset.to); toast('Statut mis à jour.', 'success'); view('restaurants'); } catch (error) { toast(friendlyError(error), 'error'); }
  }
  if (b.dataset.save) {
    const row = b.closest('tr'), f = k => row.querySelector(`[data-f="${k}"]`);
    const num = el => (el.value === '' ? null : Number(el.value));
    await withBusy(b, async () => {
      try { await api.updatePlan({ id: b.dataset.save, price_xof: Number(f('price').value), max_products: num(f('prod')), max_categories: num(f('cat')), is_active: f('active').checked }); toast('Offre mise à jour.', 'success'); }
      catch (error) { toast(friendlyError(error), 'error'); }
    });
  }
}

function onChange(e) {
  if (e.target.id === 'rFilter') { state.rFilter = e.target.value; view('restaurants'); }
  if (e.target.id === 'pFilter') { state.pFilter = e.target.value; view('payments'); }
}
let timer;
function onInput(e) { if (e.target.id === 'rQuery') { state.rQuery = e.target.value; clearTimeout(timer); timer = setTimeout(async () => { await view('restaurants'); const i = $('rQuery'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); } }

async function init() {
  try {
    const session = await requireSession(); if (!session) return;
    const profile = await getProfile(session.user.id);
    if (profile?.platform_role !== 'platform_admin') { $('status').textContent = 'Accès refusé : rôle administrateur requis.'; return; }
    $('status').remove();
    const root = $('adminApp');
    // Pastille « paiements à valider » : l'administrateur voit d'un coup d'œil ce qui l'attend.
    const pending = await api.overview().then(o => Number(o.pending_payments) || 0).catch(() => 0);
    if (pending > 0) state.tab = 'payments';
    const label = (k, l) => (k === 'payments' && pending > 0 ? `${l}<span class="dot">${pending}</span>` : l);
    root.innerHTML = `<div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === state.tab}">${label(k, l)}</button>`).join('')}</div><div id="panel"></div>`;
    root.classList.remove('hidden');
    root.addEventListener('click', onClick); root.addEventListener('change', onChange); root.addEventListener('input', onInput);
    view(state.tab);
  } catch (error) { $('status').textContent = friendlyError(error); }
}
init();
