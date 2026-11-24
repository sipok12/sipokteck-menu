import { t } from '../core/i18n.js';

/** Courbe CA + commandes par jour (barres + ligne). Retourne l'instance Chart, ou null si la librairie est indisponible. */
export async function drawSalesChart(canvas, daily) {
  const { default: Chart } = await import('chart.js/auto').catch(() => ({ default: null }));
  if (!Chart) return null;
  const css = getComputedStyle(document.documentElement);
  return new Chart(canvas, {
    data: { labels: daily.map(d => d.day.slice(5)), datasets: [
      { type: 'bar', label: t('ov.revenue'), data: daily.map(d => d.revenue), backgroundColor: '#bfdccd', yAxisID: 'y' },
      { type: 'line', label: t('ov.orders'), data: daily.map(d => d.orders), borderColor: css.getPropertyValue('--blue').trim() || '#0b6e4f', tension: .3, yAxisID: 'y1' }] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'FCFA' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0 } } } }
  });
}
