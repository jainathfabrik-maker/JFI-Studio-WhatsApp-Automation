import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rateLimit.js';
import { buildService, okHttp, startServer } from './helpers.js';

function fakeReq(ip = '1.2.3.4') {
  return { ip, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    headers,
    set(key, value) {
      headers[key] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('requests under the limit are allowed and expose the remaining count', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, name: 'test' });
  for (let i = 1; i <= 3; i += 1) {
    const res = fakeRes();
    let called = false;
    limiter(fakeReq(), res, () => {
      called = true;
    });
    assert.equal(called, true, `request ${i} should pass`);
    assert.equal(res.headers['X-RateLimit-Remaining'], String(3 - i));
  }
});

test('the request that exceeds the limit gets 429 with Retry-After', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, name: 'test' });
  for (let i = 0; i < 2; i += 1) limiter(fakeReq(), fakeRes(), () => {});

  const res = fakeRes();
  let called = false;
  limiter(fakeReq(), res, () => {
    called = true;
  });

  assert.equal(called, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'rate-limited');
  assert.ok(Number(res.headers['Retry-After']) >= 1);
});

test('the window resets and the caller is allowed again', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, name: 'test', now: () => clock });

  assert.equal(limiter(fakeReq(), fakeRes(), () => {}) ?? true, true);
  const blocked = fakeRes();
  limiter(fakeReq(), blocked, () => {});
  assert.equal(blocked.statusCode, 429);

  clock = 1000;
  const res = fakeRes();
  let called = false;
  limiter(fakeReq(), res, () => {
    called = true;
  });
  assert.equal(called, true, 'a new window should allow the caller again');
});

test('limits are per client address', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, name: 'test' });
  limiter(fakeReq('1.1.1.1'), fakeRes(), () => {});
  const other = fakeRes();
  let called = false;
  limiter(fakeReq('2.2.2.2'), other, () => {
    called = true;
  });
  assert.equal(called, true, 'one noisy client must not block another');
});

test('the admin surface returns 429 once the per-window budget is spent', async () => {
  const built = buildService({ http: okHttp(), now: () => Date.UTC(2026, 10, 3, 6, 30) });
  const server = await startServer(built.service.app);
  try {
    const headers = { Authorization: 'Bearer admin-token-0123456789abcdef' };
    let sawLimit = false;
    for (let i = 0; i < 70; i += 1) {
      const response = await server.post('/admin/resend-latest', { headers });
      if (response.status === 429) {
        sawLimit = true;
        assert.ok(response.json.error.includes('Rate limit'));
        break;
      }
    }
    assert.equal(sawLimit, true, 'the admin limiter should engage before 70 requests');
  } finally {
    await server.close();
  }
});

test('the webhook limiter is generous enough not to interfere with normal traffic', async () => {
  const built = buildService({ http: okHttp(), now: () => Date.UTC(2026, 10, 3, 6, 30) });
  const server = await startServer(built.service.app);
  try {
    for (let i = 0; i < 30; i += 1) {
      const response = await server.post('/webhook', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
      });
      // 401 (unsigned) is expected; 429 would mean the limiter is too tight.
      assert.equal(response.status, 401, `request ${i} should be rejected for its signature, not rate limited`);
    }
  } finally {
    await server.close();
  }
});
