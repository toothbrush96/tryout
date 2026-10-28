// Logging that cannot leak credentials: every line passes through redact(),
// which removes registered secrets (API keys, bearer tokens) plus anything
// shaped like a JWT or an Authorization header value.

const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

export function forgetSecret(value) {
  secrets.delete(value);
}

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const AUTH_VALUE = /\b(ApiKey|Bearer)\s+[^\s"',;]+/gi;

export function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out.replace(JWT, '[redacted-jwt]').replace(AUTH_VALUE, '$1 [redacted]');
}

let sink = (level, line) => (level === 'INFO' ? process.stdout : process.stderr).write(line + '\n');

export function setLogSink(fn) {
  sink = fn;
}

function write(level, message) {
  sink(level, `${new Date().toISOString()} ${level} ${redact(message)}`);
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};
