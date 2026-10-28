import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../public/js/analysis.js';
import { redact, registerSecret } from '../server/log.js';
import { alignedWindows } from '../server/datasets.js';
import { normalizeActivity, normalizeBodyBattery, normalizeSleep } from '../server/normalize.js';

const zones = [{ sport: 'DEFAULT', floors: [110, 125, 145, 160, 172], maxHR: 188, restingHR: 50, lthr: null }];

test('classifies sessions by time in zones', () => {
  const mk = (z, duration = 3600) => ({ type: 'running', duration, hrZones: z.map((f) => f * duration) });
  assert.equal(A.classifySession(mk([0.1, 0.8, 0.1, 0, 0]), zones).key, 'base');
  assert.equal(A.classifySession(mk([0.1, 0.8, 0.1, 0, 0], 6000), zones).key, 'long');
  assert.equal(A.classifySession(mk([0.1, 0.3, 0.4, 0.2, 0]), zones).key, 'threshold');
  assert.equal(A.classifySession(mk([0.2, 0.3, 0.2, 0.15, 0.15]), zones).key, 'vo2');
  assert.equal(A.classifySession(mk([0.7, 0.3, 0, 0, 0], 1800), zones).key, 'recovery');
});

test('falls back to average HR zone, or marks it unclassifiable', () => {
  assert.equal(A.classifySession({ type: 'running', duration: 3000, avgHR: 150, hrZones: null }, zones).key, 'tempo');
  assert.equal(A.classifySession({ type: 'running', duration: 3000, avgHR: null, hrZones: null }, zones).key, 'unclassified');
  assert.equal(A.classifySession({ type: 'running', duration: 3000, avgHR: 150, hrZones: null }, []).key, 'unclassified');
});

test('load model prefers Garmin load, then zone TRIMP, then Banister', () => {
  const g = A.chooseLoadModel([{ avgHR: 140, duration: 1, load: 80 }], null);
  assert.equal(g.key, 'garmin');
  const e = A.chooseLoadModel([{ avgHR: 140, duration: 1, load: null, hrZones: [1, 1, 1, 1, 1] }], null);
  assert.equal(e.key, 'edwards');
  const b = A.chooseLoadModel([{ avgHR: 140, duration: 1, load: null, hrZones: null }], 'FEMALE');
  assert.equal(b.key, 'banister');
  assert.equal(b.female, true);
  assert.equal(A.activityLoad({ hrZones: [600, 600, 0, 0, 0] }, e, {}), 10 + 20);
});

test('banister TRIMP needs resting and max HR', () => {
  const m = { key: 'banister', female: false };
  assert.equal(A.activityLoad({ avgHR: 150, duration: 3600 }, m, { maxHR: null, restingHR: 50 }), null);
  const v = A.activityLoad({ avgHR: 150, duration: 3600 }, m, { maxHR: 190, restingHR: 50 });
  assert.ok(v > 90 && v < 140);
});

test('pace at reference HR comes from a regression and refuses thin data', () => {
  const runs = [130, 135, 140, 145, 150, 155].map((hr, i) => ({ avgHR: hr, avgSpeed: 2.5 + i * 0.1, duration: 2400 }));
  const r = A.paceAtHR(runs, 140);
  assert.ok(Math.abs(r.value - 1000 / 2.7) < 1);
  assert.equal(A.paceAtHR(runs.slice(0, 3), 140).value, null);
});

test('recovery check reports missing inputs instead of guessing', () => {
  const r = A.recoveryCheck({ hrv: [], sleep: [], dailies: [], bodyBattery: [] }, '2026-10-28', null);
  assert.equal(r.verdict.state, 'missing');
  assert.ok(r.signals.every((s) => s.state === 'missing'));
});

test('recovery check flags low HRV and elevated resting HR', () => {
  const today = '2026-10-28';
  const dailies = A.dateRange('2026-10-01', '2026-10-27').map((d) => ({ date: d, restingHR: 48 }));
  dailies.push({ date: today, restingHR: 55 });
  const data = { hrv: [{ date: today, lastNight: 40, baselineLow: 50, baselineHigh: 65, status: 'LOW' }], sleep: [{ date: today, sleepSeconds: 7.5 * 3600, score: 80 }], dailies, bodyBattery: [] };
  const r = A.recoveryCheck(data, today, null);
  assert.equal(r.signals.find((s) => s.key === 'hrv').state, 'serious');
  assert.equal(r.signals.find((s) => s.key === 'rhr').state, 'serious');
  assert.equal(r.verdict.state, 'serious');
});

test('periods are equal length and adjacent', () => {
  const p = A.periods('2026-10-28', 28);
  assert.equal(p.cur.from, '2026-10-01');
  assert.equal(p.prev.to, '2026-09-30');
  assert.equal(A.daysBetween(p.prev.from, p.prev.to) + 1, 28);
  assert.equal(p.fetch.from, A.addDays(p.prev.from, -42));
});

test('formatters', () => {
  assert.equal(A.fmtPace(299.6), '5:00');
  assert.equal(A.fmtPace(330), '5:30');
  assert.equal(A.fmtHours(1.5), '1:30 h');
  assert.equal(A.fmtDuration(3725), '1:02:05');
});

test('aligned windows are reusable across ranges', () => {
  const a = alignedWindows('2026-01-10', '2026-03-01', 31);
  const b = alignedWindows('2026-01-20', '2026-03-01', 31);
  assert.deepEqual(a.slice(-2), b.slice(-2));
  assert.ok(a.every(([s, e]) => A.daysBetween(s, e) === 30));
});

test('redact removes secrets, JWTs and auth header values', () => {
  registerSecret('super-secret-key-xyz');
  const out = redact('key super-secret-key-xyz token eyJhbGciOi.eyJleHAiOjF9.abc Authorization: Bearer abc123');
  assert.ok(!out.includes('super-secret-key-xyz'));
  assert.ok(!out.includes('eyJhbGciOi'));
  assert.ok(!out.includes('abc123'));
});

test('normalizers keep missing fields null', () => {
  const a = normalizeActivity({ activityId: 1, startTimeLocal: '2026-10-01 07:00:00', activityType: { typeKey: 'running' } });
  assert.equal(a.date, '2026-10-01');
  assert.equal(a.avgHR, null);
  assert.equal(a.load, null);
  assert.equal(a.hrZones, null);
  const s = normalizeSleep({ dailySleepDTO: { calendarDate: '2026-10-01', sleepTimeSeconds: 100 } });
  assert.equal(s.sleepSeconds, 100);
  assert.equal(s.score, null);
  const bb = normalizeBodyBattery({ date: '2026-10-01', bodyBatteryValuesArray: [[1, 30], [2, 80], [3, null]] });
  assert.equal(bb.high, 80);
  assert.equal(bb.low, 30);
});

test('analyze runs end to end on sparse data', () => {
  const data = { range: { from: '2026-07-01', to: '2026-10-28' }, activities: [], sleep: [], hrv: [], bodyBattery: [], stress: [], dailies: [], hrZones: [], profile: null, sources: {} };
  const ctx = A.analyze(data, { today: '2026-10-28', days: 28 });
  assert.equal(ctx.model.key, 'none');
  assert.equal(ctx.summary.cur.sessions, 0);
  assert.deepEqual(ctx.insights, []);
});
