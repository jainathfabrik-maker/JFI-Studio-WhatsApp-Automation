import { randomId, dateKeyInTz, chunkText, maskPhone } from './util.js';
import { packToText } from './content.js';

export class DeliveryError extends Error {
  constructor(message, { code, hint, status = 500 } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

/**
 * Build the template body parameters from the configured field list, so the
 * code matches whatever approved template the account actually has.
 */
export function buildTemplateParams(pack, fields) {
  return fields.map((field) => {
    const value = pack?.[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new DeliveryError(
        `Template body field "${field}" is empty on this pack, but WHATSAPP_TEMPLATE_BODY_FIELDS asks for it. Fix the variable or the template.`,
      );
    }
    return String(value);
  });
}

export function createDailyRunner({
  config,
  logger,
  store,
  whatsapp,
  content,
  now = () => Date.now(),
  safety = { blocked: false, reason: null },
}) {
  /**
   * Deliver a stored pack. Returns { accepted, messageIds, mode }.
   * "Accepted" means Meta returned a message id. It does NOT mean delivered —
   * delivery is confirmed only by the `statuses` webhook.
   */
  async function deliver(pack) {
    if (safety.blocked) {
      throw new DeliveryError(safety.reason ?? 'Delivery is blocked by the self-send guard.', {
        code: 'self-send-blocked',
        status: 409,
        hint: 'Set WHATSAPP_RECIPIENT_NUMBER to a different number you control, then redeploy.',
      });
    }

    const to = config.recipientNumber;

    if (config.deliveryMode === 'link') {
      if (!config.publicBaseUrl) {
        throw new DeliveryError(
          'PUBLIC_BASE_URL is not set, so the pack link cannot be built. Copy your service URL from the top of the Render service page into PUBLIC_BASE_URL and redeploy.',
          { code: 'public-base-url-missing', status: 409 },
        );
      }
      const packUrl = `${config.publicBaseUrl}/p/${pack.id}`;
      const bodyParams = buildTemplateParams(pack, config.templateBodyFields);
      const result = await whatsapp.sendTemplate({ to, bodyParams, urlButtonSuffix: pack.id });
      logger.info('Template accepted by Meta', { messageId: result.messageId, packUrl });
      return { accepted: true, messageIds: [result.messageId], mode: 'link', packUrl };
    }

    // Free-form text: only legal inside the 24-hour customer service window.
    if (!store.isWithinServiceWindow(to)) {
      throw new DeliveryError(
        'Refusing to send free-form text: the 24-hour customer service window is closed for this recipient. WhatsApp requires an approved template for business-initiated messages. Switch WHATSAPP_DELIVERY_MODE to "link", or have the recipient message the business number first.',
        { code: 'window-closed', status: 409 },
      );
    }

    const chunks = chunkText(packToText(pack), 3500);
    const messageIds = [];
    for (const [index, chunk] of chunks.entries()) {
      const result = await whatsapp.sendText({ to, body: chunk });
      messageIds.push(result.messageId);
      logger.info('Text message accepted by Meta', { part: index + 1, of: chunks.length, messageId: result.messageId });
    }
    return { accepted: true, messageIds, mode: 'text' };
  }

  /**
   * The whole daily job: generate, persist, deliver, record.
   * Idempotent per calendar day in the configured timezone — a restart, a
   * second instance, or a duplicate scheduler hit cannot send twice.
   */
  async function runDaily({ trigger = 'manual', force = false, nowMs = now() } = {}) {
    const dateKey = dateKeyInTz(config.timezone, nowMs);
    const lock = store.tryAcquireRunLock(dateKey);

    if (!lock.acquired) {
      logger.info('Daily run skipped', { trigger, date: dateKey, reason: lock.reason });
      return { ok: true, skipped: true, reason: lock.reason, date: dateKey };
    }

    try {
      const existing = store.getPackByDate(dateKey);
      if (existing?.status === 'sent' && !force) {
        logger.info('Daily run skipped: pack already sent today', { trigger, date: dateKey });
        return { ok: true, skipped: true, reason: 'already-sent-today', date: dateKey, packId: existing.id };
      }

      logger.info('Daily run started', { trigger, date: dateKey, mode: config.deliveryMode, source: config.effectiveContentSource });

      const pack = await content.generate({ nowMs });
      const stored = await store.savePack({ ...pack, id: existing?.id ?? randomId(), status: 'generated' });
      logger.info('Content pack generated', { packId: stored.id, pillar: stored.pillar, source: stored.source });

      let delivery;
      try {
        delivery = await deliver(stored);
      } catch (error) {
        await store.updatePack(stored.id, {
          status: 'failed',
          failure: { message: error.message, code: error.code ?? null, at: new Date(nowMs).toISOString() },
        });
        throw error;
      }

      await store.updatePack(stored.id, {
        status: 'sent',
        deliveredAt: new Date(nowMs).toISOString(),
        messageIds: delivery.messageIds,
        mode: delivery.mode,
      });

      store.recordRun({
        date: dateKey,
        status: 'sent',
        trigger,
        packId: stored.id,
        messageIds: delivery.messageIds,
        mode: delivery.mode,
      });

      logger.info('Daily run finished; Meta accepted the message', {
        packId: stored.id,
        messageIds: delivery.messageIds,
        to: maskPhone(config.recipientNumber),
        note: 'Accepted is not delivered — confirm with the WhatsApp status webhook.',
      });

      return {
        ok: true,
        skipped: false,
        date: dateKey,
        packId: stored.id,
        messageIds: delivery.messageIds,
        mode: delivery.mode,
        accepted: true,
        deliveryConfirmed: false,
      };
    } catch (error) {
      store.recordRun({
        date: dateKey,
        status: 'failed',
        trigger,
        error: error.message,
      });
      logger.error('Daily run failed', {
        trigger,
        date: dateKey,
        name: error.name,
        message: error.message,
        hint: error.hint,
        code: error.code,
      });
      throw error;
    } finally {
      store.releaseRunLock();
    }
  }

  /** Re-send the most recent pack. Used by the safe test path and by retries. */
  async function resendLatest({ force = false } = {}) {
    const pack = store.latestPack();
    if (!pack) {
      throw new DeliveryError('No pack has been generated yet. Run the daily job once before resending.', {
        code: 'no-pack',
        status: 409,
      });
    }
    const delivery = await deliver(pack);
    await store.updatePack(pack.id, {
      status: 'sent',
      messageIds: delivery.messageIds,
      mode: delivery.mode,
      resentAt: new Date(now()).toISOString(),
    });
    logger.info('Latest pack re-sent', { packId: pack.id, messageIds: delivery.messageIds, force });
    return { ok: true, packId: pack.id, messageIds: delivery.messageIds, mode: delivery.mode, accepted: true, deliveryConfirmed: false };
  }

  return { runDaily, resendLatest, deliver };
}
