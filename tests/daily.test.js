import test from 'node:test';
import assert from 'node:assert/strict';
import { buildService, okHttp, fakeHttp } from './helpers.js';

const FIXED_NOW = Date.UTC(2026, 10, 3, 6, 30); // 3 Nov 2026, 12:00 IST
const DAY_MS = 86_400_000;

test('link mode sends a template whose URL button points at the stored pack', async () => {
  const http = okHttp({ messageId: 'wamid.OUT1' });
  const { service, config } = buildService({ http, now: () => FIXED_NOW });

  const result = await service.runner.runDaily({ trigger: 'test' });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(result.accepted, true);
  assert.equal(result.deliveryConfirmed, false);
  assert.deepEqual(result.messageIds, ['wamid.OUT1']);

  const body = http.lastBody();
  assert.equal(body.type, 'template');
  assert.equal(body.template.components[0].parameters[0].text, 'Tue 3 Nov 2026');
  assert.equal(body.template.components[1].parameters[0].text, result.packId);

  const pack = service.store.getPackById(result.packId);
  assert.equal(pack.status, 'sent');
  assert.equal(pack.date, '2026-11-03');
  assert.equal(pack.mode, 'link');
  assert.equal(config.publicBaseUrl, 'https://jfi.example.com');
});

test('a second run on the same day is skipped instead of sending twice', async () => {
  const http = okHttp();
  const { service } = buildService({ http, now: () => FIXED_NOW });

  const first = await service.runner.runDaily({ trigger: 'test' });
  const second = await service.runner.runDaily({ trigger: 'test' });

  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already-sent-today');
  assert.equal(http.calls.length, 1, 'only one WhatsApp request may leave the service');
});

test('the next day runs again', async () => {
  const http = okHttp();
  const { service } = buildService({ http, now: () => FIXED_NOW });

  await service.runner.runDaily({ trigger: 'test', nowMs: FIXED_NOW });
  const nextDay = await service.runner.runDaily({ trigger: 'test', nowMs: FIXED_NOW + DAY_MS });

  assert.equal(nextDay.skipped, false);
  assert.equal(nextDay.date, '2026-11-04');
  assert.equal(http.calls.length, 2);
});

test('a concurrent run is blocked by the run lock', async () => {
  const http = okHttp();
  const { service } = buildService({ http, now: () => FIXED_NOW });

  // Simulate another process holding today's lock.
  const lock = service.store.tryAcquireRunLock('2026-11-03', 'another-process');
  assert.equal(lock.acquired, true);

  const result = await service.runner.runDaily({ trigger: 'test' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'another-run-in-progress');
  assert.equal(http.calls.length, 0);
});

test('a failed delivery is recorded and the day can be retried', async () => {
  let attempt = 0;
  const http = fakeHttp(() => {
    attempt += 1;
    if (attempt === 1) {
      return { ok: false, status: 400, data: { error: { message: 'Bad template', code: 132000 } } };
    }
    return { ok: true, status: 200, data: { messages: [{ id: 'wamid.RETRY' }] } };
  });

  const { service } = buildService({ http, now: () => FIXED_NOW });

  await assert.rejects(() => service.runner.runDaily({ trigger: 'test' }), /132000/);
  assert.equal(service.store.getLastRun().status, 'failed');

  const retry = await service.runner.runDaily({ trigger: 'test' });
  assert.equal(retry.skipped, false, 'a failed day must be retryable');
  assert.deepEqual(retry.messageIds, ['wamid.RETRY']);
});

test('link mode without PUBLIC_BASE_URL refuses to send, with a clear reason', async () => {
  const http = okHttp();
  const { service } = buildService({ env: { PUBLIC_BASE_URL: '' }, http, now: () => FIXED_NOW });

  await assert.rejects(() => service.runner.runDaily({ trigger: 'test' }), (error) => {
    assert.equal(error.code, 'public-base-url-missing');
    assert.equal(error.status, 409);
    assert.match(error.message, /PUBLIC_BASE_URL/);
    return true;
  });
  assert.equal(http.calls.length, 0, 'nothing may be sent without a pack link');
});

test('the run builds the pack link from the triggering request when no URL is configured', async () => {
  const http = okHttp();
  const { service } = buildService({ env: { PUBLIC_BASE_URL: '' }, http, now: () => FIXED_NOW });

  const result = await service.runner.runDaily({
    trigger: 'test',
    publicBaseUrl: 'https://jfi-live.onrender.com',
  });

  assert.equal(result.skipped, false);
  assert.equal(result.accepted, true);
  assert.equal(http.calls.length, 1, 'the send must succeed without any configured URL');
});

test('a malformed request origin is refused instead of producing a broken link', async () => {
  const http = okHttp();
  const { service } = buildService({ env: { PUBLIC_BASE_URL: '' }, http, now: () => FIXED_NOW });

  await assert.rejects(
    () => service.runner.runDaily({ trigger: 'test', publicBaseUrl: 'javascript:alert(1)' }),
    (error) => {
      assert.equal(error.code, 'public-base-url-invalid');
      return true;
    },
  );
  assert.equal(http.calls.length, 0);
});

test('text mode refuses to send outside the 24-hour window', async () => {
  const http = okHttp();
  const { service } = buildService({
    env: { WHATSAPP_DELIVERY_MODE: 'text' },
    http,
    now: () => FIXED_NOW,
  });

  await assert.rejects(() => service.runner.runDaily({ trigger: 'test' }), (error) => {
    assert.equal(error.code, 'window-closed');
    assert.equal(error.status, 409);
    assert.match(error.message, /24-hour customer service window/);
    return true;
  });
  assert.equal(http.calls.length, 0);
});

test('text mode sends the pack once a recipient has messaged in', async () => {
  const http = okHttp({ messageId: 'wamid.TEXT1' });
  const { service } = buildService({
    env: { WHATSAPP_DELIVERY_MODE: 'text' },
    http,
    now: () => FIXED_NOW,
  });

  service.store.recordInbound('919876543210');
  const result = await service.runner.runDaily({ trigger: 'test' });

  assert.equal(result.mode, 'text');
  const body = http.lastBody();
  assert.equal(body.type, 'text');
  assert.match(body.text.body, /JFI STUDIO — CONTENT PACK/);
  assert.match(body.text.body, /SHOT LIST/);
});

test('resendLatest re-sends the stored pack, and fails cleanly when there is none', async () => {
  const http = okHttp();
  const { service } = buildService({ http, now: () => FIXED_NOW });

  await assert.rejects(() => service.runner.resendLatest(), (error) => {
    assert.equal(error.code, 'no-pack');
    assert.equal(error.status, 409);
    return true;
  });

  const first = await service.runner.runDaily({ trigger: 'test' });
  const resent = await service.runner.resendLatest();
  assert.equal(resent.packId, first.packId);
  assert.equal(http.calls.length, 2);
});

test('the pack page renders the whole brief', async () => {
  const { service } = buildService({ http: okHttp(), now: () => FIXED_NOW });
  const { packId } = await service.runner.runDaily({ trigger: 'test' });
  const pack = service.store.getPackById(packId);
  const { renderPackPage } = await import('../src/packPage.js');
  const html = renderPackPage(pack);

  for (const needle of ['Daily content pack', 'Hook (max 12 words)', 'Caption', 'Call to action', 'Hashtags', 'Shot list', 'Publish time']) {
    assert.ok(html.includes(needle), `page missing ${needle}`);
  }
  assert.ok(html.includes(pack.hook.replace(/&/g, '&amp;')));
  assert.ok(!html.includes('<script'), 'no scripts on the pack page');
});
