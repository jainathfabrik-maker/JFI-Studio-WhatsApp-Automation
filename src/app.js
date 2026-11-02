import express from 'express';
import { verifySignature, verifySubscription, processWebhookBody } from './webhook.js';
import { renderPackPage } from './packPage.js';
import { timingSafeEqualString } from './util.js';

const SERVICE_NAME = 'jfi-studio-whatsapp-automation';
const SERVICE_VERSION = '2.0.0';

/** Wrap an async handler so a rejection reaches the error middleware. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function errorPayload(error, { isProduction }) {
  const body = { ok: false, error: error.message };
  if (error.hint) body.hint = error.hint;
  if (error.code) body.code = error.code;
  if (!isProduction && error.stack) body.stack = error.stack;
  return body;
}

export function createApp({ config, logger, store, whatsapp, runner, safety = { blocked: false, reason: null } }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Keep the exact bytes: the webhook HMAC is computed over them.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  function requireAdmin(req, res, next) {
    if (!config.adminToken) {
      return res.status(503).json({
        ok: false,
        error: 'ADMIN_TRIGGER_TOKEN is not configured, so admin endpoints are disabled.',
        hint: 'Set ADMIN_TRIGGER_TOKEN in the environment to enable manual runs.',
      });
    }
    const header = req.get('authorization') ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !timingSafeEqualString(provided, config.adminToken)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized.' });
    }
    return next();
  }

  // --- Health ---------------------------------------------------------------
  // Deliberately cheap and dependency-free: Render restarts a service whose
  // health check fails, so this must not touch the network or the disk.
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // --- Status ---------------------------------------------------------------
  app.get('/status', (_req, res) => {
    const lastRun = store.getLastRun();
    res.json({
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      config: {
        deliveryMode: config.deliveryMode,
        contentSource: config.effectiveContentSource,
        graphApiVersion: config.graphApiVersion,
        timezone: config.timezone,
        internalCron: config.enableInternalCron,
        templateName: config.templateName,
        templateLanguage: config.templateLanguage,
        templateBodyFields: config.templateBodyFields,
      },
      deliveryBlocked: safety.blocked,
      deliveryBlockedReason: safety.blocked ? safety.reason : null,
      lastRun: lastRun
        ? { date: lastRun.date, status: lastRun.status, at: lastRun.at, packId: lastRun.packId ?? null, error: lastRun.error ?? null }
        : null,
      note: 'A "sent" status here means Meta accepted the message. Delivery is confirmed only by the WhatsApp status webhook.',
    });
  });

  // --- Meta webhook ---------------------------------------------------------
  app.get('/webhook', (req, res) => {
    const result = verifySubscription({ query: req.query, verifyToken: config.verifyToken });
    if (!result.ok) {
      logger.warn('Webhook verification rejected', { reason: result.reason });
      return res.sendStatus(403);
    }
    logger.info('Webhook verification succeeded');
    return res.status(200).type('text/plain').send(result.challenge);
  });

  app.post('/webhook', (req, res) => {
    const signature = verifySignature({
      rawBody: req.rawBody,
      header: req.get('x-hub-signature-256'),
      appSecret: config.appSecret,
    });

    if (!signature.ok) {
      logger.warn('Webhook rejected: bad signature', { reason: signature.reason });
      return res.sendStatus(401);
    }

    try {
      const summary = processWebhookBody({
        body: req.body,
        store,
        logger,
        whatsapp,
        autoMarkRead: false,
      });
      logger.debug('Webhook processed', summary);
    } catch (error) {
      // Acknowledge anyway: Meta retries on non-2xx, and a parsing bug here
      // must not turn into an endless retry storm.
      logger.error('Webhook processing error', { message: error.message });
    }

    return res.sendStatus(200);
  });

  // --- Admin ----------------------------------------------------------------
  app.post(
    '/admin/run-daily',
    requireAdmin,
    wrap(async (req, res) => {
      const force = req.body?.force === true;
      const result = await runner.runDaily({ trigger: 'admin', force });
      res.json(result);
    }),
  );

  app.post(
    '/admin/resend-latest',
    requireAdmin,
    wrap(async (_req, res) => {
      const result = await runner.resendLatest();
      res.json(result);
    }),
  );

  app.get(
    '/admin/diagnostics',
    requireAdmin,
    wrap(async (_req, res) => {
      const checks = { phoneNumber: null, businessAccount: null };
      try {
        checks.phoneNumber = await whatsapp.getDisplayPhoneNumber();
      } catch (error) {
        checks.phoneNumber = { error: error.message, hint: error.hint ?? null };
      }
      res.json({
        ok: true,
        checks,
        recipientConfigured: Boolean(config.recipientNumber),
        senderMatchesRecipient:
          checks.phoneNumber?.displayPhoneNumber && config.recipientNumber
            ? String(checks.phoneNumber.displayPhoneNumber).replace(/\D/g, '') === config.recipientNumber
            : null,
        deliveryMode: config.deliveryMode,
        templateBodyFields: config.templateBodyFields,
      });
    }),
  );

  // --- Pack page (the WhatsApp template button target) ----------------------
  app.get('/p/:id', (req, res) => {
    const pack = store.getPackById(req.params.id);
    if (!pack) return res.status(404).type('html').send('<h1>Pack not found</h1>');
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.type('html').send(renderPackPage(pack));
  });

  // --- Fallbacks ------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
  });

  app.use((error, _req, res, _next) => {
    const status = error.status ?? error.statusCode ?? 500;
    if (status >= 500) logger.error('Unhandled request error', { message: error.message, name: error.name });
    res.status(status).json(errorPayload(error, { isProduction: config.isProduction }));
  });

  return app;
}
