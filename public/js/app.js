import * as A from './analysis.js';
import * as V from './views.js';
import { destroyAll, paintSwatches, esc } from './charts.js';

const state = {
  days: load('days', 28),
  tab: load('tab', 'overview'),
  perfSport: 'running',
  sessionSport: 'all',
  data: null,
  ctx: null,
  loading: false,
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`cockpit.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`cockpit.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: keep in memory only
  }
}

const $ = (sel) => document.querySelector(sel);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'dashboard', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON error
  }
  if (!res.ok) {
    const err = new Error(payload?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = payload?.code;
    throw err;
  }
  return payload;
}

// ---------- auth ----------

async function boot() {
  const status = await api('/api/status');
  if (status.authenticated) return showApp();
  $('#auth').hidden = false;
  $('#app').hidden = true;
  $('#setup-form').hidden = status.configured;
  $('#login-form').hidden = !status.configured;
  $('#setup-code-row').hidden = !status.setupCodeRequired;
  (status.configured ? $('#login-form [name=password]') : $('#setup-form input:not([hidden])'))?.focus();
}

function bindForm(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = form.querySelector('.form-error');
    const button = form.querySelector('button[type=submit]');
    errorEl.textContent = '';
    button.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)));
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

bindForm($('#setup-form'), async (f) => {
  if (f.password !== f.password2) throw new Error('Die Passwörter stimmen nicht überein.');
  await api('/api/setup', { method: 'POST', body: { setupCode: f.setupCode, password: f.password, apiKey: f.apiKey } });
  showApp();
});
bindForm($('#login-form'), async (f) => {
  await api('/api/login', { method: 'POST', body: { password: f.password } });
  showApp();
});
bindForm($('#key-form'), async (f) => {
  await api('/api/key', { method: 'POST', body: f });
  $('#settings-dialog').close();
  refresh(true);
});
bindForm($('#reset-form'), async (f) => {
  if (!confirm('Zugangsdaten wirklich löschen?')) throw new Error('Abgebrochen.');
  await api('/api/reset', { method: 'POST', body: f });
  location.reload();
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});
$('#settings-btn').addEventListener('click', () => $('#settings-dialog').showModal());
$('#refresh-btn').addEventListener('click', () => refresh(true));

// ---------- app ----------

function showApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  syncControls();
  refresh(false);
}

function syncControls() {
  document.querySelectorAll('#period-group button').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.days) === state.days)));
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

document.querySelectorAll('#period-group button').forEach((b) =>
  b.addEventListener('click', () => {
    state.days = Number(b.dataset.days);
    save('days', state.days);
    syncControls();
    refresh(false);
  }),
);
document.querySelectorAll('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    save('tab', state.tab);
    syncControls();
    render();
    window.scrollTo({ top: 0 });
  }),
);

async function refresh(force) {
  const today = A.localToday();
  const p = A.periods(today, state.days);
  $('#range-label').textContent = `${fmtDate(p.cur.from)} – ${fmtDate(p.cur.to)} · Vergleich mit ${fmtDate(p.prev.from)} – ${fmtDate(p.prev.to)}`;
  state.loading = true;
  if (!state.data) $('#view').innerHTML = '<p class="loading">Lade Daten von Garmin …</p>';
  $('#refresh-btn').disabled = true;
  try {
    const q = new URLSearchParams({ from: p.fetch.from, to: p.fetch.to, today });
    if (force) q.set('refresh', '1');
    state.data = await api(`/api/data?${q}`);
    state.ctx = A.analyze(state.data, { today, days: state.days });
    render();
  } catch (err) {
    if (err.status === 401 && err.code !== 'key-rejected') return boot();
    $('#view').innerHTML = `<div class="error-box"><strong>Daten konnten nicht geladen werden.</strong><br>${esc(err.message)}</div>`;
  } finally {
    state.loading = false;
    $('#refresh-btn').disabled = false;
  }
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}.${Number(m)}.${y.slice(2)}`;
}

function render() {
  if (!state.data || !state.ctx) return;
  destroyAll();
  const views = { overview: V.overview, recovery: V.recovery, load: V.load, performance: V.performance, sessions: V.sessions, data: V.dataView };
  const { html, after } = (views[state.tab] || V.overview)(state.data, state.ctx, state);
  const main = $('#view');
  main.innerHTML = `<div class="grid">${html}</div>`;
  paintSwatches(main);
  after();
}

// Delegated handlers for content inside the view and dialogs.
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle-table]');
  if (toggle) {
    const card = toggle.closest('[data-chart]');
    const table = card.querySelector('.chart-table');
    const box = card.querySelector('.chart-box');
    const showTable = table.hidden;
    table.hidden = !showTable;
    box.hidden = showTable;
    toggle.setAttribute('aria-pressed', String(showTable));
    toggle.textContent = showTable ? 'Diagramm' : 'Tabelle';
    return;
  }
  const act = e.target.closest('[data-activity]');
  if (act) openActivity(act.dataset.activity);
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'perf-sport') {
    state.perfSport = e.target.value;
    render();
  } else if (e.target.id === 'session-sport') {
    state.sessionSport = e.target.value;
    render();
  }
});

async function openActivity(id) {
  const a = state.data.activities.find((x) => String(x.id) === String(id));
  if (!a) return;
  const dialog = $('#activity-dialog');
  const body = $('#activity-body');
  $('#activity-title').textContent = a.name || 'Einheit';
  body.innerHTML = '<p class="loading">Lade Detaildaten (FIT-Datei) …</p>';
  dialog.showModal();
  const group = A.sportGroup(a.type);
  let stream;
  try {
    stream = await api(`/api/activity/${encodeURIComponent(id)}?split=${group === 'cycling' ? 5000 : 1000}`);
  } catch (err) {
    stream = { error: `Detaildaten nicht verfügbar: ${err.message}` };
  }
  if (!dialog.open) return;
  const { html, after } = V.activityDetail(a, state.data, stream);
  body.innerHTML = html;
  paintSwatches(body);
  after();
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

function whenChartReady(fn) {
  if (window.Chart) return fn();
  window.addEventListener('load', fn, { once: true });
}

whenChartReady(() => {
  if (window.Chart) window.Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  boot().catch((err) => {
    document.body.innerHTML = `<div class="auth"><div class="auth-card error-box">Server nicht erreichbar: ${esc(err.message)}</div></div>`;
  });
});
