#!/usr/bin/env node
/**
 * Safe way to prove the WhatsApp path works, without inventing a fake pack.
 *
 *   npm run send-test             # re-send the latest stored pack
 *   npm run send-test -- --dry-run  # print the exact request, send nothing
 *
 * It always uses WHATSAPP_RECIPIENT_NUMBER and refuses to run when the
 * recipient is the same number that sends. A successful result means Meta
 * ACCEPTED the message; delivery is confirmed only by the status webhook.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createService } from '../src/service.js';

const dryRun = process.argv.includes('--dry-run');

const { config, errors } = loadConfig(process.env);
if (errors.length) {
  process.stderr.write('Configuration problems:\n');
  for (const error of errors) process.stderr.write(`  - ${error}\n`);
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel });

const dryRunHttp = async (url, options = {}) => {
  process.stdout.write(`\nDRY RUN — would ${options.method ?? 'POST'} ${url}\n`);
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(options.body ?? '{}'), null, 2)}\n`);
  } catch {
    process.stdout.write(`${options.body ?? ''}\n`);
  }
  return { ok: true, status: 200, data: { messages: [{ id: 'dry-run-not-sent' }] }, attempts: 1, retryable: false };
};

const service = createService({ config, logger, http: dryRun ? dryRunHttp : undefined });

if (config.senderNumber && config.senderNumber === config.recipientNumber) {
  process.stderr.write(
    'Refusing to send: WHATSAPP_RECIPIENT_NUMBER is the same as WHATSAPP_SENDER_NUMBER.\n' +
      'The Cloud API is for a business number messaging a different recipient.\n',
  );
  process.exit(1);
}

try {
  const result = await service.runner.resendLatest();
  process.stdout.write(`\n${dryRun ? 'DRY RUN complete — nothing was sent.' : 'Meta accepted the message.'}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!dryRun) {
    process.stdout.write(
      '\nAccepted is not delivered. Open WhatsApp Manager → Insights, or watch the\n' +
        'service logs for the "WhatsApp delivery status" line to confirm delivered/read.\n',
    );
  }
} catch (error) {
  process.stderr.write(`\nSend test failed: ${error.message}\n`);
  if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
  process.exit(1);
}
