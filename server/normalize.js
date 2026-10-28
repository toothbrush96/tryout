// Turns raw Personal API responses into compact records for the dashboard.
//
// Garmin's Swagger reference documents which data each endpoint returns, but
// exact field names are only verifiable against a real account. Every field
// is therefore read defensively from known Garmin Connect names; a field that
// is absent stays null and is reported as missing — nothing is estimated here.

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// First non-null value among dotted paths, e.g. pick(o, 'a.b', 'c').
export function pick(obj, ...paths) {
  for (const p of paths) {
    let cur = obj;
    for (const part of p.split('.')) {
      if (cur === null || cur === undefined) break;
      cur = cur[part];
    }
    if (cur !== null && cur !== undefined && cur !== '') return cur;
  }
  return null;
}

export function asList(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const k of keys) if (Array.isArray(payload[k])) return payload[k];
  }
  return [];
}

function dateOf(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

export function normalizeActivity(a) {
  const start = pick(a, 'startTimeLocal', 'startTimeGMT');
  const zones = [1, 2, 3, 4, 5].map((z) => num(a[`hrTimeInZone_${z}`]));
  return {
    id: pick(a, 'activityId'),
    name: pick(a, 'activityName'),
    start: typeof start === 'string' ? start.replace(' ', 'T') : null,
    date: dateOf(start),
    type: pick(a, 'activityType.typeKey') || 'unbekannt',
    parentTypeId: num(pick(a, 'activityType.parentTypeId')),
    eventType: pick(a, 'eventType.typeKey'),
    distance: num(a.distance),
    duration: num(pick(a, 'duration', 'elapsedDuration')),
    movingDuration: num(a.movingDuration),
    avgSpeed: num(a.averageSpeed),
    avgHR: num(pick(a, 'averageHR', 'averageHeartRate')),
    maxHR: num(pick(a, 'maxHR', 'maxHeartRate')),
    elevationGain: num(a.elevationGain),
    calories: num(a.calories),
    teAerobic: num(a.aerobicTrainingEffect),
    teAnaerobic: num(a.anaerobicTrainingEffect),
    teLabel: pick(a, 'trainingEffectLabel'),
    load: num(a.activityTrainingLoad),
    vo2max: num(a.vO2MaxValue),
    avgPower: num(a.avgPower),
    normPower: num(a.normPower),
    cadence: num(pick(a, 'averageRunningCadenceInStepsPerMinute', 'averageBikingCadenceInRevPerMinute')),
    hrZones: zones.some((z) => z !== null) ? zones.map((z) => z ?? 0) : null,
  };
}

export function normalizeSleep(raw) {
  const s = raw?.dailySleepDTO ?? raw;
  return {
    date: dateOf(pick(s, 'calendarDate')),
    sleepSeconds: num(s?.sleepTimeSeconds),
    deep: num(s?.deepSleepSeconds),
    light: num(s?.lightSleepSeconds),
    rem: num(s?.remSleepSeconds),
    awake: num(s?.awakeSleepSeconds),
    score: num(pick(s, 'sleepScores.overall.value', 'sleepScore', 'overallSleepScore.value')),
    restingHR: num(pick(raw, 'restingHeartRate', 'dailySleepDTO.restingHeartRate')),
    avgOvernightHrv: num(pick(raw, 'avgOvernightHrv', 'dailySleepDTO.avgOvernightHrv')),
    avgSleepStress: num(pick(s, 'avgSleepStress')),
  };
}

export function normalizeHrv(h) {
  return {
    date: dateOf(pick(h, 'calendarDate')),
    lastNight: num(pick(h, 'lastNightAvg', 'lastNight')),
    weekly: num(h?.weeklyAvg),
    high5: num(h?.lastNight5MinHigh),
    status: pick(h, 'status'),
    baselineLow: num(pick(h, 'baseline.balancedLow')),
    baselineHigh: num(pick(h, 'baseline.balancedUpper')),
    feedback: pick(h, 'feedbackPhrase'),
  };
}

export function normalizeBodyBattery(r) {
  const descriptors = asList(r?.bodyBatteryValueDescriptorDTOList);
  let levelIdx = 1;
  for (const d of descriptors) {
    if (d?.bodyBatteryValueDescriptorKey === 'bodyBatteryLevel') levelIdx = d.bodyBatteryValueDescriptorIndex;
  }
  const levels = asList(r?.bodyBatteryValuesArray)
    .map((row) => (Array.isArray(row) ? num(row[levelIdx]) : null))
    .filter((v) => v !== null);
  return {
    date: dateOf(pick(r, 'date', 'calendarDate')),
    charged: num(r?.charged),
    drained: num(r?.drained),
    high: levels.length ? Math.max(...levels) : null,
    low: levels.length ? Math.min(...levels) : null,
  };
}

export function normalizeStress(r) {
  const v = r?.values ?? r;
  return {
    date: dateOf(pick(r, 'calendarDate', 'date')),
    level: num(pick(v, 'overallStressLevel', 'averageStressLevel', 'avgStressLevel')),
    highSeconds: num(pick(v, 'highStressDuration')),
    restSeconds: num(pick(v, 'restStressDuration')),
  };
}

export function normalizeDaily(d) {
  return {
    date: dateOf(pick(d, 'calendarDate')),
    restingHR: num(pick(d, 'heartRate.restingValue', 'restingHeartRate')),
    steps: num(pick(d, 'movement.steps', 'totalSteps')),
    moderateMinutes: num(pick(d, 'intensityMinutes.moderate', 'intensityMinutes.moderateMinutes', 'moderateIntensityMinutes')),
    vigorousMinutes: num(pick(d, 'intensityMinutes.vigorous', 'intensityMinutes.vigorousMinutes', 'vigorousIntensityMinutes')),
  };
}

export function normalizeZones(payload) {
  return asList(payload, 'zones', 'heartRateZones').map((z) => ({
    sport: pick(z, 'sport') || 'DEFAULT',
    method: pick(z, 'trainingMethod'),
    floors: [1, 2, 3, 4, 5].map((i) => num(z[`zone${i}Floor`])),
    maxHR: num(z.maxHeartRateUsed),
    restingHR: num(z.restingHeartRateUsed),
    lthr: num(z.lactateThresholdHeartRateUsed),
  }));
}

export function normalizeProfile(p) {
  return {
    measurementSystem: pick(p, 'measurementSystem', 'userData.measurementSystem'),
    gender: pick(p, 'gender', 'userData.gender'),
    vo2MaxRunning: num(pick(p, 'vo2MaxRunning', 'userData.vo2MaxRunning')),
    vo2MaxCycling: num(pick(p, 'vo2MaxCycling', 'userData.vo2MaxCycling')),
    lactateThresholdHR: num(pick(p, 'lactateThresholdHeartRate', 'userData.lactateThresholdHeartRate')),
  };
}

export function normalizeFitnessAge(f) {
  const r = Array.isArray(f) ? f[0] : f;
  return {
    fitnessAge: num(pick(r, 'fitnessAge')),
    chronologicalAge: num(pick(r, 'chronologicalAge')),
    achievableFitnessAge: num(pick(r, 'achievableFitnessAge')),
    vo2Max: num(pick(r, 'vo2Max', 'vo2MaxValue', 'components.vo2Max.value')),
  };
}

// Counts non-null values per field so the dashboard can show what really arrived.
export function coverage(records) {
  const fields = {};
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      if (!(k in fields)) fields[k] = 0;
      if (v !== null && v !== undefined) fields[k]++;
    }
  }
  return { count: records.length, fields };
}

export function sampleKeys(rawRecords, limit = 20) {
  const keys = new Set();
  for (const r of rawRecords.slice(0, limit)) {
    const base = r?.dailySleepDTO ?? r;
    if (base && typeof base === 'object') Object.keys(base).forEach((k) => keys.add(k));
  }
  return [...keys].sort();
}
