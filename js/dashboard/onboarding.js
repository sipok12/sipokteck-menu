import { $, esc, digits, withBusy, toast } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { createRestaurant } from '../services/restaurant.service.js';

export function renderOnboarding(app, user) {
  app.innerHTML = `<small class="eyebrow">${esc(t('dash.eyebrow'))}</small><h1>${esc(t('onb.title'))}</h1>
  <section class="panel narrow"><p class="muted">${esc(t('onb.intro'))}</p>
  <form id="restaurantForm" class="stack" novalidate>
    <label class="field">${esc(t('set.name'))}<input id="rName" required maxlength="120" autocomplete="organization"></label>
    <label class="field">${esc(t('set.whatsapp'))}<input id="rWhatsapp" required inputmode="tel" placeholder="22890000000"><small>${esc(t('set.whatsappHint'))}</small></label>
    <label class="field">${esc(t('set.phone'))}<input id="rPhone" type="tel" maxlength="30"></label>
    <label class="field">${esc(t('set.city'))}<input id="rCity" maxlength="80"></label>
    <label class="field">${esc(t('set.address'))}<input id="rAddress" maxlength="200"></label>
    <label class="field">${esc(t('set.description'))}<textarea id="rDescription" rows="3" maxlength="1000"></textarea></label>
    <label class="field">${esc(t('set.language'))}<select id="rLang"><option value="fr">Français</option><option value="en">English</option></select></label>
    <button class="btn lg" type="submit">${esc(t('onb.submit'))}</button><p id="onbMsg" class="notice" role="alert"></p>
  </form></section>`;
  $('restaurantForm').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('rName').value.trim(), wa = digits($('rWhatsapp').value);
    if (name.length < 2) return void ($('onbMsg').textContent = t('err.restaurantName'));
    if (wa.length < 8 || wa.length > 15) return void ($('onbMsg').textContent = t('err.whatsapp'));
    await withBusy(event.submitter, async () => {
      try {
        await createRestaurant(user.id, { name, whatsapp: wa, phone: $('rPhone').value.trim(), city: $('rCity').value.trim(),
          address: $('rAddress').value.trim(), description: $('rDescription').value.trim(), default_language: $('rLang').value });
        toast(t('onb.done'), 'success');
        setTimeout(() => location.reload(), 700);
      } catch (error) { $('onbMsg').textContent = friendlyError(error); }
    });
  });
}
