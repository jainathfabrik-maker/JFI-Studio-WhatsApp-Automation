import { sleep } from './util.js';

export class TransportError extends Error {
  constructor(message, { retryable = true, cause } = {}) {
    super(message);
    this.name = 'TransportError';
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30_000, retryAfter * 1000);
  }
  const base = Math.min(8000, 400 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/**
 * One JSON-over-HTTP call with a hard timeout and bounded exponential backoff.
 *
 * Resolves with { ok, status, data, attempts, retryable } for every HTTP
 * response, including 4xx/5xx — callers map provider error bodies themselves.
 * Throws TransportError only when the network, DNS or the timeout failed after
 * every attempt, because there is no response to inspect.
 */
export async function requestJson(
  url,
  {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 15_000,
    maxRetries = 2,
    label = 'request',
    fetchImpl = globalThis.fetch,
  } = {},
) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const raw = await response.text();
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = { raw: raw.slice(0, 500) };
        }
      }

      if (response.ok) {
        return { ok: true, status: response.status, data, attempts: attempt, retryable: false };
      }

      const retryable = RETRYABLE_STATUS.has(response.status);
      if (retryable && attempt <= maxRetries) {
        await sleep(backoffMs(attempt, response.headers?.get?.('retry-after')));
        continue;
      }
      return { ok: false, status: response.status, data, attempts: attempt, retryable };
    } catch (error) {
      lastError = error;
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (attempt <= maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : (error?.message ?? 'network error');
      throw new TransportError(`${label} failed after ${attempt} attempt(s): ${reason}`, {
        retryable: true,
        cause: error,
      });
    }
  }

  throw new TransportError(`${label} failed: ${lastError?.message ?? 'unknown error'}`, {
    retryable: true,
    cause: lastError,
  });
}
