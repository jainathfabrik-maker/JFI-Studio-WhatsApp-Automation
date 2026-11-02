import crypto from 'node:crypto';
import { timingSafeEqualString } from './util.js';

/**
 * Verify Meta's `x-hub-signature-256` header against the exact raw request
 * body using the app secret. Must run on the unparsed bytes: any re-serialise
 * changes the digest.
 */
export function verifySignature({ rawBody, header, appSecret }) {
  if (!appSecret) return { ok: false, reason: 'app-secret-missing' };
  if (typeof header !== 'string' || !header.startsWith('sha256=')) {
    return { ok: false, reason: 'signature-header-missing' };
  }
  const provided = header.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(provided)) return { ok: false, reason: 'signature-malformed' };

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody ?? Buffer.alloc(0))
    .digest('hex');

  const ok = timingSafeEqualString(provided.toLowerCase(), expected);
  return ok ? { ok: true } : { ok: false, reason: 'signature-mismatch' };
}

/** Meta's GET subscription handshake. Returns { ok, challenge, reason }. */
export function verifySubscription({ query, verifyToken }) {
  const mode = query?.['hub.mode'];
  const token = query?.['hub.verify_token'];
  const challenge = query?.['hub.challenge'];

  if (mode !== 'subscribe') return { ok: false, reason: 'wrong-mode' };
  if (!verifyToken) return { ok: false, reason: 'verify-token-not-configured' };
  if (!timingSafeEqualString(token, verifyToken)) return { ok: false, reason: 'token-mismatch' };
  if (challenge === undefined || challenge === null || String(challenge) === '') {
    return { ok: false, reason: 'challenge-missing' };
  }
  return { ok: true, challenge: String(challenge) };
}

const FAILURE_STATUSES = new Set(['failed']);

/**
 * Parse and act on a webhook payload.
 *
 * Everything here is fast and in-memory (logging, dedupe bookkeeping, a
 * read receipt) so the HTTP 200 goes out promptly. Anything slower belongs in
 * a queue, not in the webhook handler.
 */
export function processWebhookBody({ body, store, logger, whatsapp, autoMarkRead = false }) {
  const summary = { entries: 0, messages: 0, statuses: 0, duplicates: 0, failures: 0, ignored: 0 };

  const entries = Array.isArray(body?.entry) ? body.entry : [];
  summary.entries = entries.length;
  if (body?.object && body.object !== 'whatsapp_business_account') {
    summary.ignored += 1;
    logger.debug('Ignoring webhook for a different object type', { object: body.object });
    return summary;
  }

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};

      for (const message of value.messages ?? []) {
        const eventId = `msg:${message.id}`;
        if (!message.id || store.hasSeenEvent(eventId)) {
          summary.duplicates += 1;
          continue;
        }
        store.markEventSeen(eventId);
        summary.messages += 1;

        const from = message.from;
        if (from) store.recordInbound(from);

        // Type only. Never log message bodies, media ids or phone numbers.
        logger.info('Inbound WhatsApp message', {
          type: message.type ?? 'unknown',
          from: from ? `${String(from).slice(0, 3)}***${String(from).slice(-3)}` : undefined,
        });

        if (autoMarkRead && message.id) {
          whatsapp?.markRead?.(message.id)?.catch?.(() => {});
        }
      }

      for (const status of value.statuses ?? []) {
        const eventId = `status:${status.id}:${status.status}`;
        if (!status.id || store.hasSeenEvent(eventId)) {
          summary.duplicates += 1;
          continue;
        }
        store.markEventSeen(eventId);
        summary.statuses += 1;

        if (FAILURE_STATUSES.has(status.status)) {
          summary.failures += 1;
          const error = Array.isArray(status.errors) ? status.errors[0] : undefined;
          logger.error('WhatsApp reported a failed delivery', {
            status: status.status,
            code: error?.code,
            title: error?.title,
            detail: error?.error_data?.details,
          });
        } else {
          logger.info('WhatsApp delivery status', { status: status.status });
        }
      }
    }
  }

  return summary;
}
