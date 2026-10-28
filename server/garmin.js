// Client for the Garmin Connect Personal API.
//
// Endpoints, auth flow and range limits follow Garmin's official client
// (github.com/garmin/connect-personal-api-python) and the Personal API
// Swagger reference. The API key is exchanged for a ~24 h JWT bearer token;
// the key itself is only ever sent to the token endpoint.

import { registerSecret, redact } from './log.js';

export const DEFAULT_BASE_URL = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const REFRESH_WINDOW_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;

export class GarminError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.status = status;
    this.path = path;
  }
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // fall through
  }
  throw new GarminError('Der Token-Endpunkt hat kein gültiges JWT geliefert.');
}

export class GarminClient {
  constructor(apiKey, { baseUrl = process.env.GARMIN_PERSONAL_API_BASE_URL || DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpires = 0;
    this.pendingToken = null;
    registerSecret(apiKey);
  }

  async bearer(force = false) {
    if (!force && this.token && this.tokenExpires - Date.now() > REFRESH_WINDOW_MS) return this.token;
    if (!this.pendingToken) {
      this.pendingToken = this.#exchange().finally(() => {
        this.pendingToken = null;
      });
    }
    return this.pendingToken;
  }

  async #exchange() {
    let res;
    try {
      res = await this.fetch(this.baseUrl + TOKEN_PATH, {
        method: 'POST',
        headers: { Accept: '*/*', Authorization: `ApiKey ${this.apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GarminError(`Garmin ist nicht erreichbar (${redact(err.message)}).`, { path: TOKEN_PATH });
    }
    if (res.status === 401 || res.status === 403) {
      throw new GarminError(
        'Garmin hat den API-Schlüssel abgelehnt. Er ist vermutlich abgelaufen oder wurde gelöscht – erstelle in Garmin Connect einen neuen und hinterlege ihn in den Einstellungen.',
        { status: res.status, path: TOKEN_PATH },
      );
    }
    if (!res.ok) {
      throw new GarminError(`Token-Abruf fehlgeschlagen (HTTP ${res.status}).`, { status: res.status, path: TOKEN_PATH });
    }
    const token = (await res.text()).trim();
    this.tokenExpires = jwtExpiry(token);
    registerSecret(token);
    this.token = token;
    return token;
  }

  // GET a Personal API path. Returns parsed JSON, null for empty bodies (204),
  // or a Buffer when raw=true. Retries once with a fresh token on 401.
  async get(path, params, { raw = false, retried = false } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const token = await this.bearer(retried);
    let res;
    try {
      res = await this.fetch(url, {
        headers: {
          Accept: raw ? 'application/zip, application/octet-stream' : 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GarminError(`Garmin ist nicht erreichbar (${redact(err.message)}).`, { path });
    }
    if (res.status === 401 && !retried) return this.get(path, params, { raw, retried: true });
    if (!res.ok) {
      throw new GarminError(`HTTP ${res.status}`, { status: res.status, path });
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GarminError('Antwort ist kein gültiges JSON.', { status: res.status, path });
    }
  }
}

// Splits [from, to] into consecutive windows of at most maxDays days.
export function windows(from, to, maxDays) {
  const out = [];
  let start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (start <= end) {
    const wEnd = new Date(Math.min(start.getTime() + (maxDays - 1) * 86400000, end.getTime()));
    out.push([iso(start), iso(wEnd)]);
    start = new Date(wEnd.getTime() + 86400000);
  }
  return out;
}

export function iso(d) {
  return d.toISOString().slice(0, 10);
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
