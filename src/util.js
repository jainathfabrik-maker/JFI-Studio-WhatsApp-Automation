import crypto from 'node:crypto';

/** Strip everything that is not a digit. Meta wants international format without "+". */
export function normalizePhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** Log-safe phone representation: enough to recognise, not enough to identify. */
export function maskPhone(value) {
  const digits = normalizePhone(value);
  if (digits.length <= 6) return '***';
  return `${digits.slice(0, 3)}***${digits.slice(-3)}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** YYYY-MM-DD for the given instant in the given IANA timezone. */
export function dateKeyInTz(timezone, now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

/** "Tue 3 Nov 2026" in the given IANA timezone (no comma — it becomes a WhatsApp template parameter). */
export function dateLabelInTz(timezone, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(new Date(now));
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('weekday')} ${pick('day')} ${pick('month')} ${pick('year')}`.trim();
}

/** Day-of-year, used to rotate pillars deterministically. */
export function dayOfYearInTz(timezone, now = Date.now()) {
  const key = dateKeyInTz(timezone, now);
  const [y, m, d] = key.split('-').map(Number);
  const start = Date.UTC(y, 0, 1);
  const current = Date.UTC(y, m - 1, d);
  return Math.floor((current - start) / 86_400_000) + 1;
}

export function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** URL-safe, unguessable id used for pack links. */
export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Split text into chunks of at most `max` characters, preferring line breaks
 * so a WhatsApp message never ends mid-word when it does not have to.
 */
export function chunkText(text, max = 3500) {
  const source = String(text ?? '');
  if (source.length <= max) return source ? [source] : [];
  const chunks = [];
  let remaining = source;
  while (remaining.length > max) {
    const window = remaining.slice(0, max);
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '));
    const cut = breakAt > max * 0.5 ? breakAt + 1 : max;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Strip control characters and collapse runs of whitespace on one line. */
export function flattenToSingleLine(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
