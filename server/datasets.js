// Fetches every dataset the dashboard needs for a date range.
//
// Range requests are split into windows aligned to fixed day boundaries, so
// a window fetched for one period is reused from cache when the user switches
// to another. Windows that ended a while ago rarely change and are kept longer.

import { GarminError, mapLimit } from './garmin.js';
import * as N from './normalize.js';

const DAY = 86400000;
const RECENT_TTL = 10 * 60 * 1000;
const PAST_TTL = 6 * 60 * 60 * 1000;
const CONCURRENCY = 4;
const ACTIVITY_PAGE = 100;

// Per-request maximum range in days, from the Personal API reference
// (steps/stress 28; sleep summaries, hydration, Body Battery 31; daily
// summaries 365). HRV range has no documented cap here, so 28 is used.
const RANGE_SOURCES = {
  sleep: {
    maxDays: 31,
    path: '/sleep-service/sleep/dailySleepSummariesByDate',
    params: (s, e) => ({ startDate: s, endDate: e }),
    list: (p) => N.asList(p, 'dailySleepSummaries', 'sleepSummaries', 'data'),
    normalize: N.normalizeSleep,
  },
  hrv: {
    maxDays: 28,
    path: (s, e) => `/hrv-service/hrv/daily/${s}/${e}`,
    list: (p) => N.asList(p, 'hrvSummaries', 'data'),
    normalize: N.normalizeHrv,
  },
  bodyBattery: {
    maxDays: 31,
    path: '/wellness-service/wellness/bodyBattery/reports/daily',
    params: (s, e) => ({ startDate: s, endDate: e }),
    list: (p) => N.asList(p, 'data'),
    normalize: N.normalizeBodyBattery,
  },
  stress: {
    maxDays: 28,
    path: (s, e) => `/usersummary-service/stats/stress/daily/${s}/${e}`,
    list: (p) => N.asList(p, 'values', 'data'),
    normalize: N.normalizeStress,
  },
  dailies: {
    maxDays: 365,
    path: '/usersummary-service/v2/dailysummaries',
    params: (s, e) => ({ startDate: s, endDate: e }),
    list: (p) => N.asList(p, 'data'),
    normalize: N.normalizeDaily,
  },
  activities: {
    maxDays: 90,
    paged: true,
    path: '/activitylist-service/activities/search/activities',
    params: (s, e) => ({ startDate: s, endDate: e }),
    list: (p) => N.asList(p, 'activityList', 'activities'),
    normalize: N.normalizeActivity,
  },
};

const dayIndex = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / DAY);
const isoDay = (i) => new Date(i * DAY).toISOString().slice(0, 10);

export function alignedWindows(from, to, maxDays) {
  const out = [];
  const first = Math.floor(dayIndex(from) / maxDays) * maxDays;
  for (let s = first; s <= dayIndex(to); s += maxDays) out.push([isoDay(s), isoDay(s + maxDays - 1)]);
  return out;
}

export class DatasetCache {
  constructor() {
    this.entries = new Map();
  }
  get(key) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key, value, ttl) {
    this.entries.set(key, { value, expires: Date.now() + ttl });
  }
  clear() {
    this.entries.clear();
  }
}

async function fetchWindow(client, name, src, s, e) {
  const path = typeof src.path === 'function' ? src.path(s, e) : src.path;
  const params = src.params ? src.params(s, e) : undefined;
  if (!src.paged) return src.list(await client.get(path, params));
  const rows = [];
  for (let start = 0; ; start += ACTIVITY_PAGE) {
    const page = src.list(await client.get(path, { ...params, start, limit: ACTIVITY_PAGE }));
    rows.push(...page);
    if (page.length < ACTIVITY_PAGE || start > 5000) break;
  }
  return rows;
}

async function fetchRangeSource(client, cache, name, src, from, to, force) {
  const today = dayIndex(new Date().toISOString().slice(0, 10));
  const status = { windows: 0, failed: 0, errors: [] };
  const wins = alignedWindows(from, to, src.maxDays);
  const parts = await mapLimit(wins, CONCURRENCY, async ([s, e]) => {
    const key = `${name}:${s}:${e}`;
    const cached = force ? undefined : cache.get(key);
    status.windows++;
    if (cached) return cached;
    try {
      const raw = await fetchWindow(client, name, src, s, e);
      const ttl = dayIndex(e) < today - 3 ? PAST_TTL : RECENT_TTL;
      const value = { records: raw.map(src.normalize), keys: N.sampleKeys(raw) };
      cache.set(key, value, ttl);
      return value;
    } catch (err) {
      if (!(err instanceof GarminError) || err.path.includes('personalapitoken')) throw err;
      status.failed++;
      if (status.errors.length < 3) status.errors.push({ window: `${s}…${e}`, status: err.status, message: err.message });
      return { records: [], keys: [] };
    }
  });
  const byKey = new Map();
  const keys = new Set();
  for (const part of parts) {
    part.keys.forEach((k) => keys.add(k));
    for (const r of part.records) {
      if (!r.date || r.date < from || r.date > to) continue;
      byKey.set(name === 'activities' ? `${r.id}` : r.date, r);
    }
  }
  const records = [...byKey.values()].sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  return { records, meta: { ...status, ...N.coverage(records), rawKeys: [...keys].sort() } };
}

async function fetchSingle(client, cache, name, path, params, normalize, force) {
  const key = `${name}:${path}:${JSON.stringify(params || {})}`;
  const cached = force ? undefined : cache.get(key);
  if (cached) return cached;
  let result;
  try {
    const raw = await client.get(path, params);
    const value = normalize(raw);
    const rawList = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const records = raw === null ? [] : Array.isArray(value) ? value : [value];
    result = { value, meta: { windows: 1, failed: 0, errors: [], ...N.coverage(records), rawKeys: N.sampleKeys(rawList) } };
  } catch (err) {
    if (!(err instanceof GarminError) || err.path.includes('personalapitoken')) throw err;
    result = { value: null, meta: { windows: 1, failed: 1, errors: [{ status: err.status, message: err.message }], count: 0, fields: {}, rawKeys: [] } };
  }
  cache.set(key, result, RECENT_TTL * 3);
  return result;
}

export async function loadDashboardData(client, cache, { from, to, today, force = false }) {
  const names = Object.keys(RANGE_SOURCES);
  const ranged = await Promise.all(
    names.map((n) => fetchRangeSource(client, cache, n, RANGE_SOURCES[n], from, to, force)),
  );
  const [zones, profile, fitnessAge] = await Promise.all([
    fetchSingle(client, cache, 'hrZones', '/biometric-service/heartRateZones/v2', { generateDefaults: true }, N.normalizeZones, force),
    fetchSingle(client, cache, 'profile', '/userprofile-service/userprofile/settings', undefined, N.normalizeProfile, force),
    fetchSingle(client, cache, 'fitnessAge', `/fitnessage-service/fitnessage/v2/${today}`, undefined, N.normalizeFitnessAge, force),
  ]);
  const data = { range: { from, to }, fetchedAt: new Date().toISOString(), sources: {} };
  names.forEach((n, i) => {
    data[n] = ranged[i].records;
    data.sources[n] = ranged[i].meta;
  });
  data.hrZones = zones.value || [];
  data.profile = profile.value;
  data.fitnessAge = fitnessAge.value;
  data.sources.hrZones = zones.meta;
  data.sources.profile = profile.meta;
  data.sources.fitnessAge = fitnessAge.meta;
  return data;
}
