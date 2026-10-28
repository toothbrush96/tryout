// Synthetic stand-in for the Garmin Personal API, used only by the tests.
// All values are generated; nothing here resembles a real account.

import http from 'node:http';
import { deflateRawSync } from 'node:zlib';

export const TEST_KEY = 'test-personal-api-key-0123456789';

function jwt(expSeconds) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ exp: expSeconds, sub: 'synthetic' })}.sig`;
}

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
function days(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) out.push(iso(t));
  return out;
}
// Deterministic pseudo-random per date.
function rnd(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

export function activitiesFor(from, to) {
  const out = [];
  for (const d of days(from, to)) {
    const r = rnd(d);
    if (r < 0.35) continue;
    const run = r < 0.85;
    const dur = run ? 1800 + Math.round(r * 4000) : 3600 + Math.round(r * 5000);
    const speed = run ? 2.6 + r * 0.9 : 7 + r * 2;
    const hr = 128 + Math.round(r * 35);
    const zones = [0.15, 0.55, 0.15, 0.1, 0.05].map((f, i) => Math.round(dur * (i === 4 && r > 0.75 ? 0.12 : f)));
    out.push({
      activityId: Number(d.replaceAll('-', '')) * 10,
      activityName: run ? 'Synthetischer Lauf' : 'Synthetische Ausfahrt',
      startTimeLocal: `${d} 07:30:00`,
      activityType: { typeKey: run ? 'running' : 'road_biking', parentTypeId: run ? 1 : 2 },
      distance: speed * dur,
      duration: dur,
      movingDuration: dur - 30,
      averageSpeed: speed,
      averageHR: hr,
      maxHR: hr + 20,
      elevationGain: 40 + r * 200,
      aerobicTrainingEffect: 2 + r * 2,
      anaerobicTrainingEffect: r * 2,
      ...Object.fromEntries(zones.map((z, i) => [`hrTimeInZone_${i + 1}`, z])),
    });
  }
  return out;
}

function fitFile() {
  // Definition + 1800 record messages (timestamp, hr, distance, speed).
  const recs = [];
  const def = Buffer.from([0x40, 0, 0, 20, 0, 4, 253, 4, 0x86, 3, 1, 0x02, 5, 4, 0x86, 6, 2, 0x84]);
  recs.push(def);
  const t0 = 1_100_000_000;
  let dist = 0;
  for (let i = 0; i < 1800; i++) {
    const speed = 3.0;
    dist += speed;
    const b = Buffer.alloc(12);
    b.writeUInt8(0x00, 0);
    b.writeUInt32LE(t0 + i, 1);
    b.writeUInt8(140 + Math.floor(i / 120), 5);
    b.writeUInt32LE(Math.round(dist * 100), 6);
    b.writeUInt16LE(speed * 1000, 10);
    recs.push(b);
  }
  const data = Buffer.concat(recs);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt16LE(2100, 2);
  header.writeUInt32LE(data.length, 4);
  header.write('.FIT', 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(2)]);
}

export function zipOf(name, content) {
  const comp = deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd]);
}

export function startMockGarmin() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' });
    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/personalapitoken-service/personal-api/personal-api-key/token') {
      if (req.method !== 'POST' || req.headers.authorization !== `ApiKey ${TEST_KEY}`) {
        res.writeHead(401);
        return res.end('{"message":"invalid credentials"}');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(jwt(Math.floor(Date.now() / 1000) + 86400));
    }
    if (!req.headers.authorization?.startsWith('Bearer ')) {
      res.writeHead(401);
      return res.end();
    }
    const q = Object.fromEntries(url.searchParams);
    let m;
    if (url.pathname === '/activitylist-service/activities/search/activities') {
      const all = activitiesFor(q.startDate, q.endDate).reverse();
      return json(all.slice(Number(q.start), Number(q.start) + Number(q.limit)));
    }
    if (url.pathname === '/sleep-service/sleep/dailySleepSummariesByDate') {
      return json(days(q.startDate, q.endDate).map((d) => ({ calendarDate: d, sleepTimeSeconds: 24000 + rnd(d + 's') * 6000, deepSleepSeconds: 5000, lightSleepSeconds: 14000, remSleepSeconds: 5000, awakeSleepSeconds: 600, sleepScores: { overall: { value: 60 + Math.round(rnd(d + 'q') * 35) } } })));
    }
    if ((m = url.pathname.match(/^\/hrv-service\/hrv\/daily\/(.+)\/(.+)$/))) {
      return json({ hrvSummaries: days(m[1], m[2]).map((d) => ({ calendarDate: d, lastNightAvg: 50 + Math.round(rnd(d + 'h') * 20), weeklyAvg: 58, status: 'BALANCED', baseline: { balancedLow: 52, balancedUpper: 66 } })) });
    }
    if (url.pathname === '/wellness-service/wellness/bodyBattery/reports/daily') {
      return json(days(q.startDate, q.endDate).map((d) => ({ date: d, charged: 60, drained: 55, bodyBatteryValueDescriptorDTOList: [{ bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: 'timestamp' }, { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' }], bodyBatteryValuesArray: [[1, 20], [2, 70 + Math.round(rnd(d) * 25)], [3, 30]] })));
    }
    if ((m = url.pathname.match(/^\/usersummary-service\/stats\/stress\/daily\/(.+)\/(.+)$/))) {
      return json(days(m[1], m[2]).map((d) => ({ calendarDate: d, values: { overallStressLevel: 20 + Math.round(rnd(d + 'x') * 20) } })));
    }
    if (url.pathname === '/usersummary-service/v2/dailysummaries') {
      return json({ data: days(q.startDate, q.endDate).map((d) => ({ calendarDate: d, heartRate: { restingValue: 48 + Math.round(rnd(d + 'r') * 4) }, movement: { steps: 9000 } })) });
    }
    if (url.pathname === '/biometric-service/heartRateZones/v2') {
      return json([{ sport: 'DEFAULT', trainingMethod: 'HR_RESERVE', zone1Floor: 110, zone2Floor: 125, zone3Floor: 145, zone4Floor: 160, zone5Floor: 172, maxHeartRateUsed: 188, restingHeartRateUsed: 50 }]);
    }
    if (url.pathname === '/userprofile-service/userprofile/settings') return json({ measurementSystem: 'metric' });
    if (url.pathname.startsWith('/fitnessage-service/fitnessage/v2/')) {
      res.writeHead(204);
      return res.end();
    }
    if ((m = url.pathname.match(/^\/download-service\/files\/activity\/(\d+)$/))) {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      return res.end(zipOf(`${m[1]}_ACTIVITY.fit`, fitFile()));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
