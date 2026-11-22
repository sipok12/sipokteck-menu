import { $, esc, copyText, toast } from '../core/utils.js';
import { t, initLangToggle } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { requireSession } from '../core/auth.js';
import { drawQr } from '../core/qr.js';
import { listMyRestaurants, chooseRestaurant, rememberRestaurant } from '../services/restaurant.service.js';

let current = null;

async function draw() {
  const status = $('qrStatus');
  const box = $('qrcode');
  box.innerHTML = '';
  $('qrTitle').textContent = current.name;
  if (current.status !== 'active') {
    status.textContent = t(current.status === 'pending' ? 'qr.pending' : 'qr.suspended');
    $('menuLink').textContent = ''; $('qrScan').classList.add('hidden');
    $('downloadQR').disabled = true; $('copyLink').disabled = true;
    return;
  }
  const url = `${location.origin}/menu?slug=${encodeURIComponent(current.slug)}`;
  try { await drawQr(box, url); } catch { status.textContent = t('qr.libError'); return; }
  $('menuLink').textContent = url;
  $('qrScan').classList.remove('hidden');
  status.textContent = t('qr.active', { name: current.name });
  $('downloadQR').disabled = false; $('copyLink').disabled = false;
  $('downloadQR').onclick = () => {
    const canvas = box.querySelector('canvas');
    if (!canvas) return;
    const src = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = src; a.download = `sipokmenu-${current.slug}-qr.png`; a.click();
  };
  $('copyLink').onclick = () => copyText(url).then(() => toast(t('common.copied'), 'success'));
}

function renderPicker(list) {
  if (list.length < 2) return;
  const select = document.createElement('select');
  select.className = 'no-print'; select.setAttribute('aria-label', t('qr.choose'));
  select.innerHTML = list.map(r => `<option value="${esc(r.id)}" ${r.id === current.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  select.onchange = () => { current = list.find(r => r.id === select.value); rememberRestaurant(current.id); draw(); };
  $('qrTitle').after(select);
}

async function init() {
  initLangToggle(() => current && draw());
  $('printQR').onclick = () => window.print();
  try {
    const session = await requireSession();
    if (!session) return;
    const list = await listMyRestaurants(session.user.id);
    current = chooseRestaurant(list);
    if (!current) { $('qrStatus').textContent = t('qr.none'); return; }
    renderPicker(list);
    draw();
  } catch (error) { $('qrStatus').textContent = friendlyError(error); }
}
init();
