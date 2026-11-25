import { $, esc, digits, safeUrl, withBusy, toast } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { sb } from '../core/supabase.js';
import { updateRestaurant } from '../services/restaurant.service.js';
import { getPaymentSettings, savePaymentSettings, disablePaymentSettings } from '../services/payments.service.js';
import { uploadPublicImage } from '../services/storage.service.js';

export function mountSettings(ctx, el) {
  const r = ctx.restaurant;
  const img = (id, url, wide) => `<img id="${id}" class="preview ${safeUrl(url) ? '' : 'hidden'}" ${wide ? 'style="max-width:260px"' : ''} alt="" src="${esc(safeUrl(url))}" referrerpolicy="no-referrer">`;
  el.innerHTML = `<section class="panel"><h2>${esc(t('set.info'))}</h2><form id="setForm" class="form-grid" novalidate>
    <label class="field">${esc(t('set.name'))}<input id="sName" required maxlength="120" value="${esc(r.name)}"></label>
    <label class="field">${esc(t('set.whatsapp'))}<input id="sWa" inputmode="tel" value="${esc(r.whatsapp || '')}"><small>${esc(t('set.whatsappHint'))}</small></label>
    <label class="field">${esc(t('set.phone'))}<input id="sPhone" type="tel" maxlength="30" value="${esc(r.phone || '')}"></label>
    <label class="field">${esc(t('set.city'))}<input id="sCity" maxlength="80" value="${esc(r.city || '')}"></label>
    <label class="field full">${esc(t('set.address'))}<input id="sAddr" maxlength="200" value="${esc(r.address || '')}"></label>
    <label class="field full">${esc(t('set.description'))}<textarea id="sDesc" rows="3" maxlength="1000">${esc(r.description || '')}</textarea></label>
    <label class="field">${esc(t('set.language'))}<select id="sLang"><option value="fr" ${r.default_language === 'fr' ? 'selected' : ''}>Français</option><option value="en" ${r.default_language === 'en' ? 'selected' : ''}>English</option></select></label>
    <label class="field">${esc(t('set.slug'))}<input value="${esc(r.slug)}" readonly><small>${esc(t('set.slugHint'))}</small></label>
    <label class="field">${esc(t('set.logo'))}<input id="sLogo" type="file" accept="image/jpeg,image/png,image/webp">${img('sLogoPrev', r.logo_url)}</label>
    <label class="field">${esc(t('set.cover'))}<input id="sCover" type="file" accept="image/jpeg,image/png,image/webp">${img('sCoverPrev', r.cover_url, true)}</label>
    <div class="full"><button class="btn lg" type="submit">${esc(t('common.save'))}</button> <span id="sMsg" class="notice" role="alert"></span></div></form></section>
  <section class="panel"><h2>${esc(t('set.account'))}</h2><p class="muted">${esc(ctx.user.email)}</p>
    <form id="pwForm" class="form-grid" novalidate><label class="field">${esc(t('set.newPassword'))}<input id="pw1" type="password" minlength="8" autocomplete="new-password"></label>
    <label class="field">${esc(t('reset.confirm'))}<input id="pw2" type="password" minlength="8" autocomplete="new-password"></label>
    <div class="full"><button class="btn secondary" type="submit">${esc(t('set.changePassword'))}</button> <span id="pwMsg" class="notice" role="alert"></span></div></form></section>`;

  mountPaymentSettings(ctx, el);

  for (const [input, preview] of [['sLogo', 'sLogoPrev'], ['sCover', 'sCoverPrev']]) {
    $(input, el).addEventListener('change', () => {
      const f = $(input, el).files[0];
      if (f) { $(preview, el).src = URL.createObjectURL(f); $(preview, el).classList.remove('hidden'); }
    });
  }

  $('setForm', el).addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('sMsg', el); msg.textContent = '';
    const name = $('sName', el).value.trim(), wa = digits($('sWa', el).value);
    if (name.length < 2) return void (msg.textContent = t('err.restaurantName'));
    if (wa && (wa.length < 8 || wa.length > 15)) return void (msg.textContent = t('err.whatsapp'));
    await withBusy(e.submitter, async () => {
      try {
        const patch = { name, whatsapp: wa || null, phone: $('sPhone', el).value.trim() || null, city: $('sCity', el).value.trim() || null,
          address: $('sAddr', el).value.trim() || null, description: $('sDesc', el).value.trim() || null, default_language: $('sLang', el).value };
        const logo = $('sLogo', el).files[0], cover = $('sCover', el).files[0];
        if (logo) patch.logo_url = await uploadPublicImage('restaurant-logos', r.id, logo);
        if (cover) patch.cover_url = await uploadPublicImage('restaurant-covers', r.id, cover);
        await updateRestaurant(r.id, patch);
        Object.assign(ctx.restaurant, patch);
        ctx.refreshHeader();
        toast(t('common.saved'), 'success');
      } catch (error) { msg.textContent = friendlyError(error); }
    });
  });

  $('pwForm', el).addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('pwMsg', el), a = $('pw1', el).value, b = $('pw2', el).value;
    if (a.length < 8) return void (msg.textContent = t('err.passwordShort'));
    if (a !== b) return void (msg.textContent = t('reset.mismatch'));
    await withBusy(e.submitter, async () => {
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) msg.textContent = friendlyError(error);
      else { msg.textContent = ''; e.target.reset(); toast(t('set.passwordChanged'), 'success'); }
    });
  });
}

const WEBHOOK_BASE = `${(window.SIPOKMENU_CONFIG?.supabaseUrl || '').replace(/\/$/, '')}/functions/v1/fedapay-orders`;

// Section réservée au propriétaire : la clé est envoyée une seule fois, chiffrée côté serveur, puis jamais renvoyée.
function mountPaymentSettings(ctx, el) {
  const r = ctx.restaurant, hook = `${WEBHOOK_BASE}?r=${r.id}`;
  const section = document.createElement('section');
  section.className = 'panel';
  section.innerHTML = `<h2>${esc(t('set.pay.title'))}</h2><p class="muted">${esc(t('set.pay.intro'))}</p>
    <p id="payState" class="pill grey"></p>
    <form id="payForm" class="form-grid" novalidate>
    <label class="field">${esc(t('set.pay.env'))}<select id="payEnv"><option value="sandbox">${esc(t('set.pay.sandbox'))}</option><option value="live">${esc(t('set.pay.live'))}</option></select></label>
    <label class="field">${esc(t('set.pay.key'))}<input id="payKey" type="password" autocomplete="off" spellcheck="false" maxlength="200"><small>${esc(t('set.pay.keyHint'))}</small></label>
    <label class="field">${esc(t('set.pay.webhook'))}<input id="payHook" type="password" autocomplete="off" spellcheck="false" maxlength="200"></label>
    <label class="field full">${esc(t('set.pay.url'))}<input id="payUrl" readonly value="${esc(hook)}"><small>${esc(t('set.pay.events'))}</small></label>
    <div class="full"><button class="btn lg" type="submit">${esc(t('set.pay.save'))}</button>
      <button class="btn secondary" type="button" id="payCopy">${esc(t('set.pay.copy'))}</button>
      <button class="btn danger hidden" type="button" id="payOff">${esc(t('set.pay.disable'))}</button> <span id="payMsg" class="notice" role="alert"></span></div></form>`;
  el.querySelector('#setForm').closest('section').after(section);

  const q = id => section.querySelector(`#${id}`);
  const show = s => {
    q('payState').textContent = s?.enabled ? t('set.pay.on', { env: s.env, hint: s.key_hint || '' }) : t('set.pay.off');
    q('payState').className = `pill ${s?.enabled ? 'ok' : 'grey'}`;
    q('payOff').classList.toggle('hidden', !s?.enabled);
    if (s?.env) q('payEnv').value = s.env;
  };
  getPaymentSettings(r.id).then(show).catch(() => show(null));

  q('payCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(hook); toast(t('set.pay.copied'), 'success'); } catch { q('payUrl').select(); }
  });
  q('payForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = q('payMsg'); msg.textContent = '';
    const secretKey = q('payKey').value.trim();
    if (!secretKey) return void (msg.textContent = t('set.pay.keyMissing'));
    await withBusy(e.submitter, async () => {
      try {
        show(await savePaymentSettings(r.id, { env: q('payEnv').value, secretKey, webhookSecret: q('payHook').value.trim() }));
        q('payKey').value = ''; q('payHook').value = ''; r.online_payments = true;
        toast(t('set.pay.saved'), 'success');
      } catch (error) { msg.textContent = friendlyError(error); }
    });
  });
  q('payOff').addEventListener('click', async e => {
    await withBusy(e.currentTarget, async () => {
      try { show(await disablePaymentSettings(r.id)); r.online_payments = false; toast(t('set.pay.disabled'), 'success'); }
      catch (error) { q('payMsg').textContent = friendlyError(error); }
    });
  });
}
