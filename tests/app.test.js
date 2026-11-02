import test from 'node:test';
import assert from 'node:assert/strict';
import { buildService, okHttp, startServer, signBody, inboundPayload, statusPayload } from './helpers.js';

const FIXED_NOW = Date.UTC(2026, 10, 3, 6, 30);
const APP_SECRET = 'test-app-secret-0123456789';
const ADMIN_TOKEN = 'admin-token-0123456789abcdef';
const VERIFY_TOKEN = 'verify-token-0123456789abcdef';

const jsonHeaders = { 'Content-Type': 'application/json' };

async function withServer(fn, { env = {}, http = okHttp() } = {}) {
  const built = buildService({ env, http, now: () => FIXED_NOW });
  const server = await startServer(built.service.app);
  try {
    await fn({ ...built, ...server });
  } finally {
    await server.close();
  }
}

test('GET /health returns ok without touching the network', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/health');
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.service, 'jfi-studio-whatsapp-automation');
  });
});

test('GET /status exposes configuration state but no secrets or phone numbers', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/status');
    assert.equal(response.json.ok, true);
    assert.equal(response.json.config.deliveryMode, 'link');
    for (const secret of [ADMIN_TOKEN, APP_SECRET, '919876543210', '123456789012345']) {
      assert.ok(!response.text.includes(secret), `status leaked ${secret}`);
    }
  });
});

test('GET /webhook echoes the challenge for a valid subscription', async () => {
  await withServer(async ({ get }) => {
    const response = await get(`/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=112233`);
    assert.equal(response.status, 200);
    assert.equal(response.text, '112233');
  });
});

test('GET /webhook rejects a wrong verify token', async () => {
  await withServer(async ({ get }) => {
    assert.equal((await get('/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  });
});

test('POST /webhook rejects an unsigned payload', async () => {
  await withServer(async ({ post }) => {
    const response = await post('/webhook', { headers: jsonHeaders, body: JSON.stringify(inboundPayload()) });
    assert.equal(response.status, 401);
  });
});

test('POST /webhook rejects a body signed with the wrong secret', async () => {
  await withServer(async ({ post }) => {
    const raw = JSON.stringify(inboundPayload());
    const response = await post('/webhook', {
      headers: { ...jsonHeaders, 'x-hub-signature-256': signBody('wrong-secret', raw) },
      body: raw,
    });
    assert.equal(response.status, 401);
  });
});

test('POST /webhook accepts a correctly signed payload and records the inbound window', async () => {
  await withServer(async ({ post, service }) => {
    const raw = JSON.stringify(inboundPayload({ messageId: 'wamid.IN1', from: '919876543210' }));
    const response = await post('/webhook', {
      headers: { ...jsonHeaders, 'x-hub-signature-256': signBody(APP_SECRET, raw) },
      body: raw,
    });
    assert.equal(response.status, 200);
    assert.equal(service.store.isWithinServiceWindow('919876543210'), true);
  });
});

test('POST /webhook accepts a signed delivery-status payload', async () => {
  await withServer(async ({ post }) => {
    const raw = JSON.stringify(statusPayload({ status: 'read' }));
    const response = await post('/webhook', {
      headers: { ...jsonHeaders, 'x-hub-signature-256': signBody(APP_SECRET, raw) },
      body: raw,
    });
    assert.equal(response.status, 200);
  });
});

test('admin endpoints reject a missing or wrong bearer token', async () => {
  await withServer(async ({ post }) => {
    assert.equal((await post('/admin/run-daily')).status, 401);
    assert.equal((await post('/admin/run-daily', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  });
});

test('admin endpoints are disabled when no token is configured', async () => {
  await withServer(
    async ({ post }) => {
      const response = await post('/admin/run-daily', { headers: { Authorization: 'Bearer anything' } });
      assert.equal(response.status, 503);
      assert.match(response.json.error, /ADMIN_TRIGGER_TOKEN/);
    },
    { env: { ADMIN_TRIGGER_TOKEN: '' } },
  );
});

test('POST /admin/run-daily with the right token runs and sends exactly one message', async () => {
  await withServer(async ({ post, http }) => {
    const response = await post('/admin/run-daily', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...jsonHeaders },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.accepted, true);
    assert.equal(response.json.deliveryConfirmed, false);
    assert.equal(http.calls.length, 1);
  });
});

test('POST /admin/resend-latest returns 409 before any pack exists', async () => {
  await withServer(async ({ post }) => {
    const response = await post('/admin/resend-latest', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(response.status, 409);
    assert.equal(response.json.code, 'no-pack');
  });
});

test('GET /p/:id serves the pack page and 404s on an unknown or malformed id', async () => {
  await withServer(async ({ get, post }) => {
    const run = await post('/admin/run-daily', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...jsonHeaders },
      body: JSON.stringify({}),
    });
    const { packId } = run.json;

    const page = await get(`/p/${packId}`);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.ok(page.text.includes('JFI Studio'));
    assert.ok(!page.text.includes('<script'));

    assert.equal((await get('/p/doesnotexist1234')).status, 404);
    assert.equal((await get(`/p/${'a'.repeat(200)}`)).status, 404);
  });
});

test('an unknown route returns a JSON 404', async () => {
  await withServer(async ({ get }) => {
    const response = await get('/nope');
    assert.equal(response.status, 404);
    assert.equal(response.json.ok, false);
  });
});

test('GET /admin/diagnostics reports the business number it resolves', async () => {
  const diagHttp = async (url) => {
    if (String(url).includes('display_phone_number')) {
      return {
        ok: true,
        status: 200,
        data: { display_phone_number: '+91 80000 00000', verified_name: 'JFI Studio' },
        attempts: 1,
        retryable: false,
      };
    }
    return { ok: true, status: 200, data: { messages: [{ id: 'wamid.X' }] }, attempts: 1, retryable: false };
  };

  await withServer(
    async ({ get }) => {
      const response = await get('/admin/diagnostics', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      assert.equal(response.status, 200);
      assert.equal(response.json.checks.phoneNumber.verifiedName, 'JFI Studio');
      assert.equal(response.json.senderMatchesRecipient, false);
    },
    { http: diagHttp },
  );
});

test('the webhook rejects a signature computed over different bytes', async () => {
  await withServer(async ({ post }) => {
    const signed = JSON.stringify(inboundPayload({ messageId: 'wamid.A' }));
    const sent = JSON.stringify(inboundPayload({ messageId: 'wamid.B' }));
    const response = await post('/webhook', {
      headers: { ...jsonHeaders, 'x-hub-signature-256': signBody(APP_SECRET, signed) },
      body: sent,
    });
    assert.equal(response.status, 401);
  });
});
