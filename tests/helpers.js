import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createService } from '../src/service.js';

export const silentLogger = createLogger({ level: 'silent', sink: () => {} });

export function tempDir(prefix = 'jfi-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A complete, valid environment. Override individual keys per test. */
export function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    META_ACCESS_TOKEN: `EAA${'a'.repeat(40)}`,
    META_APP_SECRET: 'test-app-secret-0123456789',
    META_VERIFY_TOKEN: 'verify-token-0123456789abcdef',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_RECIPIENT_NUMBER: '919876543210',
    WHATSAPP_SENDER_NUMBER: '918000000000',
    ADMIN_TRIGGER_TOKEN: 'admin-token-0123456789abcdef',
    PUBLIC_BASE_URL: 'https://jfi.example.com',
    META_GRAPH_API_VERSION: 'v26.0',
    WHATSAPP_DELIVERY_MODE: 'link',
    CONTENT_SOURCE: 'static',
    LOG_LEVEL: 'silent',
    DATA_DIR: tempDir(),
    ...overrides,
  };
}

/** A fake transport that records every call and replays a queued response. */
export function fakeHttp(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    const result = await handler(url, options, calls.length);
    return { ok: true, status: 200, data: {}, attempts: 1, retryable: false, ...result };
  };
  fn.calls = calls;
  fn.lastBody = () => JSON.parse(calls.at(-1).options.body);
  return fn;
}

/** A transport that always succeeds with a WhatsApp-shaped message id. */
export function okHttp({ messageId = 'wamid.TEST123' } = {}) {
  return fakeHttp(() => ({ ok: true, status: 200, data: { messages: [{ id: messageId }] } }));
}

export function buildService({ env = {}, http = okHttp(), now } = {}) {
  const { config, errors } = loadConfig(baseEnv(env));
  if (errors.length) throw new Error(`test env invalid: ${errors.join('; ')}`);
  const service = createService({ config, logger: silentLogger, http, now });
  return { config, service, http };
}

/**
 * Plain node:http request helper. Deliberately not global fetch: the test
 * runner then needs no undici/WASM and behaves the same everywhere.
 */
export function request(baseUrl, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Start an express app on an ephemeral port and return helpers. */
export async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    get: (path, options) => request(baseUrl, path, options),
    post: (path, options) => request(baseUrl, path, { ...options, method: 'POST' }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function signBody(secret, rawBody) {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

/** Build a Meta-shaped webhook payload carrying one inbound message. */
export function inboundPayload({ messageId = 'wamid.INBOUND1', from = '919876543210' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '918000000000', phone_number_id: '123456789012345' },
              messages: [{ from, id: messageId, timestamp: '1700000000', type: 'text', text: { body: 'hi' } }],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload({ messageId = 'wamid.OUT1', status = 'delivered' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [{ id: messageId, status, timestamp: '1700000001', recipient_id: '919876543210' }],
            },
          },
        ],
      },
    ],
  };
}

export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}
