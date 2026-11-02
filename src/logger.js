import { isPlainObject } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SENSITIVE_KEY = /(token|secret|password|authorization|apikey|api_key|access_token|credential|cookie)/i;

const TOKEN_PATTERN = /\bEAA[A-Za-z0-9_-]{10,}\b/g;
const LONG_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;

/** Replace anything that looks like a live credential. */
export function scrubString(value) {
  return String(value)
    .replace(TOKEN_PATTERN, 'EAA***REDACTED***')
    .replace(LONG_SECRET_PATTERN, 'sk-***REDACTED***');
}

/** Deep-redact an object before it is logged: drop secret-shaped keys, scrub strings. */
export function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Structured JSON logger. One line per record, secrets scrubbed, no raw
 * payloads. `sink` is a function so tests can capture output.
 */
export function createLogger({ level = 'info', sink, bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));

  function emit(recordLevel, message, fields) {
    if (LEVELS[recordLevel] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: recordLevel,
      msg: scrubString(String(message ?? '')),
      ...bindings,
    };
    if (fields !== undefined) {
      if (isPlainObject(fields)) Object.assign(record, redact(fields));
      else record.detail = redact(fields);
    }
    try {
      write(record);
    } catch {
      // A broken sink must never take the service down.
    }
  }

  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(extra) {
      return createLogger({ level, sink: write, bindings: { ...bindings, ...extra } });
    },
  };
}
