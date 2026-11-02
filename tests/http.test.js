import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, TransportError } from '../src/http.js';

function sequence(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

test('a successful call returns parsed JSON on the first attempt', async () => {
  const fetchImpl = sequence([jsonResponse(200, { messages: [{ id: 'wamid.1' }] })]);
  const result = await requestJson('https://example.com', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.data.messages[0].id, 'wamid.1');
});

test('a 429 is retried and the retry can succeed', async () => {
  const fetchImpl = sequence([
    jsonResponse(429, { error: 'slow down' }),
    jsonResponse(200, { ok: true }),
  ]);
  const result = await requestJson('https://example.com', { fetchImpl, maxRetries: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a 400 is not retried', async () => {
  const fetchImpl = sequence([jsonResponse(400, { error: { message: 'bad request' } })]);
  const result = await requestJson('https://example.com', { fetchImpl, maxRetries: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(fetchImpl.calls.length, 1);
});

test('retries stop after maxRetries and the last response is returned', async () => {
  const fetchImpl = sequence([jsonResponse(503, { error: 'unavailable' })]);
  const result = await requestJson('https://example.com', { fetchImpl, maxRetries: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.retryable, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a persistent network failure throws TransportError', async () => {
  const fetchImpl = sequence([new Error('ECONNRESET')]);
  await assert.rejects(() => requestJson('https://example.com', { fetchImpl, maxRetries: 1 }), (error) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.retryable, true);
    assert.match(error.message, /2 attempt/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2);
});

test('a non-JSON body does not crash the parser', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '<html>gateway</html>',
  });
  const result = await requestJson('https://example.com', { fetchImpl });
  assert.equal(result.ok, true);
  assert.match(result.data.raw, /gateway/);
});
