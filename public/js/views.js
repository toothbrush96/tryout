import * as A from './analysis.js';
import { renderChart, chartCard, legendHtml, esc, theme, SPORT_SLOT, CATEGORY_SLOT, categoryColor, shortDate, tableHtml } from './charts.js';

const nf = (d = 0) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : nf(d).format(v));
const inRange = (d, r) => d >= r.from && d <= r.to;
const STATE_ICON = { good: '✓', warning: '!', serious: '!!', missing: '?' };
const SEVERITY_ICON = { good: '↑', info: 'i', warning: '!', serious: '!!' };

// ---------- shared pieces ----------

function missingBox(title, text) {
  return `<div class="missing-box"><strong>${esc(title)}</strong><br>${text}</div>`;
}

function deltaHtml(cur, prev, { better = null, digits = 0, unit = '', invertWords = false, asPace = false } = {}) {
  if (cur === null || prev === null || !Number.isFinite(cur) || !Number.isFinite(prev)) return '<div class="tile-delta">kein Vergleich möglich</div>';
  const diff = cur - prev;
  if (Math.abs(diff) < 10 ** -digits / 2) return '<div class="tile-delta">wie Vorzeitraum</div>';
  const up = diff > 0;
  let cls = '';
  if (better === 'up') cls = up ? 'up-good' : 'down-bad';
  if (better === 'down') cls = up ? 'up-bad' : 'down-good';
  const arrow = up ? '▲' : '▼';
  const pct = A.pctChange(cur, prev);
  const abs = asPace ? `${A.fmtPace(Math.abs(diff))} /km ${up !== invertWords ? 'langsamer' : 'schneller'}` : `${up ? '+' : '−'}${fmt(Math.abs(diff), digits)}${unit}`;
  return `<div class="tile-delta ${cls}">${arrow} ${abs}${pct !== null && !asPace ? ` (${up ? '+' : '−'}${fmt(Math.abs(pct), 0)} %)` : ''}</div>`;
}

function tile(label, value, delta = '', missing = false) {
  return `<div class="tile${missing ? ' missing' : ''}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>${delta}</div>`;
}

function sourceHint(data, source, fields) {
  const meta = data.sources?.[source];
  if (!meta) return '';
  if (meta.failed && meta.failed === meta.windows) return `Abruf fehlgeschlagen (${esc(meta.errors?.[0]?.message || 'Fehler')}).`;
  if (!meta.count) return 'Die API hat für diesen Zeitraum keine Datensätze geliefert.';
  const missing = fields.filter((f) => !meta.fields?.[f]);
  return missing.length ? `In ${meta.count} Datensätzen fehlen die Felder: ${missing.map((f) => `<code>${esc(f)}</code>`).join(', ')}.` : '';
}

function buckets(range, days) {
  if (days <= 31) {
    const keys = A.dateRange(range.from, range.to);
    return { keys, keyOf: (d) => d, label: shortDate, unit: 'Tag' };
  }
  const keys = [];
  for (let w = A.weekStart(range.from); w <= range.to; w = A.addDays(w, 7)) keys.push(w);
  return { keys, keyOf: A.weekStart, label: (k) => `KW ${isoWeek(k)}`, unit: 'Woche' };
}

function isoWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

const lineDs = (label, data, color, extra = {}) => ({ type: 'line', label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, spanGaps: true, ...extra });
const barDs = (label, data, color, extra = {}) => ({ type: 'bar', label, data, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', borderColor: theme().surface, borderWidth: { top: 0, left: 1, right: 1, bottom: 0 }, maxBarThickness: 28, ...extra });

// ---------- Überblick ----------

export function overview(data, ctx) {
  const { cur, prev } = ctx.summary;
  const r = ctx.recovery;
  const hasRides = cur.rideKm > 0 || prev.rideKm > 0;
  const tiles = [
    tile('Einheiten', fmt(cur.sessions), deltaHtml(cur.sessions, prev.sessions)),
    tile('Trainingszeit', A.fmtHours(cur.hours), deltaHtml(cur.hours, prev.hours, { digits: 1, unit: ' h' })),
    tile('Lauf-Distanz', `${fmt(cur.runKm, 1)} km`, deltaHtml(cur.runKm, prev.runKm, { digits: 1, unit: ' km' })),
    hasRides ? tile('Rad-Distanz', `${fmt(cur.rideKm, 0)} km`, deltaHtml(cur.rideKm, prev.rideKm, { unit: ' km' })) : '',
    cur.loadPerWeek !== null && ctx.model.key !== 'none' ? tile('Belastung / Woche', fmt(cur.loadPerWeek), deltaHtml(cur.loadPerWeek, prev.loadPerWeek)) : tile('Belastung / Woche', 'keine Daten', '', true),
    cur.ef !== null ? tile('Lauf-Effizienz', `${fmt(cur.ef, 2)} m/Schlag`, deltaHtml(cur.ef, prev.ef, { better: 'up', digits: 2 })) : tile('Lauf-Effizienz', 'zu wenige Läufe mit HF', '', true),
    cur.restingHR !== null ? tile('Ruhepuls Ø', `${fmt(cur.restingHR, 0)} bpm`, deltaHtml(cur.restingHR, prev.restingHR, { better: 'down', digits: 1, unit: ' bpm' })) : tile('Ruhepuls Ø', 'nicht verfügbar', '', true),
    cur.hrv !== null ? tile('HRV Ø (Nacht)', `${fmt(cur.hrv, 0)} ms`, deltaHtml(cur.hrv, prev.hrv, { better: 'up', digits: 1, unit: ' ms' })) : tile('HRV Ø (Nacht)', 'nicht verfügbar', '', true),
    cur.sleepHours !== null ? tile('Schlaf Ø', A.fmtHours(cur.sleepHours), deltaHtml(cur.sleepHours, prev.sleepHours, { better: 'up', digits: 1, unit: ' h' })) : tile('Schlaf Ø', 'nicht verfügbar', '', true),
  ].join('');

  const b = buckets(ctx.periods.cur, ctx.days);
  const groups = new Map();
  for (const a of cur.activities) {
    const g = A.sportGroup(a.type);
    if (!groups.has(g)) groups.set(g, new Map());
    const k = b.keyOf(a.date);
    groups.get(g).set(k, (groups.get(g).get(k) || 0) + (a.duration || 0) / 3600);
  }
  const t = theme();
  const sports = [...groups.keys()].sort((x, y) => SPORT_SLOT[x] - SPORT_SLOT[y]);

  const html = `
    ${verdictCard(r)}
    <h2 class="section-title">Zeitraum im Vergleich zum Vorzeitraum</h2>
    <div class="tiles">${tiles}</div>
    <h2 class="section-title">Auffälligkeiten</h2>
    ${insightsHtml(ctx.insights)}
    <h2 class="section-title">Volumen</h2>
    ${sports.length ? chartCard({ id: 'ov-volume', title: `Trainingszeit pro ${b.unit}`, subtitle: 'Stunden nach Sportart', legend: legendHtml(sports.map((g) => ({ label: A.SPORTS[g], color: t.series[SPORT_SLOT[g]] }))) }) : missingBox('Keine Aktivitäten', 'Im gewählten Zeitraum hat die API keine Aktivitäten geliefert.')}
  `;
  const after = () => {
    if (!sports.length) return;
    renderChart('ov-volume', {
      type: 'bar',
      labels: b.keys.map(b.label),
      datasets: sports.map((g) => barDs(A.SPORTS[g], b.keys.map((k) => groups.get(g).get(k) || 0), t.series[SPORT_SLOT[g]])),
      options: { stacked: true, yFormat: (v) => `${v} h` },
      extra: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${A.fmtHours(c.parsed.y)}` } } } },
      table: { columns: [{ label: b.unit }, ...sports.map((g) => ({ label: A.SPORTS[g], num: true }))], rows: b.keys.map((k) => [b.label(k), ...sports.map((g) => A.fmtHours(groups.get(g).get(k) || 0))]) },
    });
  };
  return { html, after };
}

function verdictCard(r) {
  const v = r.verdict;
  return `<section class="card">
    <div class="verdict"><div class="verdict-icon state-${v.state}" aria-hidden="true">${STATE_ICON[v.state]}</div>
    <div><h2>${esc(v.title)}</h2><p>${esc(v.text)}</p></div></div>
    <ul class="signals">${r.signals
      .map((s) => `<li><span class="dot state-${s.state}" aria-hidden="true">${STATE_ICON[s.state]}</span>
        <span><span class="sig-label">${esc(s.label)}</span><span class="sig-ref">${esc(s.ref || '')}</span></span>
        <span class="sig-value">${s.state === 'missing' ? '<span class="tag na">fehlt</span>' : esc(s.value)}</span></li>`)
      .join('')}</ul>
    <p class="card-foot">Eigener Erholungs-Check aus deinen Rohdaten (${esc(r.basis)}). Garmins <strong>Training Readiness</strong> ist über die Personal API nicht abrufbar und wird daher nicht angezeigt.</p>
  </section>`;
}

function insightsHtml(list) {
  if (!list.length) return '<div class="missing-box">Keine Auffälligkeiten: Belastung, Erholung und Effizienz bewegen sich im Rahmen deines Vorzeitraums.</div>';
  return `<ul class="insights">${list
    .map((i) => `<li class="insight"><span class="badge ${i.severity}" aria-label="${i.severity}">${SEVERITY_ICON[i.severity]}</span><div><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div></li>`)
    .join('')}</ul>`;
}

// ---------- Erholung ----------

export function recovery(data, ctx) {
  const range = ctx.periods.cur;
  const days = A.dateRange(range.from, range.to);
  const t = theme();
  const byDate = (list) => new Map((list || []).filter((x) => inRange(x.date, range)).map((x) => [x.date, x]));
  const hrv = byDate(data.hrv);
  const sleep = byDate(data.sleep);
  const bb = byDate(data.bodyBattery);
  const stress = byDate(data.stress);
  const rhrAll = A.restingSeries(data);
  const rhr = new Map(rhrAll.map((r) => [r.date, r.restingHR]));
  const rhrRoll = new Map();
  rhrAll.forEach((r, i) => rhrRoll.set(r.date, A.mean(rhrAll.slice(Math.max(0, i - 6), i + 1).map((x) => x.restingHR))));
  const hasHrv = [...hrv.values()].some((h) => h.lastNight !== null);
  const hasBand = [...hrv.values()].some((h) => h.baselineLow !== null);
  const hasRhr = days.some((d) => rhr.has(d));
  const hasSleep = [...sleep.values()].some((s) => s.sleepSeconds !== null);
  const hasStages = [...sleep.values()].some((s) => s.deep !== null);
  const hasScore = [...sleep.values()].some((s) => s.score !== null);
  const hasBB = [...bb.values()].some((x) => x.high !== null);
  const hasStress = [...stress.values()].some((x) => x.level !== null);
  const labels = days.map(shortDate);

  const html = `
    ${verdictCard(ctx.recovery)}
    ${missingBox('Training Readiness nicht verfügbar', 'Garmins Training-Readiness-Wert, Trainingsstatus und Erholungszeit sind in der Personal API nicht enthalten (keine dokumentierten Endpunkte). Der Check oben wird transparent aus HRV, Ruhepuls, Schlaf, Body Battery und deiner Belastung berechnet.')}
    <div class="grid two">
      ${hasHrv ? chartCard({ id: 'rc-hrv', title: 'HRV (nächtlicher Durchschnitt)', subtitle: 'ms; Band = Garmins persönlicher Normalbereich', legend: legendHtml([{ label: 'Letzte Nacht', color: t.series[0], kind: 'line' }, { label: '7-Tage-Ø (Garmin)', color: t.series[1], kind: 'line' }, ...(hasBand ? [{ label: 'Normalbereich', color: t.band, kind: 'band' }] : [])]), foot: 'Werte unterhalb des Bandes deuten auf Stress, Ermüdung oder Krankheit hin. Entscheidend ist der Trend über mehrere Tage, nicht eine einzelne Nacht.' }) : missingBox('HRV', sourceHint(data, 'hrv', ['lastNight']) || 'Keine HRV-Daten im Zeitraum.')}
      ${hasRhr ? chartCard({ id: 'rc-rhr', title: 'Ruhepuls', subtitle: 'bpm', legend: legendHtml([{ label: 'Tageswert', color: t.series[0], kind: 'line' }, { label: '7-Tage-Ø', color: t.series[1], kind: 'line' }]), foot: 'Ein Anstieg um 3–5 bpm über mehrere Tage ist ein frühes Ermüdungssignal.' }) : missingBox('Ruhepuls', sourceHint(data, 'dailies', ['restingHR']) || 'Kein Ruhepuls im Zeitraum.')}
      ${hasSleep ? chartCard({ id: 'rc-sleep', title: 'Schlafdauer', subtitle: hasStages ? 'Stunden nach Schlafphase' : 'Stunden', legend: hasStages ? legendHtml(['Tiefschlaf', 'Leichtschlaf', 'REM', 'Wach'].map((l, i) => ({ label: l, color: t.series[i] }))) : '' }) : missingBox('Schlaf', sourceHint(data, 'sleep', ['sleepSeconds']) || 'Keine Schlafdaten im Zeitraum.')}
      ${hasScore ? chartCard({ id: 'rc-score', title: 'Schlaf-Score', subtitle: '0–100 (Garmin)' }) : missingBox('Schlaf-Score', sourceHint(data, 'sleep', ['score']) || 'Kein Schlaf-Score im Zeitraum.')}
      ${hasBB ? chartCard({ id: 'rc-bb', title: 'Body Battery', subtitle: 'Tagesspanne Tiefst- bis Höchstwert' }) : missingBox('Body Battery', sourceHint(data, 'bodyBattery', ['high']) || 'Keine Body-Battery-Daten.')}
      ${hasStress ? chartCard({ id: 'rc-stress', title: 'Stress', subtitle: 'Tagesdurchschnitt 0–100 (Garmin)' }) : missingBox('Stress', sourceHint(data, 'stress', ['level']) || 'Keine Stressdaten.')}
    </div>`;

  const after = () => {
    if (hasHrv) {
      const ds = [];
      if (hasBand) {
        ds.push(lineDs('Normalbereich unten', days.map((d) => hrv.get(d)?.baselineLow ?? null), 'transparent', { pointHoverRadius: 0, tension: 0 }));
        ds.push(lineDs('Normalbereich oben', days.map((d) => hrv.get(d)?.baselineHigh ?? null), 'transparent', { fill: '-1', backgroundColor: t.band, pointHoverRadius: 0, tension: 0 }));
      }
      ds.push(lineDs('Letzte Nacht', days.map((d) => hrv.get(d)?.lastNight ?? null), t.series[0], { pointRadius: ctx.days <= 31 ? 3 : 0 }));
      ds.push(lineDs('7-Tage-Ø', days.map((d) => hrv.get(d)?.weekly ?? null), t.series[1]));
      renderChart('rc-hrv', {
        type: 'line', labels, datasets: ds, options: { yFormat: (v) => `${v}` },
        table: { columns: [{ label: 'Datum' }, { label: 'Nacht', num: true }, { label: '7-T-Ø', num: true }, { label: 'Band', num: true }, { label: 'Status' }], rows: days.filter((d) => hrv.has(d)).map((d) => { const h = hrv.get(d); return [d, h.lastNight, h.weekly, h.baselineLow ? `${h.baselineLow}–${h.baselineHigh}` : null, h.status ? A.hrvStatusLabel(h.status) : null]; }) },
      });
    }
    if (hasRhr) {
      renderChart('rc-rhr', {
        type: 'line', labels,
        datasets: [lineDs('Ruhepuls', days.map((d) => rhr.get(d) ?? null), t.series[0], { pointRadius: ctx.days <= 31 ? 3 : 0 }), lineDs('7-Tage-Ø', days.map((d) => rhrRoll.get(d) ?? null), t.series[1])],
        table: { columns: [{ label: 'Datum' }, { label: 'Ruhepuls', num: true }], rows: days.filter((d) => rhr.has(d)).map((d) => [d, rhr.get(d)]) },
      });
    }
    if (hasSleep) {
      const h = (v) => (v === null || v === undefined ? null : v / 3600);
      const datasets = hasStages
        ? [['Tiefschlaf', 'deep'], ['Leichtschlaf', 'light'], ['REM', 'rem'], ['Wach', 'awake']].map(([l, k], i) => barDs(l, days.map((d) => h(sleep.get(d)?.[k])), t.series[i]))
        : [barDs('Schlaf', days.map((d) => h(sleep.get(d)?.sleepSeconds)), t.series[0])];
      renderChart('rc-sleep', {
        type: 'bar', labels, datasets, options: { stacked: true, yFormat: (v) => `${v} h` },
        extra: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${A.fmtHours(c.parsed.y)}` } } } },
        table: { columns: [{ label: 'Datum' }, { label: 'Schlaf', num: true }, { label: 'Tief', num: true }, { label: 'Leicht', num: true }, { label: 'REM', num: true }, { label: 'Wach', num: true }], rows: days.filter((d) => sleep.has(d)).map((d) => { const s = sleep.get(d); return [d, A.fmtHours(h(s.sleepSeconds)), A.fmtHours(h(s.deep)), A.fmtHours(h(s.light)), A.fmtHours(h(s.rem)), A.fmtHours(h(s.awake))]; }) },
      });
    }
    if (hasScore) {
      renderChart('rc-score', {
        type: 'line', labels, datasets: [lineDs('Schlaf-Score', days.map((d) => sleep.get(d)?.score ?? null), t.series[0], { pointRadius: ctx.days <= 31 ? 3 : 0 })],
        extra: { scales: { y: { suggestedMin: 40, suggestedMax: 100 } } },
        table: { columns: [{ label: 'Datum' }, { label: 'Score', num: true }], rows: days.filter((d) => sleep.get(d)?.score !== undefined && sleep.get(d)?.score !== null).map((d) => [d, sleep.get(d).score]) },
      });
    }
    if (hasBB) {
      renderChart('rc-bb', {
        type: 'bar', labels, datasets: [barDs('Body Battery', days.map((d) => (bb.get(d)?.high !== null && bb.get(d) ? [bb.get(d).low, bb.get(d).high] : null)), t.series[0], { borderSkipped: false })],
        extra: { scales: { y: { min: 0, max: 100 } }, plugins: { tooltip: { callbacks: { label: (c) => (c.raw ? `Tief ${c.raw[0]} · Hoch ${c.raw[1]}` : '') } } } },
        table: { columns: [{ label: 'Datum' }, { label: 'Tief', num: true }, { label: 'Hoch', num: true }, { label: 'Geladen', num: true }, { label: 'Verbraucht', num: true }], rows: days.filter((d) => bb.has(d)).map((d) => { const x = bb.get(d); return [d, x.low, x.high, x.charged, x.drained]; }) },
      });
    }
    if (hasStress) {
      renderChart('rc-stress', {
        type: 'bar', labels, datasets: [barDs('Stress', days.map((d) => stress.get(d)?.level ?? null), t.series[0])],
        extra: { scales: { y: { min: 0, suggestedMax: 60 } } },
        table: { columns: [{ label: 'Datum' }, { label: 'Ø Stress', num: true }], rows: days.filter((d) => stress.has(d)).map((d) => [d, stress.get(d).level]) },
      });
    }
  };
  return { html, after };
}

// ---------- Belastung ----------

export function load(data, ctx) {
  const t = theme();
  const range = ctx.periods.cur;
  const series = ctx.load.series.filter((s) => inRange(s.date, range));
  const labels = series.map((s) => shortDate(s.date));
  const has = ctx.model.key !== 'none' && series.some((s) => s.load > 0);
  const { cur, prev } = ctx.summary;
  const dist = [cur.intensity, prev.intensity];
  const teLabels = new Map();
  for (const a of cur.activities) if (a.teLabel) teLabels.set(a.teLabel, (teLabels.get(a.teLabel) || 0) + 1);
  const teScatter = cur.activities.filter((a) => a.teAerobic !== null);
  const last = ctx.load.series.at(-1);

  const html = `
    <section class="card"><div class="card-head"><div><h2>Belastungsmodell</h2><p>${esc(ctx.model.label)}</p></div></div>
      <p class="card-foot">${esc(ctx.model.note)}${ctx.load.missing ? ` ${ctx.load.missing} Aktivitäten ohne berechenbare Belastung (fehlende HF) zählen mit 0.` : ''} Akut = 7-Tage-, chronisch = 42-Tage-Durchschnitt (exponentiell gewichtet).</p>
      ${last && last.warm ? `<div class="tiles">${tile('Akut (Ermüdung)', fmt(last.atl, 0))}${tile('Chronisch (Fitness)', fmt(last.ctl, 0))}${tile('Form (chron. − akut)', fmt(last.tsb, 0))}${tile('ACWR', last.acwr !== null ? fmt(last.acwr, 2) : '–')}</div>` : ''}
    </section>
    <div class="grid two">
      ${has ? chartCard({ id: 'ld-daily', title: 'Tagesbelastung & Trend', span: true, tall: true, legend: legendHtml([{ label: 'Tagesbelastung', color: t.series[0] }, { label: 'Akut (7 T)', color: t.series[1], kind: 'line' }, { label: 'Chronisch (42 T)', color: t.series[2], kind: 'line' }]), foot: 'Steigt die chronische Linie langsam, baust du Fitness auf. Liegt die akute weit darüber, sammelt sich Ermüdung an.' }) : missingBox('Belastung', esc(ctx.model.note))}
      ${has ? chartCard({ id: 'ld-acwr', title: 'Akut/chronisch-Verhältnis (ACWR)', subtitle: 'Band = 0,8–1,3', foot: 'Über 1,5: steiler Belastungssprung, erhöhtes Verletzungsrisiko. Unter 0,8: Entlastung oder Trainingspause.' }) : ''}
      ${has ? chartCard({ id: 'ld-form', title: 'Form', subtitle: 'chronisch − akut', foot: 'Deutlich negativ = viel frische Ermüdung (Aufbauphase). Positiv = erholt, z. B. vor Wettkämpfen.' }) : ''}
      ${dist[0] || dist[1] ? chartCard({ id: 'ld-dist', title: 'Intensitätsverteilung', subtitle: esc((dist[0] || dist[1]).method), legend: legendHtml([{ label: 'Niedrig', color: t.ordinal[0] }, { label: 'Mittel', color: t.ordinal[1] }, { label: 'Hoch', color: t.ordinal[2] }]), foot: 'Gängige Empfehlung für Ausdauersport: ~75–80 % niedrig, wenig mittel, gezielt hoch (polarisiert).' }) : missingBox('Intensitätsverteilung', 'Keine Ausdauereinheiten mit Herzfrequenz im Zeitraum.')}
      ${teLabels.size ? chartCard({ id: 'ld-te', title: 'Garmin-Trainingseffekt (Hauptnutzen)', subtitle: 'Anzahl Einheiten' }) : teScatter.length ? chartCard({ id: 'ld-te2', title: 'Trainingseffekt aerob vs. anaerob', subtitle: 'Garmin-Skala 0–5, pro Einheit' }) : missingBox('Garmin-Trainingseffekt', sourceHint(data, 'activities', ['teAerobic', 'teLabel']) || 'Keine Trainingseffekt-Werte im Zeitraum.')}
      ${has ? calendarCard(ctx) : ''}
    </div>`;

  const after = () => {
    if (has) {
      renderChart('ld-daily', {
        type: 'bar', labels,
        datasets: [barDs('Tagesbelastung', series.map((s) => s.load), t.series[0], { order: 2 }), lineDs('Akut', series.map((s) => s.atl), t.series[1], { order: 1 }), lineDs('Chronisch', series.map((s) => s.ctl), t.series[2], { order: 0 })],
        extra: { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, 0)}` } } } },
        table: { columns: [{ label: 'Datum' }, { label: 'Belastung', num: true }, { label: 'Akut', num: true }, { label: 'Chronisch', num: true }, { label: 'Form', num: true }], rows: series.map((s) => [s.date, fmt(s.load), fmt(s.atl), fmt(s.ctl), fmt(s.tsb)]) },
      });
      renderChart('ld-acwr', {
        type: 'line', labels,
        datasets: [lineDs('0,8', series.map(() => 0.8), 'transparent', { pointHoverRadius: 0 }), lineDs('1,3', series.map(() => 1.3), 'transparent', { fill: '-1', backgroundColor: t.band, pointHoverRadius: 0 }), lineDs('ACWR', series.map((s) => s.acwr), t.series[0])],
        extra: { plugins: { tooltip: { filter: (i) => i.dataset.label === 'ACWR', callbacks: { label: (c) => `ACWR ${fmt(c.parsed.y, 2)}` } } }, scales: { y: { suggestedMin: 0.4, suggestedMax: 1.8 } } },
        table: { columns: [{ label: 'Datum' }, { label: 'ACWR', num: true }], rows: series.map((s) => [s.date, s.acwr !== null ? fmt(s.acwr, 2) : null]) },
      });
      renderChart('ld-form', {
        type: 'line', labels, datasets: [lineDs('Form', series.map((s) => s.tsb), t.series[0], { fill: 'origin', backgroundColor: t.band })],
        table: { columns: [{ label: 'Datum' }, { label: 'Form', num: true }], rows: series.map((s) => [s.date, fmt(s.tsb)]) },
      });
    }
    if (dist[0] || dist[1]) {
      const rows = [['Aktuell', dist[0]], ['Vorzeitraum', dist[1]]];
      renderChart('ld-dist', {
        type: 'bar', labels: rows.map((r) => r[0]),
        datasets: [['Niedrig', 'low', 0], ['Mittel', 'mod', 1], ['Hoch', 'high', 2]].map(([l, k, i]) => barDs(l, rows.map((r) => (r[1] ? r[1][k] * 100 : null)), t.ordinal[i], { borderSkipped: false, borderWidth: { left: 0, right: 2, top: 0, bottom: 0 }, maxBarThickness: 34 })),
        options: { stacked: true },
        extra: { indexAxis: 'y', scales: { x: { type: 'linear',  min: 0, max: 100, grid: { display: true, color: t.grid }, ticks: { callback: (v) => `${v} %` } }, y: { type: 'category', grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.x, 0)} %` } } } },
        table: { columns: [{ label: 'Zeitraum' }, { label: 'Niedrig', num: true }, { label: 'Mittel', num: true }, { label: 'Hoch', num: true }], rows: rows.map(([n, d]) => [n, d ? `${fmt(d.low * 100)} %` : null, d ? `${fmt(d.mod * 100)} %` : null, d ? `${fmt(d.high * 100)} %` : null]) },
      });
    }
    if (teLabels.size) {
      const entries = [...teLabels.entries()].sort((a, b) => b[1] - a[1]);
      renderChart('ld-te', {
        type: 'bar', labels: entries.map(([k]) => A.GARMIN_LABELS[k] || k), datasets: [barDs('Einheiten', entries.map(([, v]) => v), t.series[0], { borderSkipped: 'start' })],
        extra: { indexAxis: 'y', scales: { x: { type: 'linear',  grid: { display: true, color: t.grid }, ticks: { precision: 0 } }, y: { type: 'category', grid: { display: false } } } },
        table: { columns: [{ label: 'Trainingseffekt' }, { label: 'Einheiten', num: true }], rows: entries.map(([k, v]) => [A.GARMIN_LABELS[k] || k, v]) },
      });
    } else if (teScatter.length) {
      renderChart('ld-te2', {
        type: 'scatter', datasets: [{ label: 'Einheit', data: teScatter.map((a) => ({ x: a.teAerobic, y: a.teAnaerobic ?? 0, name: a.name, date: a.date })), backgroundColor: t.series[0], borderColor: t.surface, borderWidth: 2, pointRadius: 5, pointHoverRadius: 7 }],
        options: { xType: 'linear' },
        extra: { scales: { x: { min: 0, max: 5, title: { display: true, text: 'aerob', color: t.muted } }, y: { min: 0, max: 5, title: { display: true, text: 'anaerob', color: t.muted } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.raw.date} ${c.raw.name || ''}: aerob ${c.raw.x} · anaerob ${c.raw.y}` } } } },
        table: { columns: [{ label: 'Datum' }, { label: 'Einheit' }, { label: 'Aerob', num: true }, { label: 'Anaerob', num: true }], rows: teScatter.map((a) => [a.date, a.name, a.teAerobic, a.teAnaerobic]) },
      });
    }
  };
  return { html, after };
}

function calendarCard(ctx) {
  const to = ctx.periods.cur.to;
  const from = A.addDays(A.weekStart(A.addDays(to, -(Math.min(ctx.days, 182) - 1))), 0);
  const days = A.dateRange(from, to);
  const loads = new Map(ctx.load.series.map((s) => [s.date, s.load]));
  const positive = days.map((d) => loads.get(d) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => positive[Math.floor(p * (positive.length - 1))] ?? 0;
  const [q1, q2] = [q(0.33), q(0.66)];
  const t = theme();
  const level = (v) => (!v ? null : v <= q1 ? 0 : v <= q2 ? 1 : 2);
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const cells = weeks
    .map((w) => `<div class="cal-col">${w.map((d) => { const l = level(loads.get(d)); return `<span class="cal-cell" title="${d}: ${fmt(loads.get(d) || 0)}" ${l === null ? '' : `data-swatch="${t.ordinal[l]}"`}></span>`; }).join('')}</div>`)
    .join('');
  return `<section class="card"><div class="card-head"><div><h2>Trainingskalender</h2><p>Spalten = Wochen, Zeilen = Mo–So; Farbe = Belastungs-Drittel</p></div></div>
    ${legendHtml([{ label: 'leicht', color: t.ordinal[0] }, { label: 'mittel', color: t.ordinal[1] }, { label: 'hoch', color: t.ordinal[2] }, { label: 'Ruhetag', color: t.grid }])}
    <div class="cal">${cells}</div></section>`;
}

// ---------- Leistung ----------

export function performance(data, ctx, state) {
  const t = theme();
  const { cur: rc, prev: rp } = ctx.periods;
  const sport = state.perfSport || 'running';
  const pick = (r) => data.activities.filter((a) => inRange(a.date, r) && A.sportGroup(a.type) === sport && a.avgSpeed);
  const curActs = pick(rc);
  const prevActs = pick(rp);
  const hasRides = data.activities.some((a) => A.sportGroup(a.type) === 'cycling');
  const selector = `<div class="select-row"><label class="small muted" for="perf-sport">Sportart</label><select id="perf-sport">
    <option value="running"${sport === 'running' ? ' selected' : ''}>Laufen</option>${hasRides ? `<option value="cycling"${sport === 'cycling' ? ' selected' : ''}>Rad</option>` : ''}</select></div>`;
  if (!curActs.length && !prevActs.length) return { html: selector + missingBox('Keine Daten', `Keine ${sport === 'running' ? 'Läufe' : 'Radfahrten'} mit Geschwindigkeit im Zeitraum.`), after: () => {} };
  return sport === 'running' ? runningView(data, ctx, curActs, prevActs, selector, t) : cyclingView(data, ctx, curActs, prevActs, selector, t);
}

function runningView(data, ctx, curRuns, prevRuns, selector, t) {
  const mCur = curRuns.map((a) => ({ a, m: A.runMetrics(a) })).filter((x) => x.m);
  const mPrev = prevRuns.map((a) => ({ a, m: A.runMetrics(a) })).filter((x) => x.m);
  const avgPace = (xs) => { const d = A.sum(xs.map((x) => x.a.distance)); const s = A.sum(xs.map((x) => x.a.movingDuration ?? x.a.duration)); return d > 0 ? s / (d / 1000) : null; };
  const pc = avgPace(mCur), pp = avgPace(mPrev);
  const { cur, prev } = ctx.summary;
  const pr = ctx.paceRef;
  const vo2 = data.activities.filter((a) => a.vo2max !== null && A.sportGroup(a.type) === 'running');
  const vo2Latest = vo2.at(-1)?.vo2max ?? data.profile?.vo2MaxRunning ?? null;
  const hrRuns = (xs) => xs.filter((x) => x.a.avgHR && x.m.minutes >= 10);
  const scCur = hrRuns(mCur), scPrev = hrRuns(mPrev);
  const fitCur = A.linreg(scCur.map((x) => x.m.paceSec), scCur.map((x) => x.a.avgHR));
  const fitPrev = A.linreg(scPrev.map((x) => x.m.paceSec), scPrev.map((x) => x.a.avgHR));
  const rangeStart = A.daysBetween('1970-01-01', ctx.periods.prev.from);

  const tiles = [
    tile('Ø Pace', pc ? `${A.fmtPace(pc)} /km` : '–', deltaHtml(pc, pp, { better: 'down', asPace: true })),
    cur.ef !== null ? tile('Effizienz', `${fmt(cur.ef, 2)} m/Schlag`, deltaHtml(cur.ef, prev.ef, { better: 'up', digits: 2 })) : tile('Effizienz', 'zu wenige Läufe mit HF', '', true),
    pr?.cur?.value ? tile(`Pace bei ${pr.refHR} bpm`, `${A.fmtPace(pr.cur.value)} /km`, deltaHtml(pr.cur.value, pr.prev?.value ?? null, { better: 'down', asPace: true })) : tile('Pace bei Referenz-HF', esc(pr?.cur?.reason || 'keine HF-Daten'), '', true),
    vo2Latest !== null ? tile('VO2max', fmt(vo2Latest, 0), vo2.length ? '<div class="tile-delta">aus Aktivitätsdaten</div>' : '<div class="tile-delta">aus Profil</div>') : tile('VO2max', 'nicht in den API-Daten', '', true),
  ].join('');

  const html = `${selector}
    <div class="tiles">${tiles}</div>
    <p class="card-foot">Effizienz = Meter pro Herzschlag (Geschwindigkeit ÷ Ø-HF), berechnet aus ${esc(cur.efBasis)}. Steigt sie, wird dein aerobes System ökonomischer.</p>
    <div class="grid two">
      ${scCur.length + scPrev.length >= 3 ? chartCard({ id: 'pf-hrpace', title: 'Herzfrequenz im Verhältnis zur Pace', subtitle: 'jeder Punkt = ein Lauf; Linien = Regression', span: true, tall: true, legend: legendHtml([{ label: `Aktuell (${scCur.length})`, color: t.series[0] }, { label: `Vorzeitraum (${scPrev.length})`, color: t.series[1] }]), foot: hrPaceText(fitCur, fitPrev, pr) }) : missingBox('HF vs. Pace', 'Zu wenige Läufe mit Herzfrequenz für eine Analyse.')}
      ${chartCard({ id: 'pf-pace', title: 'Pace-Entwicklung', subtitle: 'min/km pro Lauf; Linie = gleitender Ø über 5 Läufe' })}
      ${scCur.length + scPrev.length >= 2 ? chartCard({ id: 'pf-ef', title: 'Effizienz-Entwicklung', subtitle: 'Meter pro Herzschlag; Linie = gleitender Ø über 5 Läufe' }) : ''}
      ${vo2.length >= 2 ? chartCard({ id: 'pf-vo2', title: 'VO2max (Garmin, aus Aktivitäten)', subtitle: 'ml/kg/min' }) : missingBox('VO2max-Verlauf', 'Garmins VO2max-Verlauf (Max-Metriken) ist über die Personal API nicht abrufbar. ' + (vo2.length ? 'Nur ein Einzelwert in den Aktivitäten.' : 'Auch die Aktivitäten enthalten kein VO2max-Feld.'))}
    </div>`;

  const after = () => {
    const all = [...mPrev, ...mCur].sort((x, y) => x.a.start.localeCompare(y.a.start));
    const xOf = (a) => A.daysBetween('1970-01-01', a.date) - rangeStart;
    const xFmt = (v) => shortDate(A.addDays(ctx.periods.prev.from, Math.round(v)));
    const curStartX = A.daysBetween(ctx.periods.prev.from, ctx.periods.cur.from);
    const pt = (x, m) => ({ x: xOf(x.a), y: m, name: x.a.name, date: x.a.date });
    const roll = (vals) => A.rollingMean(vals, 5);
    const scatter = (label, data, color) => ({ type: 'scatter', label, data, backgroundColor: color, borderColor: t.surface, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6 });

    const paceVals = roll(all.map((x) => x.m.paceSec));
    renderChart('pf-pace', {
      type: 'scatter',
      datasets: [scatter('Lauf', all.map((x) => pt(x, x.m.paceSec)), t.series[0]), { ...lineDs('Ø 5 Läufe', all.map((x, i) => ({ x: xOf(x.a), y: paceVals[i] })), t.series[1]), type: 'line' }],
      options: { xType: 'linear', yReverse: true, yFormat: (v) => A.fmtPace(v), xFormat: xFmt },
      extra: { scales: { x: { min: 0, max: A.daysBetween(ctx.periods.prev.from, ctx.periods.cur.to) } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.raw.date || ''} ${c.raw.name || ''}: ${A.fmtPace(c.parsed.y)} /km` } } } },
      plugins: [periodMarker(curStartX, t)],
      table: { columns: [{ label: 'Datum' }, { label: 'Lauf' }, { label: 'km', num: true }, { label: 'Pace', num: true }, { label: 'Ø-HF', num: true }], rows: all.map((x) => [x.a.date, x.a.name, fmt(x.a.distance / 1000, 1), A.fmtPace(x.m.paceSec), x.a.avgHR]) },
    });

    const efAll = all.filter((x) => x.m.ef);
    if (efAll.length >= 2) {
      const efRoll = roll(efAll.map((x) => x.m.ef));
      renderChart('pf-ef', {
        type: 'scatter',
        datasets: [scatter('Lauf', efAll.map((x) => pt(x, x.m.ef)), t.series[0]), { ...lineDs('Ø 5 Läufe', efAll.map((x, i) => ({ x: xOf(x.a), y: efRoll[i] })), t.series[1]), type: 'line' }],
        options: { xType: 'linear', xFormat: xFmt, yFormat: (v) => fmt(v, 2) },
        extra: { scales: { x: { min: 0, max: A.daysBetween(ctx.periods.prev.from, ctx.periods.cur.to) } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.raw.date || ''} ${c.raw.name || ''}: ${fmt(c.parsed.y, 2)} m/Schlag` } } } },
        plugins: [periodMarker(curStartX, t)],
        table: { columns: [{ label: 'Datum' }, { label: 'Lauf' }, { label: 'm/Schlag', num: true }], rows: efAll.map((x) => [x.a.date, x.a.name, fmt(x.m.ef, 2)]) },
      });
    }

    if (scCur.length + scPrev.length >= 3) {
      const paces = [...scCur, ...scPrev].map((x) => x.m.paceSec);
      const [lo, hi] = [Math.min(...paces), Math.max(...paces)];
      const fitLine = (fit, label, color) => (fit && fit.n >= 3 ? [{ type: 'line', label, data: [{ x: lo, y: fit.intercept + fit.slope * lo }, { x: hi, y: fit.intercept + fit.slope * hi }], borderColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 0 }] : []);
      const p = (x) => ({ x: x.m.paceSec, y: x.a.avgHR, name: x.a.name, date: x.a.date });
      renderChart('pf-hrpace', {
        type: 'scatter',
        datasets: [scatter('Aktuell', scCur.map(p), t.series[0]), scatter('Vorzeitraum', scPrev.map(p), t.series[1]), ...fitLine(fitCur, 'Trend aktuell', t.series[0]), ...fitLine(fitPrev, 'Trend Vorzeitraum', t.series[1])],
        options: { xType: 'linear', xFormat: (v) => A.fmtPace(v) },
        extra: { scales: { x: { reverse: true, title: { display: true, text: 'Pace (min/km) – rechts = schneller', color: t.muted, font: { size: 11 } } }, y: { title: { display: true, text: 'Ø-HF (bpm)', color: t.muted, font: { size: 11 } } } }, plugins: { tooltip: { filter: (i) => i.dataset.type !== 'line', callbacks: { label: (c) => `${c.raw.date} ${c.raw.name || ''}: ${A.fmtPace(c.raw.x)} /km bei ${c.raw.y} bpm` } } } },
        table: { columns: [{ label: 'Zeitraum' }, { label: 'Datum' }, { label: 'Pace', num: true }, { label: 'Ø-HF', num: true }], rows: [...scCur.map((x) => ['aktuell', x.a.date, A.fmtPace(x.m.paceSec), x.a.avgHR]), ...scPrev.map((x) => ['vorher', x.a.date, A.fmtPace(x.m.paceSec), x.a.avgHR])] },
      });
    }

    if (vo2.length >= 2) {
      renderChart('pf-vo2', {
        type: 'line', labels: vo2.map((a) => shortDate(a.date)), datasets: [lineDs('VO2max', vo2.map((a) => a.vo2max), t.series[0], { pointRadius: 3, tension: 0 })],
        table: { columns: [{ label: 'Datum' }, { label: 'VO2max', num: true }], rows: vo2.map((a) => [a.date, a.vo2max]) },
      });
    }
  };
  return { html, after };
}

function hrPaceText(fitCur, fitPrev, pr) {
  const parts = [];
  if (fitCur && fitCur.slope < 0) parts.push(`Aktuell kostet dich 10 s/km schneller etwa ${fmt(Math.abs(fitCur.slope * 10), 1)} bpm mehr (R² ${fmt(fitCur.r2, 2)}).`);
  if (pr?.cur?.value && pr?.prev?.value) {
    const d = pr.prev.value - pr.cur.value;
    parts.push(`Bei ${pr.refHR} bpm läufst du ${A.fmtPace(Math.abs(d))} /km ${d > 0 ? 'schneller' : 'langsamer'} als im Vorzeitraum.`);
  }
  parts.push('Liegt die blaue Linie unter der orangen, brauchst du für dasselbe Tempo weniger Puls – ein Fitnessgewinn. Hitze, Höhenmeter und Ermüdung verschieben die Punkte ebenfalls.');
  return parts.map(esc).join(' ');
}

function cyclingView(data, ctx, curRides, prevRides, selector, t) {
  const withPower = [...prevRides, ...curRides].filter((a) => (a.normPower || a.avgPower) && a.avgHR);
  const speedAvg = (xs) => { const d = A.sum(xs.map((a) => a.distance)); const s = A.sum(xs.map((a) => a.movingDuration ?? a.duration)); return s > 0 ? (d / s) * 3.6 : null; };
  const efOf = (a) => (a.normPower || a.avgPower) / a.avgHR;
  const efCur = A.mean(curRides.filter((a) => (a.normPower || a.avgPower) && a.avgHR).map(efOf));
  const efPrev = A.mean(prevRides.filter((a) => (a.normPower || a.avgPower) && a.avgHR).map(efOf));
  const tiles = [
    tile('Ø Geschwindigkeit', `${fmt(speedAvg(curRides), 1)} km/h`, deltaHtml(speedAvg(curRides), speedAvg(prevRides), { better: 'up', digits: 1, unit: ' km/h' })),
    efCur !== null ? tile('Leistung pro Herzschlag', `${fmt(efCur, 2)} W/bpm`, deltaHtml(efCur, efPrev, { better: 'up', digits: 2 })) : tile('Leistung pro Herzschlag', 'keine Leistungsdaten', '', true),
  ].join('');
  const html = `${selector}<div class="tiles">${tiles}</div>
    <div class="grid two">${withPower.length >= 2 ? chartCard({ id: 'pf-cyc-ef', title: 'Leistung pro Herzschlag', subtitle: '(NP oder Ø-Leistung) ÷ Ø-HF pro Fahrt', foot: 'Steigende Werte bei vergleichbaren Fahrten zeigen eine bessere aerobe Fitness.' }) : missingBox('Leistung/HF', 'Keine Fahrten mit Leistungsmesser und HF – Speed hängt auf dem Rad zu stark von Gelände und Wind ab, daher keine Effizienz aus Geschwindigkeit.')}</div>`;
  const after = () => {
    if (withPower.length < 2) return;
    renderChart('pf-cyc-ef', {
      type: 'line', labels: withPower.map((a) => shortDate(a.date)), datasets: [lineDs('W/bpm', withPower.map(efOf), t.series[0], { pointRadius: 3 })],
      table: { columns: [{ label: 'Datum' }, { label: 'Fahrt' }, { label: 'W', num: true }, { label: 'Ø-HF', num: true }, { label: 'W/bpm', num: true }], rows: withPower.map((a) => [a.date, a.name, a.normPower || a.avgPower, a.avgHR, fmt(efOf(a), 2)]) },
    });
  };
  return { html, after };
}

function periodMarker(x, t) {
  return {
    id: 'periodMarker',
    afterDatasetsDraw(chart) {
      const sx = chart.scales.x;
      const px = sx.getPixelForValue(x);
      const { top, bottom } = chart.chartArea;
      const c = chart.ctx;
      c.save();
      c.strokeStyle = t.axis;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(px, top);
      c.lineTo(px, bottom);
      c.stroke();
      c.fillStyle = t.muted;
      c.font = '11px system-ui, sans-serif';
      c.fillText('aktueller Zeitraum →', px + 4, top + 10);
      c.restore();
    },
  };
}

// ---------- Einheiten ----------

export function sessions(data, ctx, state) {
  const t = theme();
  const { cur, prev } = ctx.summary;
  const endurance = (xs) => xs.filter((a) => A.isEndurance(A.sportGroup(a.type)));
  const cats = (xs) => {
    const m = new Map();
    for (const a of endurance(xs)) {
      const { key } = A.classifySession(a, data.hrZones);
      const e = m.get(key) || { n: 0, h: 0 };
      e.n++;
      e.h += (a.duration || 0) / 3600;
      m.set(key, e);
    }
    return m;
  };
  const cc = cats(cur.activities), cp = cats(prev.activities);
  const keys = A.CATEGORIES.map((c) => c.key).filter((k) => cc.has(k) || cp.has(k));
  const filter = state.sessionSport || 'all';
  const groupsPresent = [...new Set(cur.activities.map((a) => A.sportGroup(a.type)))];
  const list = cur.activities.filter((a) => filter === 'all' || A.sportGroup(a.type) === filter).slice().reverse();
  const b = buckets(ctx.periods.cur, ctx.days);
  const method = endurance(cur.activities).find((a) => a.hrZones) ? 'Zeit in HF-Zonen' : 'Ø-HF in deinen HF-Zonen';

  const html = `
    <section class="card"><div class="card-head"><div><h2>So werden Einheiten eingeordnet</h2><p>Eigene Kategorisierung (${esc(method)}); Garmins Trainingseffekt-Label wird zusätzlich angezeigt, wenn vorhanden.</p></div></div>
      <p class="card-foot">Regeneration: überwiegend Z1, &lt; 60 min · Grundlage: Z1–2 · Lang: locker und ≥ 90 min Lauf / ≥ 3 h Rad · Tempo: ≥ 30 % in Z3 · Schwelle: ≥ 20 % in Z4 · Intervall/VO2max: ≥ 10 % in Z5. Ohne Zonenzeiten entscheidet die Zone der Ø-HF (bei Intervallen ungenauer).</p></section>
    <div class="grid two">
      ${keys.length ? chartCard({ id: 'ss-cats', title: 'Ausdauereinheiten nach Kategorie', subtitle: 'Stunden', legend: legendHtml([{ label: 'Aktuell', color: t.series[0] }, { label: 'Vorzeitraum', color: t.series[1] }]) }) : missingBox('Kategorien', 'Keine Ausdauereinheiten im Zeitraum.')}
      ${keys.length ? chartCard({ id: 'ss-catweeks', title: `Kategorien pro ${b.unit}`, subtitle: 'Anzahl Einheiten', legend: legendHtml(keys.map((k) => ({ label: A.categoryLabel(k), color: categoryColor(k) }))) }) : ''}
    </div>
    <h2 class="section-title">Einheiten im Zeitraum (${list.length})</h2>
    <div class="select-row"><label class="small muted" for="session-sport">Sportart</label><select id="session-sport"><option value="all">Alle</option>${groupsPresent.map((g) => `<option value="${g}"${filter === g ? ' selected' : ''}>${esc(A.SPORTS[g])}</option>`).join('')}</select></div>
    <ul class="acts">${list.map((a) => activityItem(a, data)).join('') || '<li class="missing-box">Keine Einheiten.</li>'}</ul>`;

  const after = () => {
    if (!keys.length) return;
    renderChart('ss-cats', {
      type: 'bar', labels: keys.map(A.categoryLabel),
      datasets: [barDs('Aktuell', keys.map((k) => cc.get(k)?.h ?? 0), t.series[0]), barDs('Vorzeitraum', keys.map((k) => cp.get(k)?.h ?? 0), t.series[1])],
      extra: { indexAxis: 'y', scales: { x: { type: 'linear',  grid: { display: true, color: t.grid }, ticks: { callback: (v) => `${v} h` } }, y: { type: 'category', grid: { display: false } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${A.fmtHours(c.parsed.x)} (${(c.datasetIndex ? cp : cc).get(keys[c.dataIndex])?.n ?? 0} Einheiten)` } } } },
      table: { columns: [{ label: 'Kategorie' }, { label: 'Aktuell h', num: true }, { label: 'Anzahl', num: true }, { label: 'Vorher h', num: true }, { label: 'Anzahl', num: true }], rows: keys.map((k) => [A.categoryLabel(k), A.fmtHours(cc.get(k)?.h ?? 0), cc.get(k)?.n ?? 0, A.fmtHours(cp.get(k)?.h ?? 0), cp.get(k)?.n ?? 0]) },
    });
    const counts = new Map(keys.map((k) => [k, new Map()]));
    for (const a of endurance(cur.activities)) {
      const { key } = A.classifySession(a, data.hrZones);
      const bk = b.keyOf(a.date);
      counts.get(key).set(bk, (counts.get(key).get(bk) || 0) + 1);
    }
    renderChart('ss-catweeks', {
      type: 'bar', labels: b.keys.map(b.label),
      datasets: keys.map((k) => barDs(A.categoryLabel(k), b.keys.map((bk) => counts.get(k).get(bk) || 0), categoryColor(k))),
      options: { stacked: true },
      extra: { scales: { y: { ticks: { precision: 0 } } } },
      table: { columns: [{ label: b.unit }, ...keys.map((k) => ({ label: A.categoryLabel(k), num: true }))], rows: b.keys.map((bk) => [b.label(bk), ...keys.map((k) => counts.get(k).get(bk) || 0)]) },
    });
  };
  return { html, after };
}

function activityItem(a, data) {
  const g = A.sportGroup(a.type);
  const cat = A.isEndurance(g) ? A.classifySession(a, data.hrZones) : null;
  const m = A.runMetrics(a);
  const stats = [
    a.distance ? `${fmt(a.distance / 1000, 2)} km` : null,
    a.duration ? A.fmtDuration(a.duration) : null,
    m ? `${A.fmtPace(m.paceSec)} /km` : g === 'cycling' && a.avgSpeed ? `${fmt(a.avgSpeed * 3.6, 1)} km/h` : null,
    a.avgHR ? `Ø ${a.avgHR} bpm` : 'keine HF',
    a.load !== null ? `Last ${fmt(a.load)}` : null,
  ].filter(Boolean);
  return `<li><button type="button" class="act" data-activity="${esc(a.id)}">
    <span class="act-top"><span class="act-name">${esc(a.name || A.SPORTS[g])}</span><span class="act-date">${esc(formatStart(a.start))}</span></span>
    <span class="act-stats">${stats.map((s) => `<span>${esc(s)}</span>`).join('')}</span>
    <span class="act-tags"><span class="tag">${esc(A.SPORTS[g])}</span>${cat ? `<span class="tag"><i class="cat-dot" data-swatch="${categoryColor(cat.key)}"></i>${esc(A.categoryLabel(cat.key))}</span>` : ''}${a.teLabel ? `<span class="tag">Garmin: ${esc(A.GARMIN_LABELS[a.teLabel] || a.teLabel)}</span>` : ''}</span>
  </button></li>`;
}

function formatStart(s) {
  if (!s) return '';
  const [d, time = ''] = s.split('T');
  return `${shortDate(d)} ${time.slice(0, 5)}`;
}

// ---------- Einheit im Detail ----------

export function activityDetail(a, data, stream) {
  const t = theme();
  const g = A.sportGroup(a.type);
  const m = A.runMetrics(a);
  const cat = A.isEndurance(g) ? A.classifySession(a, data.hrZones) : null;
  const dec = stream?.decoupling;
  let decText = 'Keine Stream-Daten.';
  let decValue = '–';
  if (dec?.value !== null && dec?.value !== undefined) {
    decValue = `${fmt(dec.value, 1)} %`;
    decText = dec.value < 5 ? 'gut gekoppelt – Puls bleibt bei gleichem Tempo stabil' : dec.value < 10 ? 'moderate Drift – Ausdauer oder Hitze/Flüssigkeit prüfen' : 'deutliche Drift – Belastung lag über deiner aktuellen aeroben Dauerleistung';
  } else if (dec?.reason) decText = dec.reason;
  const tiles = [
    tile('Distanz', a.distance ? `${fmt(a.distance / 1000, 2)} km` : '–'),
    tile('Dauer', A.fmtDuration(a.duration)),
    tile(m ? 'Pace' : 'Geschwindigkeit', m ? `${A.fmtPace(m.paceSec)} /km` : a.avgSpeed ? `${fmt(a.avgSpeed * 3.6, 1)} km/h` : '–'),
    tile('Ø-HF / max', a.avgHR ? `${a.avgHR} / ${a.maxHR ?? '–'}` : '–'),
    tile('Entkopplung (Pa:HR)', decValue, `<div class="tile-delta">${esc(decText)}</div>`, decValue === '–'),
    tile('Kategorie', cat ? esc(A.categoryLabel(cat.key)) : '–', cat ? `<div class="tile-delta">${esc(cat.method)}</div>` : ''),
    a.teAerobic !== null ? tile('Trainingseffekt', `${fmt(a.teAerobic, 1)} / ${fmt(a.teAnaerobic, 1)}`, `<div class="tile-delta">aerob / anaerob${a.teLabel ? ' · ' + esc(A.GARMIN_LABELS[a.teLabel] || a.teLabel) : ''}</div>`) : '',
    a.avgPower ? tile('Leistung', `${fmt(a.avgPower)} W`, a.normPower ? `<div class="tile-delta">NP ${fmt(a.normPower)} W</div>` : '') : '',
  ].join('');
  const s = stream?.stream || [];
  const hasHR = s.some((r) => r.hr), hasSpeed = s.some((r) => r.speed > 0);
  const split = stream?.splits || [];
  const splitRows = split.map((x) => [x.index, `${fmt(x.meters / 1000, 2)} km`, m || g === 'running' ? `${A.fmtPace(x.seconds / (x.meters / 1000))} /km` : `${fmt((x.meters / x.seconds) * 3.6, 1)} km/h`, x.avgHR, x.elevationDelta, x.avgPower]);
  const html = `<div class="tiles">${tiles}</div>
    ${stream?.error ? `<div class="error-box">${esc(stream.error)}</div>` : ''}
    ${hasHR ? chartCard({ id: 'ad-hr', title: 'Herzfrequenz', subtitle: 'bpm über die Zeit' }) : ''}
    ${hasSpeed ? chartCard({ id: 'ad-speed', title: m || g === 'running' ? 'Pace' : 'Geschwindigkeit', subtitle: m || g === 'running' ? 'min/km, geglättet' : 'km/h' }) : ''}
    ${split.length ? `<section class="card"><div class="card-head"><div><h2>Splits</h2></div></div>${tableHtml({ columns: [{ label: '#' }, { label: 'Strecke' }, { label: m || g === 'running' ? 'Pace' : 'Tempo', num: true }, { label: 'Ø-HF', num: true }, { label: 'Höhe Δ m', num: true }, { label: 'W', num: true }], rows: splitRows })}</section>` : ''}
    <p class="card-foot">Detaildaten stammen aus der Original-FIT-Datei (Download-Endpunkt der Personal API). Entkopplung: Verhältnis Tempo/HF der ersten vs. zweiten Hälfte, nur Bewegungszeit.</p>`;
  const after = () => {
    if (!s.length) return;
    const t0 = s[0].time;
    const labels = s.map((r) => A.fmtDuration((r.time - t0) / 1000));
    if (hasHR) renderChart('ad-hr', { type: 'line', labels, datasets: [lineDs('HF', s.map((r) => (r.hr ? Math.round(r.hr) : null)), t.series[0], { tension: 0.1 })], table: { columns: [{ label: 'Zeit' }, { label: 'HF', num: true }], rows: s.filter((_, i) => i % 10 === 0).map((r) => [A.fmtDuration((r.time - t0) / 1000), r.hr ? Math.round(r.hr) : null]) } });
    if (hasSpeed) {
      const running = m || g === 'running';
      const sm = A.rollingMean(s.map((r) => (r.speed > 0.5 ? r.speed : null)), 5);
      renderChart('ad-speed', {
        type: 'line', labels,
        datasets: [lineDs(running ? 'Pace' : 'km/h', sm.map((v) => (v ? (running ? 1000 / v : v * 3.6) : null)), t.series[0], { tension: 0.1 })],
        options: running ? { yReverse: true, yFormat: (v) => A.fmtPace(v) } : {},
        extra: { plugins: { tooltip: { callbacks: { label: (c) => (running ? `${A.fmtPace(c.parsed.y)} /km` : `${fmt(c.parsed.y, 1)} km/h`) } } } },
        table: { columns: [{ label: 'Zeit' }, { label: running ? 'Pace' : 'km/h', num: true }], rows: s.filter((_, i) => i % 10 === 0).map((r) => [A.fmtDuration((r.time - t0) / 1000), r.speed > 0.5 ? (running ? A.fmtPace(1000 / r.speed) : fmt(r.speed * 3.6, 1)) : null]) },
      });
    }
  };
  return { html, after };
}

// ---------- Daten ----------

const SOURCE_INFO = {
  activities: ['Aktivitäten', '/activitylist-service/activities/search/activities'],
  sleep: ['Schlaf', '/sleep-service/sleep/dailySleepSummariesByDate'],
  hrv: ['HRV', '/hrv-service/hrv/daily/{von}/{bis}'],
  bodyBattery: ['Body Battery', '/wellness-service/wellness/bodyBattery/reports/daily'],
  stress: ['Stress', '/usersummary-service/stats/stress/daily/{von}/{bis}'],
  dailies: ['Tageszusammenfassung', '/usersummary-service/v2/dailysummaries'],
  hrZones: ['HF-Zonen', '/biometric-service/heartRateZones/v2'],
  profile: ['Profil', '/userprofile-service/userprofile/settings'],
  fitnessAge: ['Fitnessalter', '/fitnessage-service/fitnessage/v2/{datum}'],
};

const METRICS = [
  ['activities', 'avgHR', 'Ø-Herzfrequenz', 'HF-Analysen, Kategorien, TRIMP'],
  ['activities', 'avgSpeed', 'Ø-Geschwindigkeit', 'Pace, Effizienz'],
  ['activities', 'hrZones', 'Zeit in HF-Zonen', 'genaue Kategorien & Intensitätsverteilung'],
  ['activities', 'load', 'Garmin-Trainingsbelastung', 'Belastungsmodell'],
  ['activities', 'teAerobic', 'Trainingseffekt aerob', 'Trainingseffekt-Diagramm'],
  ['activities', 'teLabel', 'Trainingseffekt-Label', 'Garmin-Kategorie'],
  ['activities', 'vo2max', 'VO2max je Aktivität', 'VO2max-Verlauf'],
  ['activities', 'avgPower', 'Ø-Leistung', 'Rad-Effizienz'],
  ['sleep', 'sleepSeconds', 'Schlafdauer', 'Erholungs-Check'],
  ['sleep', 'deep', 'Schlafphasen', 'Schlafphasen-Diagramm'],
  ['sleep', 'score', 'Schlaf-Score', 'Erholungs-Check'],
  ['hrv', 'lastNight', 'HRV letzte Nacht', 'Erholungs-Check'],
  ['hrv', 'baselineLow', 'HRV-Normalbereich', 'HRV-Band'],
  ['hrv', 'status', 'HRV-Status', 'Erholungs-Check'],
  ['bodyBattery', 'high', 'Body-Battery-Verlauf', 'Erholungs-Check'],
  ['stress', 'level', 'Stresslevel', 'Stress-Diagramm'],
  ['dailies', 'restingHR', 'Ruhepuls', 'Erholungs-Check, TRIMP'],
  ['hrZones', 'maxHR', 'Max-HF (Zonen)', 'TRIMP, Kategorien'],
  ['profile', 'gender', 'Geschlecht', 'TRIMP-Koeffizient'],
  ['fitnessAge', 'fitnessAge', 'Fitnessalter', 'Info'],
];

export function dataView(data) {
  const src = data.sources || {};
  const status = (m) => {
    if (!m) return 'nicht abgefragt';
    if (m.failed && m.failed === m.windows) return `Fehler (${m.errors?.[0]?.status || '?'})`;
    if (m.failed) return `teilweise (${m.failed}/${m.windows} Abrufe fehlgeschlagen)`;
    return m.count ? 'ok' : 'leer';
  };
  const sourceRows = Object.entries(SOURCE_INFO).map(([k, [label, path]]) => [label, status(src[k]), src[k]?.count ?? 0, path]);
  const metricRows = METRICS.map(([s, f, label, use]) => {
    const m = src[s];
    const n = m?.fields?.[f] ?? 0;
    const total = m?.count ?? 0;
    return [label, total ? (n ? `${Math.round((n / total) * 100)} %` : 'fehlt') : 'fehlt', total ? `${n} / ${total}` : '–', SOURCE_INFO[s][0], use];
  });
  const fa = data.fitnessAge;
  const html = `
    <section class="card"><div class="card-head"><div><h2>Was deine API wirklich liefert</h2><p>Abgerufen ${esc(new Date(data.fetchedAt).toLocaleString('de-DE'))} · ${esc(data.range.from)} bis ${esc(data.range.to)} (inkl. Vorzeitraum und 42 Tage Vorlauf für Trends)</p></div></div>
      ${tableHtml({ columns: [{ label: 'Quelle' }, { label: 'Status' }, { label: 'Datensätze', num: true }, { label: 'Endpunkt' }], rows: sourceRows })}
    </section>
    <section class="card"><div class="card-head"><div><h2>Feldabdeckung</h2><p>Anteil der Datensätze, in denen das Feld einen Wert hat. „fehlt“ = die API liefert es für dein Konto nicht; abhängige Auswertungen werden ausgeblendet oder gekennzeichnet.</p></div></div>
      ${tableHtml({ columns: [{ label: 'Messwert' }, { label: 'Abdeckung', num: true }, { label: 'Vorhanden', num: true }, { label: 'Quelle' }, { label: 'Genutzt für' }], rows: metricRows })}
    </section>
    <section class="card"><div class="card-head"><div><h2>Nicht über die Personal API verfügbar</h2><p>Laut Endpunktliste der Personal API (26 Lese-Endpunkte) fehlen:</p></div></div>
      <ul class="small">
        <li><strong>Training Readiness</strong> (Trainingsbereitschaft) – ersetzt durch den transparenten Erholungs-Check</li>
        <li><strong>Trainingsstatus, Belastungsfokus, Erholungszeit</strong> – ersetzt durch eigenes Belastungsmodell (ATL/CTL/ACWR)</li>
        <li><strong>Max-Metriken / VO2max-Verlauf, Laktatschwellen-Historie</strong> – nur, falls einzelne Aktivitäten ein VO2max-Feld enthalten</li>
        <li><strong>Rennzeit-Prognosen, Ausdauer- und Hill-Score, FTP-Verlauf</strong></li>
        <li><strong>Geräte, Ausrüstung, Trainingspläne</strong></li>
      </ul>
      ${fa && fa.fitnessAge !== null ? `<p class="card-foot">Fitnessalter laut Garmin: ${esc(fmt(fa.fitnessAge, 1))}${fa.chronologicalAge ? ` (Lebensalter ${esc(fa.chronologicalAge)})` : ''}.</p>` : ''}
    </section>
    <section class="card"><details><summary>Rohe Feldnamen je Quelle (nur Namen, keine Werte)</summary>
      ${Object.entries(SOURCE_INFO).map(([k, [label]]) => `<h3 class="section-title">${esc(label)}</h3><p class="keys">${esc((src[k]?.rawKeys || []).join(', ') || '–')}</p>`).join('')}
    </details></section>`;
  return { html, after: () => {} };
}
