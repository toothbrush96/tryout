// Training analysis on normalized Garmin data. Pure functions, no DOM.
//
// Every derived number is computed from values that arrived from the API.
// When an input is missing the result is null together with a reason, so the
// UI can say what is missing instead of showing a guess.

export const DAY = 86400000;

// ---------- small helpers ----------

export function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
}
export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
export function localToday(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}
const vals = (xs) => xs.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
export function mean(xs) {
  const v = vals(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
export function sum(xs) {
  return vals(xs).reduce((a, b) => a + b, 0);
}
export function sd(xs) {
  const v = vals(xs);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}
export function median(xs) {
  const v = vals(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function linreg(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, n: pts.length };
}
export function rollingMean(values, window) {
  return values.map((_, i) => {
    const w = vals(values.slice(Math.max(0, i - window + 1), i + 1));
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}
export function pctChange(cur, prev) {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
export function weekStart(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
}

// ---------- periods ----------

export const WARMUP_DAYS = 42;

export function periods(today, days) {
  const curFrom = addDays(today, -(days - 1));
  const prevTo = addDays(curFrom, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return {
    cur: { from: curFrom, to: today },
    prev: { from: prevFrom, to: prevTo },
    fetch: { from: addDays(prevFrom, -WARMUP_DAYS), to: today },
  };
}
const inRange = (d, r) => d >= r.from && d <= r.to;

// ---------- sports ----------

export const SPORTS = {
  running: 'Laufen',
  cycling: 'Rad',
  swimming: 'Schwimmen',
  walking: 'Gehen/Wandern',
  endurance_other: 'Sonst. Ausdauer',
  strength: 'Kraft',
  other: 'Sonstiges',
};

export function sportGroup(type = '') {
  const t = type.toLowerCase();
  if (t.includes('run')) return 'running';
  if (t.includes('cycl') || t.includes('bik') || t.includes('ride') || t.includes('spinning')) return 'cycling';
  if (t.includes('swim')) return 'swimming';
  if (t.includes('walk') || t.includes('hik')) return 'walking';
  if (t.includes('strength') || t.includes('weight')) return 'strength';
  if (/(row|ski|elliptical|stair|paddl|kayak|skat|inline)/.test(t)) return 'endurance_other';
  return 'other';
}
export const isEndurance = (group) => !['strength', 'other'].includes(group);

const LONG_MINUTES = { running: 90, cycling: 180, walking: 180, swimming: 60, endurance_other: 120 };

// ---------- heart-rate reference values ----------

export function zonesFor(hrZones, group) {
  const want = { running: 'RUNNING', cycling: 'CYCLING', swimming: 'SWIMMING' }[group];
  const valid = (hrZones || []).filter((z) => z.floors && z.floors.every((f) => f !== null));
  return valid.find((z) => z.sport === want) || valid.find((z) => z.sport === 'DEFAULT') || valid[0] || null;
}

export function hrReference(data) {
  const z = zonesFor(data.hrZones, 'running');
  const restCandidates = vals((data.dailies || []).map((d) => d.restingHR));
  const observedMax = Math.max(0, ...vals((data.activities || []).map((a) => a.maxHR)));
  const maxHR = z?.maxHR ?? (observedMax || null);
  const restingHR = z?.restingHR ?? median(restCandidates);
  return {
    maxHR,
    maxSource: z?.maxHR ? 'HF-Zonen (Garmin)' : observedMax ? 'höchste gemessene HF in Aktivitäten' : null,
    restingHR,
    restSource: z?.restingHR ? 'HF-Zonen (Garmin)' : restCandidates.length ? 'Median Ruhepuls (Tageswerte)' : null,
    lthr: z?.lthr ?? data.profile?.lactateThresholdHR ?? null,
  };
}

// ---------- session categories ----------

export const CATEGORIES = [
  { key: 'recovery', label: 'Regeneration' },
  { key: 'base', label: 'Grundlage' },
  { key: 'long', label: 'Lange Einheit' },
  { key: 'tempo', label: 'Tempo' },
  { key: 'threshold', label: 'Schwelle' },
  { key: 'vo2', label: 'Intervall/VO2max' },
  { key: 'unclassified', label: 'Nicht einordenbar' },
];
export const categoryLabel = (k) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

export const GARMIN_LABELS = {
  RECOVERY: 'Regeneration',
  AEROBIC_BASE: 'Grundlage',
  TEMPO: 'Tempo',
  LACTATE_THRESHOLD: 'Laktatschwelle',
  VO2MAX: 'VO2max',
  ANAEROBIC_CAPACITY: 'Anaerobe Kapazität',
  SPRINT: 'Sprint',
  NO_BENEFIT: 'Kein Trainingseffekt',
  NONE: 'Kein Trainingseffekt',
};

// Rules: with Garmin's time-in-zone fields the share per zone decides;
// otherwise the zone of the average heart rate. Long sessions are mostly
// easy (Z1-2) and exceed a sport-specific duration.
export function classifySession(a, hrZones) {
  const group = sportGroup(a.type);
  const minutes = (a.duration ?? 0) / 60;
  const longMin = LONG_MINUTES[group] ?? 120;
  if (a.hrZones) {
    const total = a.hrZones.reduce((x, y) => x + y, 0);
    if (total > 0) {
      const [f1, f2, f3, f4, f5] = a.hrZones.map((s) => s / total);
      let key;
      if (f5 >= 0.1 || (f4 + f5 >= 0.25 && (a.teAnaerobic ?? 0) >= 2)) key = 'vo2';
      else if (f4 >= 0.2) key = 'threshold';
      else if (f3 >= 0.3) key = 'tempo';
      else if (minutes >= longMin) key = 'long';
      else if (f1 >= 0.6 && minutes < 60) key = 'recovery';
      else key = 'base';
      return { key, method: 'Zeit in HF-Zonen' };
    }
  }
  const z = zonesFor(hrZones, group);
  if (a.avgHR && z) {
    let zone = 0;
    z.floors.forEach((f, i) => {
      if (a.avgHR >= f) zone = i + 1;
    });
    let key;
    if (zone >= 5) key = 'vo2';
    else if (zone === 4) key = 'threshold';
    else if (zone === 3) key = 'tempo';
    else if (minutes >= longMin) key = 'long';
    else if (zone <= 1 && minutes < 60) key = 'recovery';
    else key = 'base';
    return { key, method: 'Ø-HF in deinen HF-Zonen' };
  }
  return { key: 'unclassified', method: a.avgHR ? 'keine HF-Zonen verfügbar' : 'keine Herzfrequenz' };
}

// ---------- training load ----------

export function chooseLoadModel(activities, gender) {
  const withHR = activities.filter((a) => a.avgHR && a.duration);
  const base = withHR.length || 1;
  const share = (f) => withHR.filter(f).length / base;
  if (activities.length && share((a) => a.load !== null) >= 0.7) {
    return { key: 'garmin', label: 'Garmin-Trainingsbelastung (activityTrainingLoad)', note: 'Von Garmin pro Aktivität berechnet.' };
  }
  if (withHR.length && share((a) => a.hrZones) >= 0.7) {
    return { key: 'edwards', label: 'Edwards-TRIMP (Zeit in HF-Zonen)', note: 'Minuten in Zone × Zonennummer. Eigene Berechnung aus Garmins Zonenzeiten.' };
  }
  if (withHR.length) {
    const female = String(gender || '').toUpperCase() === 'FEMALE';
    const known = Boolean(gender);
    return {
      key: 'banister',
      label: 'Banister-TRIMP (Dauer × Ø-HF-Reserve)',
      female,
      note: known ? 'Eigene Berechnung aus Dauer, Ø-HF, Ruhe- und Max-HF.' : 'Eigene Berechnung; Geschlecht nicht in den API-Daten, daher Standardkoeffizienten (männlich).',
    };
  }
  return { key: 'none', label: 'Keine Belastung berechenbar', note: 'Keine Aktivitäten mit Herzfrequenz oder Garmin-Belastung.' };
}

export function activityLoad(a, model, ref) {
  if (model.key === 'garmin') return a.load;
  if (model.key === 'edwards') return a.hrZones ? a.hrZones.reduce((s, sec, i) => s + (sec / 60) * (i + 1), 0) : null;
  if (model.key === 'banister') {
    if (!a.avgHR || !a.duration || !ref.maxHR || !ref.restingHR || ref.maxHR <= ref.restingHR) return null;
    const hrr = Math.min(Math.max((a.avgHR - ref.restingHR) / (ref.maxHR - ref.restingHR), 0), 1);
    const [k, b] = model.female ? [0.86, 1.67] : [0.64, 1.92];
    return (a.duration / 60) * hrr * k * Math.exp(b * hrr);
  }
  return null;
}

// Daily load with acute (7 d) and chronic (42 d) exponentially weighted
// averages. ACWR is shown only once 28 days of history exist.
export function loadSeries(data, model, ref) {
  const days = dateRange(data.range.from, data.range.to);
  const perDay = new Map(days.map((d) => [d, 0]));
  let missing = 0;
  for (const a of data.activities) {
    const l = activityLoad(a, model, ref);
    if (l === null) missing++;
    else if (perDay.has(a.date)) perDay.set(a.date, perDay.get(a.date) + l);
  }
  const ka = 1 - Math.exp(-1 / 7);
  const kc = 1 - Math.exp(-1 / 42);
  let atl = 0, ctl = 0;
  const series = days.map((d, i) => {
    const load = perDay.get(d);
    atl += ka * (load - atl);
    ctl += kc * (load - ctl);
    const warm = i >= 28;
    return { date: d, load, atl, ctl, tsb: ctl - atl, acwr: warm && ctl > 1 ? atl / ctl : null, warm };
  });
  return { series, missing };
}

export function monotony(series, range) {
  const loads = series.filter((s) => inRange(s.date, range)).slice(-7).map((s) => s.load);
  const s = sd(loads);
  if (loads.length < 7 || !s) return null;
  return { value: mean(loads) / s, strain: sum(loads) * (mean(loads) / s) };
}

// ---------- intensity distribution ----------

export function intensityDistribution(activities, hrZones) {
  const endurance = activities.filter((a) => isEndurance(sportGroup(a.type)));
  const withZones = endurance.filter((a) => a.hrZones);
  if (withZones.length && withZones.length >= endurance.length * 0.7) {
    let low = 0, mod = 0, high = 0;
    for (const a of withZones) {
      const [z1, z2, z3, z4, z5] = a.hrZones;
      low += z1 + z2;
      mod += z3;
      high += z4 + z5;
    }
    const t = low + mod + high;
    if (t > 0) return { method: 'Zeit in HF-Zonen (Z1–2 / Z3 / Z4–5)', low: low / t, mod: mod / t, high: high / t, n: withZones.length };
  }
  let low = 0, mod = 0, high = 0, n = 0;
  for (const a of endurance) {
    const { key } = classifySession(a, hrZones);
    const minutes = (a.duration ?? 0) / 60;
    if (key === 'unclassified') continue;
    n++;
    if (['recovery', 'base', 'long'].includes(key)) low += minutes;
    else if (key === 'tempo') mod += minutes;
    else high += minutes;
  }
  const t = low + mod + high;
  if (!t) return null;
  return { method: 'Dauer nach Einheiten-Kategorie (ohne Zonenzeiten ungenauer)', low: low / t, mod: mod / t, high: high / t, n };
}

// ---------- running performance ----------

export function runMetrics(a) {
  if (sportGroup(a.type) !== 'running' || !a.avgSpeed || a.avgSpeed <= 0) return null;
  const minutes = (a.movingDuration ?? a.duration ?? 0) / 60;
  return {
    paceSec: 1000 / a.avgSpeed,
    ef: a.avgHR ? (a.avgSpeed * 60) / a.avgHR : null, // metres per heartbeat
    minutes,
  };
}

export function paceAtHR(runs, refHR) {
  const pts = runs.filter((r) => r.avgHR && r.avgSpeed && (r.duration ?? 0) >= 900);
  if (pts.length < 5) return { value: null, reason: `zu wenige Läufe mit HF (${pts.length} von min. 5)` };
  const hrs = pts.map((r) => r.avgHR);
  if (Math.max(...hrs) - Math.min(...hrs) < 8) return { value: null, reason: 'HF-Spanne der Läufe zu klein für eine Regression' };
  const fit = linreg(hrs, pts.map((r) => r.avgSpeed));
  if (!fit || fit.slope <= 0) return { value: null, reason: 'kein positiver Zusammenhang zwischen HF und Tempo' };
  const speed = fit.intercept + fit.slope * refHR;
  if (speed <= 0) return { value: null, reason: 'Referenz-HF ausserhalb des Datenbereichs' };
  return { value: 1000 / speed, fit, n: pts.length };
}

// ---------- recovery ----------

function latestBy(records, field, until) {
  const xs = records.filter((r) => r[field] !== null && r.date <= until).sort((a, b) => a.date.localeCompare(b.date));
  return xs.at(-1) || null;
}

export function restingSeries(data) {
  const byDate = new Map();
  for (const s of data.sleep || []) if (s.restingHR) byDate.set(s.date, s.restingHR);
  for (const d of data.dailies || []) if (d.restingHR) byDate.set(d.date, d.restingHR);
  return [...byDate.entries()].sort().map(([date, restingHR]) => ({ date, restingHR }));
}

export function recoveryCheck(data, today, loadInfo) {
  const signals = [];
  const fresh = (rec) => rec && daysBetween(rec.date, today) <= 1;

  const hrv = latestBy(data.hrv || [], 'lastNight', today);
  if (fresh(hrv)) {
    const lo = hrv.baselineLow, hi = hrv.baselineHigh;
    let state = 'good';
    let ref = lo && hi ? `Basis ${lo}–${hi} ms` : 'keine Basislinie';
    if (lo && hrv.lastNight < lo) state = 'warning';
    if (String(hrv.status).toUpperCase() === 'LOW' || String(hrv.status).toUpperCase() === 'POOR') state = 'serious';
    if (String(hrv.status).toUpperCase() === 'UNBALANCED' && state === 'good') state = 'warning';
    signals.push({ key: 'hrv', label: 'HRV letzte Nacht', value: `${Math.round(hrv.lastNight)} ms`, ref: `${ref}${hrv.status ? ' · Garmin: ' + hrvStatusLabel(hrv.status) : ''}`, state });
  } else signals.push({ key: 'hrv', label: 'HRV letzte Nacht', state: 'missing', ref: hrv ? `letzter Wert vom ${hrv.date}` : 'keine HRV-Daten' });

  const rhr = restingSeries(data);
  const last = rhr.filter((r) => r.date <= today).at(-1);
  if (fresh(last)) {
    const base = rhr.filter((r) => r.date < last.date && daysBetween(r.date, last.date) <= 28).map((r) => r.restingHR);
    if (base.length >= 7) {
      const m = mean(base);
      const delta = last.restingHR - m;
      const state = delta >= 5 ? 'serious' : delta >= 3 ? 'warning' : 'good';
      signals.push({ key: 'rhr', label: 'Ruhepuls', value: `${last.restingHR} bpm`, ref: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} zum 28-Tage-Schnitt (${m.toFixed(0)})`, state });
    } else signals.push({ key: 'rhr', label: 'Ruhepuls', value: `${last.restingHR} bpm`, ref: 'zu wenig Verlauf für einen Vergleich', state: 'missing' });
  } else signals.push({ key: 'rhr', label: 'Ruhepuls', state: 'missing', ref: 'kein aktueller Wert' });

  const sleep = latestBy(data.sleep || [], 'sleepSeconds', today);
  if (fresh(sleep)) {
    const h = sleep.sleepSeconds / 3600;
    const avg = mean((data.sleep || []).filter((s) => s.date < sleep.date && daysBetween(s.date, sleep.date) <= 7).map((s) => s.sleepSeconds / 3600));
    let state = h < 6 ? 'serious' : h < 7 ? 'warning' : 'good';
    if (sleep.score !== null && sleep.score < 60) state = 'serious';
    const parts = [];
    if (sleep.score !== null) parts.push(`Score ${sleep.score}`);
    if (avg) parts.push(`7-Tage-Ø ${fmtHours(avg)}`);
    signals.push({ key: 'sleep', label: 'Schlaf', value: fmtHours(h), ref: parts.join(' · ') || '–', state });
  } else signals.push({ key: 'sleep', label: 'Schlaf', state: 'missing', ref: 'keine Schlafdaten für letzte Nacht' });

  const bb = latestBy(data.bodyBattery || [], 'high', today);
  if (fresh(bb)) {
    const state = bb.high < 50 ? 'serious' : bb.high < 70 ? 'warning' : 'good';
    signals.push({ key: 'bb', label: 'Body Battery (Tageshoch)', value: `${bb.high}`, ref: bb.charged !== null ? `geladen +${bb.charged}` : '', state });
  } else signals.push({ key: 'bb', label: 'Body Battery', state: 'missing', ref: 'kein aktueller Wert' });

  const lastLoad = loadInfo?.series?.at(-1);
  if (lastLoad && lastLoad.warm && lastLoad.ctl > 1) {
    const ratio = lastLoad.acwr;
    const state = ratio > 1.5 ? 'serious' : ratio > 1.3 ? 'warning' : 'good';
    signals.push({ key: 'load', label: 'Akut/chronisch (ACWR)', value: ratio.toFixed(2), ref: 'Zielkorridor 0,8–1,3', state });
  } else signals.push({ key: 'load', label: 'Belastungsverhältnis', state: 'missing', ref: 'zu wenig Belastungsverlauf' });

  const physio = signals.filter((s) => ['hrv', 'rhr', 'sleep', 'bb'].includes(s.key) && s.state !== 'missing');
  const bad = physio.filter((s) => s.state === 'serious').length;
  const warn = physio.filter((s) => s.state === 'warning').length;
  const loadBad = signals.find((s) => s.key === 'load')?.state === 'serious';
  let verdict;
  if (physio.length < 2) verdict = { state: 'missing', title: 'Zu wenige aktuelle Erholungsdaten', text: 'Für eine Einschätzung fehlen Werte von letzter Nacht (HRV, Ruhepuls, Schlaf oder Body Battery).' };
  else if (bad >= 2 || (bad >= 1 && warn >= 1) || (bad >= 1 && loadBad)) verdict = { state: 'serious', title: 'Erholung priorisieren', text: 'Mehrere Signale liegen deutlich unter deinem Normalbereich. Heute locker (Z1–2) oder Ruhetag; keine harte Einheit.' };
  else if (bad === 1 || warn >= 1 || loadBad) verdict = { state: 'warning', title: 'Mit Vorsicht trainieren', text: 'Ein Teil der Signale ist auffällig. Geplante intensive Einheit kritisch prüfen oder verkürzen.' };
  else verdict = { state: 'good', title: 'Bereit für Belastung', text: 'Alle verfügbaren Erholungssignale liegen in deinem Normalbereich.' };
  return { signals, verdict, basis: `${physio.length} von 4 Erholungssignalen verfügbar` };
}

export function hrvStatusLabel(s) {
  return { BALANCED: 'ausgeglichen', UNBALANCED: 'unausgeglichen', LOW: 'niedrig', POOR: 'schlecht', NONE: 'keine' }[String(s).toUpperCase()] || String(s).toLowerCase();
}

// ---------- period summaries ----------

export function summarizePeriod(data, range, ctx) {
  const acts = data.activities.filter((a) => inRange(a.date, range));
  const days = daysBetween(range.from, range.to) + 1;
  const weeks = days / 7;
  const runs = acts.filter((a) => sportGroup(a.type) === 'running');
  const easyRuns = runs.filter((a) => ['recovery', 'base', 'long'].includes(classifySession(a, data.hrZones).key));
  const efRuns = (easyRuns.length >= 3 ? easyRuns : runs).map(runMetrics).filter((m) => m?.ef && m.minutes >= 15);
  const loads = ctx.load.series.filter((s) => inRange(s.date, range));
  const sleeps = (data.sleep || []).filter((s) => inRange(s.date, range));
  const hrvs = (data.hrv || []).filter((h) => inRange(h.date, range));
  const rhr = restingSeries(data).filter((r) => inRange(r.date, range));
  return {
    days,
    sessions: acts.length,
    hours: sum(acts.map((a) => a.duration)) / 3600,
    runKm: sum(runs.map((a) => a.distance)) / 1000,
    rideKm: sum(acts.filter((a) => sportGroup(a.type) === 'cycling').map((a) => a.distance)) / 1000,
    elevation: sum(acts.map((a) => a.elevationGain)),
    loadPerWeek: loads.length ? sum(loads.map((l) => l.load)) / weeks : null,
    ef: efRuns.length >= 2 ? mean(efRuns.map((m) => m.ef)) : null,
    efBasis: easyRuns.length >= 3 ? 'lockere Läufe' : 'alle Läufe',
    restingHR: mean(rhr.map((r) => r.restingHR)),
    hrv: mean(hrvs.map((h) => h.lastNight)),
    sleepHours: sleeps.length ? mean(sleeps.map((s) => (s.sleepSeconds ?? null) && s.sleepSeconds / 3600)) : null,
    sleepScore: mean(sleeps.map((s) => s.score)),
    longSessions: acts.filter((a) => classifySession(a, data.hrZones).key === 'long').length,
    intensity: intensityDistribution(acts, data.hrZones),
    activities: acts,
  };
}

// ---------- insights ----------

export function buildInsights(data, ctx) {
  const out = [];
  const { cur, prev } = ctx.summary;
  const add = (severity, title, text) => out.push({ severity, title, text });
  const lastLoad = ctx.load.series.at(-1);

  if (lastLoad?.acwr !== null && lastLoad?.acwr !== undefined) {
    if (lastLoad.acwr > 1.5) add('serious', 'Belastungssprung', `Die akute Belastung liegt beim ${lastLoad.acwr.toFixed(2)}-Fachen der chronischen. Über 1,5 steigt das Überlastungsrisiko deutlich – die nächsten Tage locker halten.`);
    else if (lastLoad.acwr > 1.3) add('warning', 'Belastung steigt schnell', `ACWR ${lastLoad.acwr.toFixed(2)}: Du trainierst gerade mehr als dein Körper gewohnt ist. Steigerung bewusst dosieren.`);
    else if (lastLoad.acwr < 0.8 && lastLoad.ctl > 5) add('info', 'Belastung unter Gewohnheit', `ACWR ${lastLoad.acwr.toFixed(2)}: Die letzten Tage waren deutlich leichter als üblich – passend für Tapering oder Erholung, sonst sinkt die Fitness.`);
  }

  const vol = pctChange(cur.hours, prev.hours);
  if (vol !== null && prev.hours >= 1) {
    if (vol > 30) add('warning', 'Umfang stark gestiegen', `Trainingszeit +${vol.toFixed(0)} % gegenüber dem Vorzeitraum (${fmtHours(prev.hours)} → ${fmtHours(cur.hours)}). Sprünge über ~30 % sind ein häufiger Verletzungsauslöser.`);
    else if (vol < -30) add('info', 'Umfang deutlich reduziert', `Trainingszeit ${vol.toFixed(0)} % gegenüber dem Vorzeitraum (${fmtHours(prev.hours)} → ${fmtHours(cur.hours)}).`);
  }

  const recentHrv = (data.hrv || []).filter((h) => daysBetween(h.date, ctx.today) < 7 && h.lastNight && h.baselineLow);
  const below = recentHrv.filter((h) => h.lastNight < h.baselineLow).length;
  if (below >= 3) add('warning', 'HRV unter Basislinie', `In ${below} der letzten 7 Nächte lag deine HRV unter deinem persönlichen Normalbereich – Zeichen für unvollständige Erholung, Stress oder beginnenden Infekt.`);

  const rhr = restingSeries(data);
  const last7 = mean(rhr.filter((r) => daysBetween(r.date, ctx.today) < 7).map((r) => r.restingHR));
  const base28 = mean(rhr.filter((r) => daysBetween(r.date, ctx.today) >= 7 && daysBetween(r.date, ctx.today) < 35).map((r) => r.restingHR));
  if (last7 && base28 && last7 - base28 >= 3) add('warning', 'Ruhepuls erhöht', `7-Tage-Schnitt ${last7.toFixed(0)} bpm, ${(last7 - base28).toFixed(1)} bpm über den vier Wochen davor.`);

  if (cur.sleepHours !== null) {
    const short = (data.sleep || []).filter((s) => s.date >= ctx.periods.cur.from && s.sleepSeconds && s.sleepSeconds < 6 * 3600).length;
    if (cur.sleepHours < 7) add('warning', 'Wenig Schlaf', `Im Schnitt ${fmtHours(cur.sleepHours)} pro Nacht${short ? `, davon ${short} Nächte unter 6 h` : ''}. Schlaf ist der grösste Hebel für Anpassung und Erholung.`);
  }

  if (cur.intensity) {
    const { low, mod } = cur.intensity;
    if (low < 0.7 && cur.hours >= 3) add('warning', 'Wenig lockeres Training', `Nur ${(low * 100).toFixed(0)} % der Ausdauerzeit im niedrigen Bereich. Viele Ausdauerpläne zielen auf ~75–80 % locker.`);
    if (mod > 0.25 && cur.hours >= 3) add('info', 'Viel „Grauzone“', `${(mod * 100).toFixed(0)} % der Zeit im mittleren Bereich (Tempo/Z3). Lockere Einheiten lockerer und harte gezielter machen kann mehr Reiz bei weniger Ermüdung bringen.`);
  }

  const ef = pctChange(cur.ef, prev.ef);
  if (ef !== null) {
    if (ef >= 3) add('good', 'Aerobe Effizienz verbessert', `Du läufst ${ef.toFixed(1)} % mehr Meter pro Herzschlag als im Vorzeitraum (${cur.efBasis}). Gleiches Tempo kostet dich weniger Puls.`);
    else if (ef <= -3) add('warning', 'Aerobe Effizienz gesunken', `${ef.toFixed(1)} % weniger Meter pro Herzschlag als im Vorzeitraum (${cur.efBasis}). Ursachen können Ermüdung, Hitze, Krankheit oder profiliertere Strecken sein.`);
  }

  if (ctx.paceRef?.cur?.value && ctx.paceRef?.prev?.value) {
    const diff = ctx.paceRef.prev.value - ctx.paceRef.cur.value;
    if (Math.abs(diff) >= 5) add(diff > 0 ? 'good' : 'warning', diff > 0 ? 'Schneller bei gleichem Puls' : 'Langsamer bei gleichem Puls', `Bei ${ctx.paceRef.refHR} bpm: ${fmtPace(ctx.paceRef.prev.value)} → ${fmtPace(ctx.paceRef.cur.value)} /km (Regression über deine Läufe).`);
  }

  const mono = monotony(ctx.load.series, ctx.periods.cur);
  if (mono && mono.value > 2) add('warning', 'Monotones Training', `Trainingsmonotonie ${mono.value.toFixed(1)} in den letzten 7 Tagen (Foster; > 2 gilt als kritisch). Mehr Wechsel zwischen leichten und harten Tagen einplanen.`);

  const streak = trainingStreak(data.activities, ctx.today);
  if (streak >= 10) add('warning', 'Kein Ruhetag', `${streak} Tage in Folge mit Training. Ein Ruhetag hilft, die Belastung in Anpassung umzusetzen.`);

  const runs = data.activities.filter((a) => sportGroup(a.type) === 'running' && daysBetween(a.date, ctx.today) < 21);
  if (runs.length >= 6 && !runs.some((a) => classifySession(a, data.hrZones).key === 'long')) add('info', 'Kein langer Lauf', 'In den letzten 3 Wochen gab es keinen Lauf über 90 Minuten – relevant, falls du auf einen Halbmarathon oder länger trainierst.');

  const order = { serious: 0, warning: 1, good: 2, info: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function trainingStreak(activities, today) {
  const days = new Set(activities.map((a) => a.date));
  let n = 0;
  for (let d = today; days.has(d); d = addDays(d, -1)) n++;
  if (!n) for (let d = addDays(today, -1); days.has(d); d = addDays(d, -1)) n++;
  return n;
}

// ---------- weekly buckets ----------

export function weekly(activities, range, valueFn) {
  const weeks = [];
  for (let w = weekStart(range.from); w <= range.to; w = addDays(w, 7)) weeks.push(w);
  const groups = new Map();
  for (const a of activities) {
    if (!inRange(a.date, range)) continue;
    const g = sportGroup(a.type);
    if (!groups.has(g)) groups.set(g, new Map());
    const w = weekStart(a.date);
    groups.get(g).set(w, (groups.get(g).get(w) || 0) + (valueFn(a) || 0));
  }
  return { weeks, groups };
}

// ---------- formatting ----------

export function fmtPace(sec) {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtHours(h) {
  if (!Number.isFinite(h)) return '–';
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm === 60 ? `${hh + 1}:00 h` : `${hh}:${String(mm).padStart(2, '0')} h`;
}
export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- everything the views need ----------

export function analyze(data, { today, days }) {
  const p = periods(today, days);
  const ref = hrReference(data);
  const model = chooseLoadModel(data.activities.filter((a) => a.date >= p.prev.from), data.profile?.gender);
  const load = loadSeries(data, model, ref);
  const ctx = { today, days, periods: p, ref, model, load };
  ctx.summary = { cur: summarizePeriod(data, p.cur, ctx), prev: summarizePeriod(data, p.prev, ctx) };
  const runsIn = (r) => data.activities.filter((a) => inRange(a.date, r) && sportGroup(a.type) === 'running');
  const allRunHR = [...runsIn(p.cur), ...runsIn(p.prev)].map((a) => a.avgHR);
  const refHR = median(allRunHR) ? Math.round(median(allRunHR)) : null;
  ctx.paceRef = refHR ? { refHR, cur: paceAtHR(runsIn(p.cur), refHR), prev: paceAtHR(runsIn(p.prev), refHR) } : null;
  ctx.recovery = recoveryCheck(data, today, load);
  ctx.insights = buildInsights(data, ctx);
  return ctx;
}
