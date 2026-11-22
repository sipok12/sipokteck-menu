import { esc, money, copyText, toast } from '../core/utils.js';
import { t, getLang } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { getStats } from '../services/billing.service.js';

let chart = null;

/** Met à jour les deux compteurs sans redessiner l'aperçu (appelé à chaque rafraîchissement des commandes). */
export function updateOverviewCounts(root, orders) {
  const pending = root?.querySelector('#ovPending'), today = root?.querySelector('#ovToday');
  if (!pending || !today) return;
  const day = new Date().toDateString();
  pending.textContent = orders.filter(o => o.status === 'pending').length;
  today.textContent = orders.filter(o => new Date(o.created_at).toDateString() === day && o.status !== 'cancelled').length;
}

export async function mountOverview(ctx, el, orders) {
  const r = ctx.restaurant, lang = getLang();
  const url = `${location.origin}/menu?slug=${encodeURIComponent(r.slug)}`;
  const billing = await ctx.getBilling();
  const today = new Date().toDateString();
  const pending = orders.filter(o => o.status === 'pending').length;
  const todayCount = orders.filter(o => new Date(o.created_at).toDateString() === today && o.status !== 'cancelled').length;
  const usage = (n, max) => `${n}${max != null ? ` / ${max}` : ''}`;
  const bar = (n, max) => (max == null ? '' : `<div class="bar" role="img" aria-label="${n}/${max}"><i class="${n >= max ? 'full' : ''}" style="width:${Math.min(100, Math.round(n / max * 100))}%"></i></div>`);

  el.innerHTML = `<div class="cards">
    <div class="stat"><span>${esc(t('ov.pending'))}</span><strong id="ovPending">${pending}</strong></div>
    <div class="stat"><span>${esc(t('ov.today'))}</span><strong id="ovToday">${todayCount}</strong></div>
    ${billing ? `<div class="stat"><span>${esc(t('ov.products'))}</span><strong>${usage(billing.products, billing.max_products)}</strong>${bar(billing.products, billing.max_products)}</div>
    <div class="stat"><span>${esc(t('ov.categories'))}</span><strong>${usage(billing.categories, billing.max_categories)}</strong>${bar(billing.categories, billing.max_categories)}</div>` : ''}</div>
  <section class="panel"><h2>${esc(t('ov.link'))}</h2>${r.status === 'active'
    ? `<p class="link-line">${esc(url)}</p><div class="btn-row"><button type="button" class="btn" id="ovCopy">${esc(t('qr.copy'))}</button>
       <a class="btn secondary" href="/menu?slug=${encodeURIComponent(r.slug)}" target="_blank" rel="noopener">${esc(t('dash.viewMenu'))} ↗</a>
       <a class="btn secondary" href="/qr">${esc(t('nav.myQr'))}</a></div>`
    : `<p class="muted">${esc(t(r.status === 'pending' ? 'ov.linkPending' : 'ov.linkSuspended'))}</p>`}</section>
  <section class="panel"><h2>${esc(t('ov.stats'))}</h2><div id="statsBox"><p class="loading">${esc(t('common.loading'))}</p></div></section>`;

  el.querySelector('#ovCopy')?.addEventListener('click', () => copyText(url).then(() => toast(t('common.copied'), 'success')));

  const box = el.querySelector('#statsBox');
  let days = 30;

  async function drawStats() {
    try {
      const s = await getStats(r.id, days);
      if (s.locked) {
        box.innerHTML = `<div class="locked"><p>🔒 ${esc(t('ov.locked'))}</p>${ctx.canManage ? `<button type="button" class="btn" id="goBilling">${esc(t('ov.upgrade'))}</button>` : ''}</div>`;
        box.querySelector('#goBilling')?.addEventListener('click', () => ctx.go('billing'));
        return;
      }
      box.innerHTML = `<div class="range" role="group" aria-label="${esc(t('ov.range'))}">${[7, 30, 90].map(d => `<button type="button" class="outline sm" data-days="${d}" aria-pressed="${d === days}">${esc(t('ov.days', { n: d }))}</button>`).join('')}</div>
        <div class="cards"><div class="stat"><span>${esc(t('ov.orders'))}</span><strong>${s.totals.orders}</strong></div>
        <div class="stat"><span>${esc(t('ov.revenue'))}</span><strong>${money(s.totals.revenue, lang)}</strong></div></div>
        <div class="chart-box"><canvas id="statsChart" role="img" aria-label="${esc(t('ov.chartLabel'))}"></canvas></div>
        <div class="form-grid" style="margin-top:16px"><div><h3>${esc(t('ov.top'))}</h3><ol class="rank">${(s.top_products || []).map(p => `<li><span>${esc(p.name)}</span><b>${esc(p.quantity)} ×</b></li>`).join('') || `<li class="muted">${esc(t('ov.noData'))}</li>`}</ol></div>
        <div><h3>${esc(t('ov.byStatus'))}</h3><ol class="rank">${Object.entries(s.by_status || {}).map(([k, n]) => `<li><span>${esc(t(`status.${k}`))}</span><b>${n}</b></li>`).join('') || `<li class="muted">${esc(t('ov.noData'))}</li>`}</ol></div></div>`;
      box.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => { days = Number(b.dataset.days); drawStats(); }));
      chart?.destroy(); chart = null;
      const { default: Chart } = await import('chart.js/auto').catch(() => ({ default: null }));
      if (Chart) {
        const css = getComputedStyle(document.documentElement);
        chart = new Chart(box.querySelector('#statsChart'), {
          data: { labels: s.daily.map(d => d.day.slice(5)), datasets: [
            { type: 'bar', label: t('ov.revenue'), data: s.daily.map(d => d.revenue), backgroundColor: '#bfdccd', yAxisID: 'y' },
            { type: 'line', label: t('ov.orders'), data: s.daily.map(d => d.orders), borderColor: css.getPropertyValue('--blue').trim() || '#0b6e4f', tension: .3, yAxisID: 'y1' }] },
          options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            scales: { y: { beginAtZero: true, title: { display: true, text: 'FCFA' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0 } } } }
        });
      } else box.querySelector('.chart-box').innerHTML = `<p class="muted">${esc(t('ov.chartUnavailable'))}</p>`;
    } catch (error) { box.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; }
  }
  drawStats();
}
