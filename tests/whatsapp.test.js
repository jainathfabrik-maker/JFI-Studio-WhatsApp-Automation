import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppClient, WhatsAppError, TEMPLATE_BODY_PARAM_MAX } from '../src/whatsapp.js';
import { loadConfig } from '../src/config.js';
import { baseEnv, fakeHttp, okHttp, silentLogger } from './helpers.js';

function client(handler, env = {}) {
  const { config } = loadConfig(baseEnv(env));
  const http = handler ? fakeHttp(handler) : okHttp();
  return { client: createWhatsAppClient({ config, logger: silentLogger, http }), http, config };
}

test('sendTemplate posts to the versioned phone-number endpoint with a bearer token', async () => {
  const { client: wa, http, config } = client();
  const result = await wa.sendTemplate({ bodyParams: ['Tue 3 Nov 2026'], urlButtonSuffix: 'abc123' });

  assert.equal(result.messageId, 'wamid.TEST123');
  const [call] = http.calls;
  assert.equal(call.url, `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, `Bearer ${config.accessToken}`);
  assert.equal(call.options.headers['Content-Type'], 'application/json');

  const body = http.lastBody();
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.recipient_type, 'individual');
  assert.equal(body.to, config.recipientNumber);
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, config.templateName);
  assert.deepEqual(body.template.language, { code: config.templateLanguage });
  assert.deepEqual(body.template.components[0], {
    type: 'body',
    parameters: [{ type: 'text', text: 'Tue 3 Nov 2026' }],
  });
  assert.deepEqual(body.template.components[1], {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: 'abc123' }],
  });
});

test('sendTemplate omits components entirely when there is nothing to fill', async () => {
  const { client: wa, http } = client();
  await wa.sendTemplate({});
  assert.equal(http.lastBody().template.components, undefined);
});

test('a template parameter containing a newline is refused before the request', async () => {
  const { client: wa, http } = client();
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['line one\nline two'] }), (error) => {
    assert.ok(error instanceof WhatsAppError);
    assert.match(error.message, /newline/);
    return true;
  });
  assert.equal(http.calls.length, 0, 'nothing should have been sent');
});

test('an over-long template parameter is refused before the request', async () => {
  const { client: wa, http } = client();
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['x'.repeat(TEMPLATE_BODY_PARAM_MAX + 1)] }), /Meta allows 1024/);
  assert.equal(http.calls.length, 0);
});

test('empty and whitespace-padded parameters are refused', async () => {
  const { client: wa } = client();
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['   '] }), /empty/);
  await assert.rejects(() => wa.sendTemplate({ bodyParams: [' padded '] }), /leading or trailing whitespace/);
});

test('a non-URL-safe button suffix is refused', async () => {
  const { client: wa } = client();
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['date'], urlButtonSuffix: 'bad suffix/../x' }), /URL-safe/);
});

test('Meta error 190 is mapped to an actionable, non-retryable token hint', async () => {
  const { client: wa } = client(() => ({
    ok: false,
    status: 401,
    retryable: false,
    data: { error: { message: 'Invalid OAuth access token.', code: 190, type: 'OAuthException', fbtrace_id: 'abc' } },
  }));

  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['date'] }), (error) => {
    assert.ok(error instanceof WhatsAppError);
    assert.equal(error.code, 190);
    assert.equal(error.retryable, false);
    assert.match(error.hint, /Generate a new token/);
    return true;
  });
});

test('a 429 from Meta is surfaced as retryable', async () => {
  const { client: wa } = client(() => ({
    ok: false,
    status: 429,
    retryable: true,
    data: { error: { message: 'Rate limit hit', code: 130429 } },
  }));
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['date'] }), (error) => {
    assert.equal(error.retryable, true);
    assert.match(error.hint, /throughput limit/);
    return true;
  });
});

test('a 200 with no message id is treated as unconfirmed, not delivered', async () => {
  const { client: wa } = client(() => ({ ok: true, status: 200, data: {} }));
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['date'] }), /no message id/);
});

test('a transport failure becomes a retryable WhatsAppError', async () => {
  const { config } = loadConfig(baseEnv());
  const http = async () => {
    const { TransportError } = await import('../src/http.js');
    throw new TransportError('connect ECONNREFUSED');
  };
  const wa = createWhatsAppClient({ config, logger: silentLogger, http });
  await assert.rejects(() => wa.sendTemplate({ bodyParams: ['date'] }), (error) => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /unreachable/);
    return true;
  });
});

test('sendText posts a text message and rejects an over-long body', async () => {
  const { client: wa, http } = client();
  await wa.sendText({ body: 'hello' });
  const body = http.lastBody();
  assert.equal(body.type, 'text');
  assert.deepEqual(body.text, { body: 'hello', preview_url: false });

  await assert.rejects(() => wa.sendText({ body: 'x'.repeat(4097) }), /allows 4096/);
  await assert.rejects(() => wa.sendText({ body: '   ' }), /empty text message/);
});

test('getDisplayPhoneNumber returns the business number for the self-send guard', async () => {
  const { client: wa, http } = client(() => ({
    ok: true,
    status: 200,
    data: { display_phone_number: '+91 80000 00000', verified_name: 'JFI Studio' },
  }));
  const info = await wa.getDisplayPhoneNumber();
  assert.equal(info.displayPhoneNumber, '+91 80000 00000');
  assert.equal(info.verifiedName, 'JFI Studio');
  assert.match(http.calls[0].url, /fields=display_phone_number/);
});
