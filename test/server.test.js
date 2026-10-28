import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startMockGarmin, TEST_KEY } from './mock-garmin.js';

let mock, app, base, dataDir, cookie = '';
const output = [];

before(async () => {
  mock = await startMockGarmin();
  process.env.GARMIN_PERSONAL_API_BASE_URL = mock.url;
  const { createApp } = await import('../server/index.js');
  dataDir = await mkdtemp(path.join(tmpdir(), 'cockpit-'));
  const { setLogSink } = await import('../server/log.js');
  setLogSink((level, line) => output.push(line));
  app = createApp({ dataDir, setupCode: 'setup-123' });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  app.close();
  mock.server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function call(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'X-Requested-With': 'dashboard', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const isJson = (res.headers.get('content-type') || '').includes('json');
  return { status: res.status, headers: res.headers, text, json: isJson && text ? JSON.parse(text) : null };
}

const today = new Date().toISOString().slice(0, 10);
const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

test('reports unconfigured state', async () => {
  const r = await call('/api/status');
  assert.deepEqual(r.json, { configured: false, authenticated: false, setupCodeRequired: true });
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

test('setup requires the setup code and CSRF header', async () => {
  let r = await call('/api/setup', { method: 'POST', body: { password: 'a-long-password', apiKey: TEST_KEY } });
  assert.equal(r.status, 403);
  r = await call('/api/setup', { method: 'POST', body: { setupCode: 'setup-123', password: 'a-long-password', apiKey: TEST_KEY }, headers: { 'X-Requested-With': '' } });
  assert.equal(r.status, 403);
});

test('setup rejects a key Garmin refuses and stores nothing', async () => {
  const r = await call('/api/setup', { method: 'POST', body: { setupCode: 'setup-123', password: 'a-long-password', apiKey: 'wrong-key-abcdefgh' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'key-rejected');
  assert.equal((await call('/api/status')).json.configured, false);
});

test('setup stores the key encrypted with owner-only permissions', async () => {
  const r = await call('/api/setup', { method: 'POST', body: { setupCode: 'setup-123', password: 'a-long-password', apiKey: TEST_KEY } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const file = path.join(dataDir, 'credentials.json');
  const content = await readFile(file, 'utf8');
  assert.ok(!content.includes(TEST_KEY));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('dashboard data arrives normalized with coverage', async () => {
  const r = await call(`/api/data?from=${from}&to=${today}&today=${today}`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.ok(d.activities.length > 10);
  assert.ok(d.activities[0].avgHR > 0);
  assert.ok(d.activities[0].hrZones.length === 5);
  assert.ok(d.hrv.length > 100);
  assert.equal(d.sources.activities.fields.load, 0, 'synthetic data has no Garmin load');
  assert.equal(d.sources.fitnessAge.count, 0, 'empty 204 response counts as no data');
  assert.equal(d.hrZones[0].maxHR, 188);
  assert.ok(!r.text.includes(TEST_KEY));
  assert.ok(!/eyJ/.test(r.text), 'no bearer token in response');
  const paged = mock.calls.filter((c) => c.path.includes('activitylist')).length;
  assert.ok(paged >= 2);
});

test('the API key goes only to the token endpoint', () => {
  for (const c of mock.calls) {
    if (c.auth.includes(TEST_KEY)) assert.equal(c.path, '/personalapitoken-service/personal-api/personal-api-key/token');
  }
});

test('activity stream yields decoupling and splits', async () => {
  const d = (await call(`/api/data?from=${from}&to=${today}&today=${today}`)).json;
  const r = await call(`/api/activity/${d.activities[0].id}?split=1000`);
  assert.equal(r.status, 200);
  assert.equal(r.json.samples, 1800);
  assert.ok(r.json.splits.length >= 5);
  assert.ok(r.json.decoupling.value > 0, 'rising HR at constant speed means positive drift');
  assert.equal(r.json.splits[0].meters, 1000);
});

test('rejects bad input', async () => {
  assert.equal((await call('/api/data?from=x&to=y')).status, 400);
  assert.equal((await call('/api/activity/../../etc')).status, 404);
  assert.equal((await call('/api/activity/abc')).status, 400);
  assert.equal((await call('/../server/index.js')).status, 404);
});

test('login with wrong password fails, right password works', async () => {
  await call('/api/logout', { method: 'POST' });
  cookie = '';
  assert.equal((await call('/api/data?from=2026-01-01&to=2026-01-02')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'nope-nope-nope' } })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'a-long-password' } })).status, 200);
  assert.equal((await call('/api/status')).json.authenticated, true);
});

test('logs contain neither key, token nor query strings', () => {
  const all = output.join('');
  assert.ok(all.length > 0);
  assert.ok(!all.includes(TEST_KEY));
  assert.ok(!/eyJ/.test(all));
  assert.ok(!all.includes('from='));
});
