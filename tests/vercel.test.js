/**
 * Tests for the Vercel entry point (api/index.js).
 *
 * These drive the exported default handler through a plain node:http server,
 * which is the closest local analogue of a serverless invocation: Vercel calls
 * the handler with a Node request and response object and nothing else.
 *
 * The environment is set BEFORE importing the module, because api/index.js
 * validates configuration at module load (exactly as server.js does).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const APP_SECRET = 'vercel-app-secret-0123456789';
const VERIFY_TOKEN = 'vercel-verify-token-0123456789';
const ADMIN_TOKEN = 'vercel-admin-token-0123456789ab';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jfi-vercel-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  VERCEL: '1',
  VERCEL_PROJECT_PRODUCTION_URL: 'jfi-studio.vercel.app',
  DATA_DIR,
  LOG_LEVEL: 'silent',
  META_ACCESS_TOKEN: `EAA${'a'.repeat(40)}`,
  META_APP_SECRET: APP_SECRET,
  META_VERIFY_TOKEN: VERIFY_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  WHATSAPP_RECIPIENT_NUMBER: '919876543210',
  ADMIN_TRIGGER_TOKEN: ADMIN_TOKEN,
  CONTENT_SOURCE: 'static',
});

const { default: handler } = await import('../api/index.js');

const server = await new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

test.after(() => new Promise((resolve) => server.close(resolve)));

function request(requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${requestPath}`, { method, headers }, (res) => {
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
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('the module default-exports a request handler, not a listening server', () => {
  assert.equal(typeof handler, 'function', 'Vercel requires the default export to be a function');
});

test('GET /health works through the serverless handler', async () => {
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.service, 'jfi-studio-whatsapp-automation');
});

test('/status reports the Vercel-injected URL as its source', async () => {
  const response = await request('/status');
  assert.equal(response.status, 200);
  assert.equal(response.json.publicBaseUrlSource, 'VERCEL_URL');
  assert.equal(response.json.publicBaseUrl, 'https://jfi-studio.vercel.app');
});

test('/status admits that storage is not persistent on serverless', async () => {
  const response = await request('/status');
  assert.equal(response.json.storage.persistent, false);
  assert.match(response.json.storage.note, /no persistent disk/i);
  assert.match(response.json.storage.note, /pack links/i);
});

test('GET /webhook echoes the challenge through the handler', async () => {
  const response = await request(
    `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=998877`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.text, '998877');
});

test('GET /webhook rejects a wrong token through the handler', async () => {
  const response = await request('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1');
  assert.equal(response.status, 403);
});

test('signature verification still sees the raw bytes on serverless', async () => {
  // The whole point of requirement 3: express.json's verify hook must capture
  // the exact bytes Vercel streams in, or every real webhook 401s.
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messages: [] } }] }],
  });
  const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

  const response = await request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  assert.equal(response.status, 200, 'a correctly signed payload must be accepted');
});

test('a tampered body is still rejected on serverless', async () => {
  const signed = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const sent = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x' }] });
  const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(signed).digest('hex')}`;

  const response = await request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
    body: sent,
  });
  assert.equal(response.status, 401);
});

test('an unsigned webhook POST is rejected on serverless', async () => {
  const response = await request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  });
  assert.equal(response.status, 401);
});

test('admin auth is unchanged: no token means 401', async () => {
  const response = await request('/admin/run-daily', { method: 'POST' });
  assert.equal(response.status, 401);
});

test('/setup derives URLs from the injected Vercel host', async () => {
  const response = await request('/setup');
  assert.equal(response.status, 200);
  assert.ok(response.text.includes('https://jfi-studio.vercel.app/webhook'));
  assert.ok(response.text.includes('https://jfi-studio.vercel.app/p/{{1}}'));
  assert.ok(!response.text.includes(APP_SECRET), 'the app secret must never be rendered');
  assert.ok(!response.text.includes(VERIFY_TOKEN), 'the verify token must never be rendered');
});

test('an unknown pack id returns the explanatory 404, not a crash', async () => {
  const response = await request('/p/definitelynotapack');
  assert.equal(response.status, 404);
  assert.match(response.text, /no longer available/i);
});

test('an unknown route returns a JSON 404', async () => {
  const response = await request('/nope');
  assert.equal(response.status, 404);
  assert.equal(response.json.ok, false);
});
