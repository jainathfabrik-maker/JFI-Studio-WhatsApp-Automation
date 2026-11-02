import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySignature, verifySubscription, processWebhookBody } from '../src/webhook.js';
import { createStore } from '../src/store.js';
import { silentLogger, signBody, inboundPayload, statusPayload, tempDir } from './helpers.js';

const SECRET = 'test-app-secret-0123456789';

test('subscription handshake returns the challenge for the right token', () => {
  const result = verifySubscription({
    query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'abc123', 'hub.challenge': '987654' },
    verifyToken: 'abc123',
  });
  assert.deepEqual(result, { ok: true, challenge: '987654' });
});

test('subscription handshake rejects a wrong token, wrong mode or missing challenge', () => {
  const base = { 'hub.mode': 'subscribe', 'hub.verify_token': 'abc123', 'hub.challenge': '1' };
  assert.equal(verifySubscription({ query: { ...base, 'hub.verify_token': 'nope' }, verifyToken: 'abc123' }).ok, false);
  assert.equal(verifySubscription({ query: { ...base, 'hub.mode': 'unsubscribe' }, verifyToken: 'abc123' }).ok, false);
  assert.equal(verifySubscription({ query: { ...base, 'hub.challenge': '' }, verifyToken: 'abc123' }).ok, false);
  assert.equal(verifySubscription({ query: base, verifyToken: '' }).ok, false);
});

test('signature verification accepts a correctly signed body', () => {
  const raw = Buffer.from(JSON.stringify(inboundPayload()));
  const header = signBody(SECRET, raw);
  assert.equal(verifySignature({ rawBody: raw, header, appSecret: SECRET }).ok, true);
});

test('signature verification rejects a tampered body', () => {
  const raw = Buffer.from(JSON.stringify(inboundPayload()));
  const header = signBody(SECRET, raw);
  const tampered = Buffer.from(JSON.stringify(inboundPayload({ messageId: 'wamid.OTHER' })));
  const result = verifySignature({ rawBody: tampered, header, appSecret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature-mismatch');
});

test('signature verification rejects a missing or malformed header', () => {
  const raw = Buffer.from('{}');
  assert.equal(verifySignature({ rawBody: raw, header: undefined, appSecret: SECRET }).reason, 'signature-header-missing');
  assert.equal(verifySignature({ rawBody: raw, header: 'sha1=abc', appSecret: SECRET }).reason, 'signature-header-missing');
  assert.equal(verifySignature({ rawBody: raw, header: 'sha256=nothex', appSecret: SECRET }).reason, 'signature-malformed');
  assert.equal(verifySignature({ rawBody: raw, header: signBody(SECRET, raw), appSecret: '' }).reason, 'app-secret-missing');
});

test('an inbound message is processed once and then deduplicated', () => {
  const dir = tempDir();
  const store = createStore({ dir, logger: silentLogger });
  store.init();
  const payload = inboundPayload({ messageId: 'wamid.DUPE1' });

  const first = processWebhookBody({ body: payload, store, logger: silentLogger });
  assert.equal(first.messages, 1);
  assert.equal(first.duplicates, 0);

  const second = processWebhookBody({ body: payload, store, logger: silentLogger });
  assert.equal(second.messages, 0);
  assert.equal(second.duplicates, 1);
});

test('an inbound message opens the 24-hour service window for that sender', () => {
  const store = createStore({ dir: tempDir(), logger: silentLogger });
  store.init();
  assert.equal(store.isWithinServiceWindow('919876543210'), false);
  processWebhookBody({ body: inboundPayload({ from: '919876543210' }), store, logger: silentLogger });
  assert.equal(store.isWithinServiceWindow('919876543210'), true);
});

test('delivery statuses are deduplicated per status value', () => {
  const store = createStore({ dir: tempDir(), logger: silentLogger });
  store.init();
  const delivered = statusPayload({ messageId: 'wamid.OUT1', status: 'delivered' });

  const first = processWebhookBody({ body: delivered, store, logger: silentLogger });
  assert.equal(first.statuses, 1);

  const repeat = processWebhookBody({ body: delivered, store, logger: silentLogger });
  assert.equal(repeat.duplicates, 1);

  const read = processWebhookBody({ body: statusPayload({ messageId: 'wamid.OUT1', status: 'read' }), store, logger: silentLogger });
  assert.equal(read.statuses, 1, 'a different status for the same message is a new event');
});

test('a failed status is counted and logged without throwing', () => {
  const store = createStore({ dir: tempDir(), logger: silentLogger });
  store.init();
  const body = statusPayload({ status: 'failed' });
  body.entry[0].changes[0].value.statuses[0].errors = [{ code: 131047, title: 'Re-engagement message' }];
  const summary = processWebhookBody({ body, store, logger: silentLogger });
  assert.equal(summary.failures, 1);
});

test('a payload for another object type is ignored safely', () => {
  const store = createStore({ dir: tempDir(), logger: silentLogger });
  store.init();
  const summary = processWebhookBody({ body: { object: 'page', entry: [] }, store, logger: silentLogger });
  assert.equal(summary.ignored, 1);
});

test('a malformed payload does not throw', () => {
  const store = createStore({ dir: tempDir(), logger: silentLogger });
  store.init();
  assert.doesNotThrow(() => processWebhookBody({ body: {}, store, logger: silentLogger }));
  assert.doesNotThrow(() => processWebhookBody({ body: { entry: [{ changes: null }] }, store, logger: silentLogger }));
  assert.doesNotThrow(() => processWebhookBody({ body: { entry: [{ changes: [{ value: { messages: [{}] } }] }] }, store, logger: silentLogger }));
});
