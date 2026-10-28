// Chart.js wrapper: theme from CSS custom properties, consistent marks,
// hover tooltips and a table view for every chart.

const charts = new Map();

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function theme() {
  return {
    text: css('--text'),
    text2: css('--text-2'),
    muted: css('--muted'),
    grid: css('--grid'),
    axis: css('--axis'),
    surface: css('--surface'),
    band: css('--band'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css(`--s${i}`)),
    ordinal: [css('--ord-1'), css('--ord-2'), css('--ord-3')],
    status: { good: css('--good'), warning: css('--warning'), serious: css('--serious'), critical: css('--critical') },
  };
}

export const SPORT_SLOT = { running: 0, cycling: 1, swimming: 2, walking: 3, endurance_other: 4, strength: 5, other: 6 };
export const CATEGORY_SLOT = { recovery: 0, base: 1, long: 2, tempo: 3, threshold: 4, vo2: 5 };

export function categoryColor(key) {
  const t = theme();
  return key in CATEGORY_SLOT ? t.series[CATEGORY_SLOT[key]] : t.muted;
}

function baseOptions(t, { yTitle, xType = 'category', stacked = false, yReverse = false, yFormat, xFormat, legend = false, tooltip = {} } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: xType === 'linear' ? { mode: 'nearest', intersect: true } : { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, position: 'top', align: 'start', labels: { color: t.text2, boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', padding: 10, font: { size: 12 } } },
      tooltip: {
        backgroundColor: t.surface,
        titleColor: t.text,
        bodyColor: t.text2,
        borderColor: t.axis,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        boxPadding: 4,
        usePointStyle: true,
        ...tooltip,
      },
    },
    scales: {
      x: {
        type: xType,
        stacked,
        grid: { display: xType === 'linear', color: t.grid, drawTicks: false },
        border: { color: t.axis },
        ticks: { color: t.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 11 }, ...(xFormat ? { callback: xFormat } : {}) },
      },
      y: {
        stacked,
        reverse: yReverse,
        grid: { color: t.grid, drawTicks: false },
        border: { display: false },
        title: yTitle ? { display: true, text: yTitle, color: t.muted, font: { size: 11 } } : undefined,
        ticks: { color: t.muted, maxTicksLimit: 5, padding: 6, font: { size: 11 }, ...(yFormat ? { callback: yFormat } : {}) },
      },
    },
  };
}

// spec: { type, labels, datasets, options: {...baseOptions args}, extra: chart.js options to merge }
export function renderChart(id, spec) {
  const card = document.querySelector(`[data-chart="${id}"]`);
  if (!card || !window.Chart) return;
  const canvas = card.querySelector('canvas');
  charts.get(id)?.destroy();
  const t = theme();
  const opts = baseOptions(t, spec.options);
  if (spec.extra) deepMerge(opts, spec.extra);
  const chart = new window.Chart(canvas, { type: spec.type, data: { labels: spec.labels, datasets: spec.datasets }, options: opts, plugins: spec.plugins || [] });
  charts.set(id, chart);
  const tableHost = card.querySelector('.chart-table');
  if (tableHost && spec.table) tableHost.innerHTML = tableHtml(spec.table);
}

export function destroyAll() {
  for (const c of charts.values()) c.destroy();
  charts.clear();
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function tableHtml({ columns, rows }) {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((v, i) => `<td class="${columns[i].num ? 'num' : ''}">${esc(v ?? '–')}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Card markup with a canvas and a hidden table view.
export function chartCard({ id, title, subtitle = '', foot = '', legend = '', tall = false, span = false }) {
  return `<section class="card${span ? ' span' : ''}" data-chart="${id}">
    <div class="card-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
    <button type="button" class="table-toggle" data-toggle-table aria-pressed="false">Tabelle</button></div>
    ${legend}
    <div class="chart-box${tall ? ' tall' : ''}"><canvas role="img" aria-label="${esc(title)}"></canvas></div>
    <div class="chart-table" hidden></div>
    ${foot ? `<p class="card-foot">${foot}</p>` : ''}
  </section>`;
}

export function legendHtml(items) {
  return `<ul class="legend">${items
    .map((it) => `<li><i class="${it.kind || ''}" data-swatch="${esc(it.color)}"></i>${esc(it.label)}</li>`)
    .join('')}</ul>`;
}

export function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${Number(d)}.${Number(m)}.`;
}

// The CSP forbids inline style attributes, so swatch colours are applied via CSSOM.
export function paintSwatches(root) {
  root.querySelectorAll('[data-swatch]').forEach((el) => {
    el.style.background = el.dataset.swatch;
  });
}
