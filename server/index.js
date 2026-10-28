import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { log, forgetSecret } from './log.js';
import { CredentialStore, CredentialError, validatePassword, normalizeApiKey } from './credentials.js';
import { GarminClient, GarminError } from './garmin.js';
import { DatasetCache, loadDashboardData } from './datasets.js';
import { extractFirstFit, parseFitRecords, downsample } from './fit.js';
import { decoupling, splits } from './stream.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC_EXTRA = { '/vendor/chart.umd.js': path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.js') };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function createApp({ dataDir = path.join(ROOT, 'data'), setupCode, trustProxy = false, fetchImpl } = {}) {
  const store = new CredentialStore(dataDir);
  const sessions = new Map();
  const failures = new Map();

  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '?';
  }

  function isHttps(req) {
    return req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  function cookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  }

  function sessionCookie(req, value, maxAge) {
    const attrs = [`sid=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (isHttps(req)) attrs.push('Secure');
    return attrs.join('; ');
  }

  function getSession(req) {
    const sid = cookie(req, 'sid');
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) {
      endSession(sid);
      return null;
    }
    s.lastSeen = now;
    return s;
  }

  function endSession(sid) {
    const s = sessions.get(sid);
    if (s) forgetSecret(s.client.apiKey);
    sessions.delete(sid);
  }

  function startSession(apiKey) {
    const sid = randomBytes(32).toString('base64url');
    const now = Date.now();
    sessions.set(sid, { client: new GarminClient(apiKey, { fetchImpl }), cache: new DatasetCache(), created: now, lastSeen: now });
    return sid;
  }

  function throttled(req) {
    const f = failures.get(clientIp(req));
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  function recordFailure(req) {
    const ip = clientIp(req);
    const f = failures.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 3) f.until = Date.now() + Math.min(2 ** (f.count - 3), 900) * 1000;
    failures.set(ip, f);
  }

  async function readJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpProblem(415, 'JSON erwartet.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpProblem(413, 'Anfrage zu gross.');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw new HttpProblem(400, 'Ungültiges JSON.');
    }
  }

  // Cookies are SameSite=Strict; the custom header and the Origin check are a
  // second layer against cross-site form posts.
  function checkCsrf(req) {
    if (req.headers['x-requested-with'] !== 'dashboard') throw new HttpProblem(403, 'Fehlender Anfrage-Header.');
    const origin = req.headers.origin;
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        throw new HttpProblem(403, 'Ungültige Herkunft.');
      }
      if (host !== req.headers.host) throw new HttpProblem(403, 'Fremde Herkunft.');
    }
  }

  async function verifyKeyWithGarmin(apiKey) {
    const probe = new GarminClient(apiKey, { fetchImpl });
    try {
      await probe.bearer(true);
    } finally {
      forgetSecret(apiKey);
    }
  }

  const routes = {
    'GET /api/status': async (req) => {
      const configured = await store.exists();
      return { configured, authenticated: Boolean(getSession(req)), setupCodeRequired: !configured && Boolean(setupCode) };
    },

    'POST /api/setup': async (req, res) => {
      checkCsrf(req);
      if (await store.exists()) throw new HttpProblem(409, 'Bereits eingerichtet.');
      const wait = throttled(req);
      if (wait) throw new HttpProblem(429, `Zu viele Versuche. Bitte ${wait} s warten.`);
      const body = await readJson(req);
      if (setupCode && !safeEqual(String(body.setupCode || ''), setupCode)) {
        recordFailure(req);
        throw new HttpProblem(403, 'Einrichtungscode falsch.');
      }
      validatePassword(body.password);
      const apiKey = normalizeApiKey(body.apiKey);
      await verifyKeyWithGarmin(apiKey);
      await store.save(body.password, apiKey);
      log.info('Zugangsdaten verschlüsselt gespeichert');
      res.setHeader('Set-Cookie', sessionCookie(req, startSession(apiKey), SESSION_MAX_MS / 1000));
      return { ok: true };
    },

    'POST /api/login': async (req, res) => {
      checkCsrf(req);
      const wait = throttled(req);
      if (wait) throw new HttpProblem(429, `Zu viele Versuche. Bitte ${wait} s warten.`);
      if (!(await store.exists())) throw new HttpProblem(409, 'Noch nicht eingerichtet.');
      const body = await readJson(req);
      let apiKey;
      try {
        apiKey = await store.unlock(body.password);
      } catch (err) {
        if (err instanceof CredentialError) {
          recordFailure(req);
          throw new HttpProblem(401, 'Passwort falsch.');
        }
        throw err;
      }
      failures.delete(clientIp(req));
      res.setHeader('Set-Cookie', sessionCookie(req, startSession(apiKey), SESSION_MAX_MS / 1000));
      return { ok: true };
    },

    'POST /api/logout': async (req, res) => {
      checkCsrf(req);
      const sid = cookie(req, 'sid');
      if (sid) endSession(sid);
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return { ok: true };
    },

    'POST /api/key': async (req) => {
      checkCsrf(req);
      const session = requireSession(req);
      const body = await readJson(req);
      await reauth(req, body.password);
      const apiKey = normalizeApiKey(body.apiKey);
      await verifyKeyWithGarmin(apiKey);
      await store.save(body.password, apiKey);
      forgetSecret(session.client.apiKey);
      session.client = new GarminClient(apiKey, { fetchImpl });
      session.cache.clear();
      log.info('API-Schlüssel ersetzt');
      return { ok: true };
    },

    'POST /api/reset': async (req, res) => {
      checkCsrf(req);
      requireSession(req);
      const body = await readJson(req);
      await reauth(req, body.password);
      await store.remove();
      for (const sid of [...sessions.keys()]) endSession(sid);
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      log.info('Zugangsdaten gelöscht');
      return { ok: true };
    },

    'GET /api/data': async (req, res, url) => {
      const session = requireSession(req);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const today = url.searchParams.get('today') || to;
      if (![from, to, today].every((d) => DATE.test(d || '')) || from > to) throw new HttpProblem(400, 'Ungültiger Zeitraum.');
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 800) throw new HttpProblem(400, 'Zeitraum zu lang (max. 800 Tage).');
      return loadDashboardData(session.client, session.cache, { from, to, today, force: url.searchParams.get('refresh') === '1' });
    },

    'GET /api/activity': async (req, res, url, id) => {
      const session = requireSession(req);
      if (!/^\d{1,20}$/.test(id)) throw new HttpProblem(400, 'Ungültige Aktivitäts-ID.');
      const split = Math.min(Math.max(Number(url.searchParams.get('split')) || 1000, 100), 10000);
      const cacheKey = `stream:${id}:${split}`;
      const cached = session.cache.get(cacheKey);
      if (cached) return cached;
      const zip = await session.client.get(`/download-service/files/activity/${id}`, undefined, { raw: true });
      const records = parseFitRecords(extractFirstFit(zip));
      const result = {
        id,
        samples: records.length,
        fields: ['hr', 'speed', 'distance', 'power', 'cadence', 'altitude'].filter((f) => records.some((r) => r[f] !== undefined)),
        decoupling: decoupling(records),
        splits: splits(records, split),
        stream: downsample(records),
      };
      session.cache.set(cacheKey, result, 6 * 60 * 60 * 1000);
      return result;
    },
  };

  function requireSession(req) {
    const s = getSession(req);
    if (!s) throw new HttpProblem(401, 'Nicht angemeldet.');
    return s;
  }

  async function reauth(req, password) {
    const wait = throttled(req);
    if (wait) throw new HttpProblem(429, `Zu viele Versuche. Bitte ${wait} s warten.`);
    try {
      await store.unlock(password);
    } catch (err) {
      if (err instanceof CredentialError) {
        recordFailure(req);
        throw new HttpProblem(401, 'Passwort falsch.');
      }
      throw err;
    }
  }

  async function serveStatic(req, res, pathname) {
    let file = STATIC_EXTRA[pathname];
    if (!file) {
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'text/plain', 'Not found');
    }
    try {
      const body = await fs.readFile(file);
      res.setHeader('Cache-Control', 'no-cache');
      return send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', body);
    } catch {
      return send(res, 404, 'text/plain', 'Not found');
    }
  }

  return http.createServer(async (req, res) => {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) {
        const [, , name, id] = url.pathname.split('/');
        const handler = routes[`${req.method} /api/${name}`];
        if (!handler || (id !== undefined && name !== 'activity')) throw new HttpProblem(404, 'Unbekannter Endpunkt.');
        res.setHeader('Cache-Control', 'no-store');
        const result = await handler(req, res, url, id);
        send(res, 200, 'application/json', JSON.stringify(result));
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res, url.pathname);
      } else {
        send(res, 405, 'text/plain', 'Method not allowed');
      }
    } catch (err) {
      const { status, message, code } = toProblem(err);
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      send(res, status, 'application/json', JSON.stringify({ error: message, code }));
    } finally {
      // Path only: query strings never reach the log.
      log.info(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
}

class HttpProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toProblem(err) {
  if (err instanceof HttpProblem) return err;
  if (err instanceof CredentialError) return { status: 400, message: err.message };
  if (err instanceof GarminError) {
    if (err.path.includes('personalapitoken') && (err.status === 401 || err.status === 403)) return { status: 401, code: 'key-rejected', message: err.message };
    if (err.status === 404) return { status: 404, message: 'Von Garmin nicht gefunden (404).' };
    if (err.status === 429) return { status: 429, message: 'Garmin drosselt die Anfragen (429). Bitte später erneut versuchen.' };
    return { status: 502, message: `Garmin-Fehler: ${err.message}` };
  }
  return { status: 500, message: 'Interner Fehler.' };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res, status, type, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
  const store = new CredentialStore(dataDir);
  let setupCode = process.env.SETUP_CODE || null;
  if (!(await store.exists()) && !setupCode) {
    setupCode = randomBytes(6).toString('hex');
    // The setup code only allows the first-time setup; it is not a credential for Garmin.
    process.stdout.write(`\nEinrichtungscode für die Ersteinrichtung: ${setupCode}\n\n`);
  }
  createApp({ dataDir, setupCode, trustProxy: process.env.TRUST_PROXY === '1' }).listen(port, host, () => {
    log.info(`Dashboard läuft auf http://${host}:${port}`);
  });
}
