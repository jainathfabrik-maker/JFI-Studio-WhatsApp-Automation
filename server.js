import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig, describeConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { createService } from './src/service.js';
import { maskPhone } from './src/util.js';

const earlyLogger = createLogger({ level: 'info' });

// --- Process-level handlers first, before anything asynchronous -----------
process.on('unhandledRejection', (reason) => {
  earlyLogger.error('Unhandled promise rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

// --- Validate configuration before doing any work -------------------------
const { config, errors, warnings, aliasNotes } = loadConfig(process.env);

if (errors.length > 0) {
  process.stderr.write('\nJFI Studio WhatsApp Automation cannot start.\n\n');
  for (const error of errors) process.stderr.write(`  ✗ ${error}\n`);
  process.stderr.write(
    '\nFix the variables listed above and restart. On Render: Dashboard → your service → Environment.\n' +
      'Never paste a secret value into a chat, an issue, or a commit.\n\n',
  );
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel });

for (const warning of warnings) logger.warn(warning);
for (const note of aliasNotes) {
  logger.warn(`Using legacy variable name ${note.used} for ${note.canonical}. Rename it to ${note.canonical} in Render.`);
}

logger.info('Configuration loaded', describeConfig(config));

if (config.effectiveContentSource === 'static') {
  logger.info('Content source is the built-in static pack bank (no OPENAI_API_KEY set, or CONTENT_SOURCE=static).');
}

const service = createService({ config, logger });
const { app, store, whatsapp, runner, safety } = service;

// --- Start listening ------------------------------------------------------
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info('Server listening', { port: config.port, nodeEnv: config.nodeEnv, healthCheck: '/health' });
});

server.on('error', (error) => {
  logger.error('Server failed to listen', { message: error.message, code: error.code });
  process.exit(1);
});

// --- Scheduler ------------------------------------------------------------
let task = null;
if (config.enableInternalCron) {
  if (!cron.validate(config.dailyCron)) {
    logger.error('DAILY_CRON is invalid; in-process schedule disabled.');
  } else {
    task = cron.schedule(
      config.dailyCron,
      async () => {
        try {
          await runner.runDaily({ trigger: 'internal-cron' });
        } catch (error) {
          // runDaily has already logged the details; never let a rejection
          // escape the timer callback.
          logger.error('Scheduled run threw', { message: error.message });
        }
      },
      { timezone: config.timezone },
    );
    logger.info('In-process schedule enabled', { cron: config.dailyCron, timezone: config.timezone });
  }
} else {
  logger.info(
    'In-process schedule disabled (ENABLE_INTERNAL_CRON=false). Use a Render Cron Job or POST /admin/run-daily.',
  );
}

// --- Self-send guard ------------------------------------------------------
/**
 * The Cloud API is built for a business number to message a *different*
 * recipient. Config validation catches the obvious case; this asks Meta for
 * the business number behind WHATSAPP_PHONE_NUMBER_ID and blocks delivery if
 * it turns out to be the configured recipient.
 *
 * Runs after the server is listening, never blocks startup, and never throws:
 * a network or token problem here is logged and left for the first real send
 * to surface with a proper error.
 */
async function verifySenderIsNotRecipient() {
  if (config.senderNumber && config.senderNumber === config.recipientNumber) {
    safety.blocked = true;
    safety.reason =
      'WHATSAPP_RECIPIENT_NUMBER is the same number that owns WHATSAPP_PHONE_NUMBER_ID. The Cloud API is built for a business number to message a different recipient, so delivery is blocked. Set the recipient to a different number you control.';
    logger.error('Delivery blocked: sender and recipient are the same number', { hint: safety.reason });
    return;
  }

  try {
    const info = await whatsapp.getDisplayPhoneNumber();
    const businessNumber = String(info.displayPhoneNumber ?? '').replace(/\D/g, '');
    if (businessNumber && businessNumber === config.recipientNumber) {
      safety.blocked = true;
      safety.reason =
        'WHATSAPP_RECIPIENT_NUMBER matches the business number behind WHATSAPP_PHONE_NUMBER_ID. Self-messaging is not a supported Cloud API workflow, so delivery is blocked. Configure a different recipient number.';
      logger.error('Delivery blocked: recipient is the sending business number', {
        businessNumber: maskPhone(businessNumber),
        hint: safety.reason,
      });
      return;
    }
    logger.info('Sender and recipient verified as different numbers', {
      businessNumber: maskPhone(businessNumber),
      recipient: maskPhone(config.recipientNumber),
      verifiedName: info.verifiedName ?? undefined,
    });
  } catch (error) {
    logger.warn('Could not verify the business number with Meta at startup', {
      reason: error.message,
      hint: 'Not fatal. Confirm WHATSAPP_PHONE_NUMBER_ID and META_ACCESS_TOKEN; the first send will fail with a specific error if they are wrong.',
    });
  }
}

void verifySenderIsNotRecipient().catch((error) => {
  logger.warn('Startup verification threw unexpectedly', { reason: error?.message ?? String(error) });
});

// --- Graceful shutdown ----------------------------------------------------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.error('Shutdown took too long; exiting anyway');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (task) task.stop();
    await new Promise((resolve) => server.close(resolve));
    logger.info('HTTP server closed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { message: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, name: error.name });
  void shutdown('uncaughtException');
});

export { app, server, store };
