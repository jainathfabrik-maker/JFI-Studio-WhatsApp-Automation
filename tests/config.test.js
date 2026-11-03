import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { baseEnv } from './helpers.js';

test('a complete environment produces no errors', () => {
  const { config, errors } = loadConfig(baseEnv());
  assert.deepEqual(errors, []);
  assert.equal(config.graphApiVersion, 'v26.0');
  assert.equal(config.graphBaseUrl, 'https://graph.facebook.com/v26.0');
  assert.equal(config.recipientNumber, '919876543210');
  assert.equal(config.deliveryMode, 'link');
  assert.deepEqual(config.templateBodyFields, ['dateLabel']);
});

test('missing required variables are each named with where to set them', () => {
  const env = baseEnv();
  delete env.META_ACCESS_TOKEN;
  delete env.WHATSAPP_PHONE_NUMBER_ID;
  const { errors } = loadConfig(env);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /META_ACCESS_TOKEN/);
  assert.match(errors.join('\n'), /WHATSAPP_PHONE_NUMBER_ID/);
  assert.match(errors.join('\n'), /Render/);
});

test('no secret value ever appears in an error message', () => {
  const env = baseEnv({ META_GRAPH_API_VERSION: 'vXX.X' });
  const { errors } = loadConfig(env);
  assert.ok(errors.length > 0);
  for (const message of errors) {
    assert.ok(!message.includes(env.META_ACCESS_TOKEN), 'access token leaked into an error');
    assert.ok(!message.includes(env.META_APP_SECRET), 'app secret leaked into an error');
  }
});

test('a placeholder Graph API version is rejected', () => {
  const { errors } = loadConfig(baseEnv({ META_GRAPH_API_VERSION: 'vXX.X' }));
  assert.match(errors.join('\n'), /META_GRAPH_API_VERSION/);
});

test('a numeric-looking but wrong phone number id is rejected', () => {
  const { errors } = loadConfig(baseEnv({ WHATSAPP_PHONE_NUMBER_ID: '91 98765 43210' }));
  assert.match(errors.join('\n'), /WHATSAPP_PHONE_NUMBER_ID/);
});

test('recipient equal to sender is refused with an explanation', () => {
  const { errors } = loadConfig(baseEnv({ WHATSAPP_RECIPIENT_NUMBER: '918000000000' }));
  assert.match(errors.join('\n'), /not a supported workflow/);
});

test('recipient formatting is normalised to digits', () => {
  const { config, errors } = loadConfig(baseEnv({ WHATSAPP_RECIPIENT_NUMBER: '+91 98765 43210' }));
  assert.deepEqual(errors, []);
  assert.equal(config.recipientNumber, '919876543210');
});

test('link mode without PUBLIC_BASE_URL starts but warns, so a first deploy can boot', () => {
  const { config, errors, warnings } = loadConfig(baseEnv({ PUBLIC_BASE_URL: '' }));
  assert.deepEqual(errors, [], 'must not refuse to start before you can know your own URL');
  assert.match(warnings.join('\n'), /PUBLIC_BASE_URL/);
  assert.equal(config.publicBaseUrlConfigured, false);
});

test('a malformed PUBLIC_BASE_URL is still a hard error', () => {
  const { errors } = loadConfig(baseEnv({ PUBLIC_BASE_URL: 'not-a-url' }));
  assert.match(errors.join('\n'), /PUBLIC_BASE_URL/);
});

test('an invalid cron expression is rejected', () => {
  const { errors } = loadConfig(baseEnv({ DAILY_CRON: '8:30am daily' }));
  assert.match(errors.join('\n'), /DAILY_CRON/);
});

test('an invalid timezone is rejected', () => {
  const { errors } = loadConfig(baseEnv({ TIMEZONE: 'Asia/Bengaluru' }));
  assert.match(errors.join('\n'), /TIMEZONE/);
});

test('verify token must differ from the access token', () => {
  const env = baseEnv();
  env.META_VERIFY_TOKEN = env.META_ACCESS_TOKEN;
  const { errors } = loadConfig(env);
  assert.match(errors.join('\n'), /META_VERIFY_TOKEN must not be the same value/);
});

test('legacy variable names still work and are reported for renaming', () => {
  const env = baseEnv();
  env.WHATSAPP_ACCESS_TOKEN = env.META_ACCESS_TOKEN;
  delete env.META_ACCESS_TOKEN;
  env.WHATSAPP_VERIFY_TOKEN = env.META_VERIFY_TOKEN;
  delete env.META_VERIFY_TOKEN;
  const { config, errors, aliasNotes } = loadConfig(env);
  assert.deepEqual(errors, []);
  assert.equal(config.accessToken, env.WHATSAPP_ACCESS_TOKEN);
  const names = aliasNotes.map((note) => note.used).sort();
  assert.deepEqual(names, ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN']);
});

test('CONTENT_SOURCE=openai without a key is an error, auto falls back to static', () => {
  assert.match(loadConfig(baseEnv({ CONTENT_SOURCE: 'openai' })).errors.join('\n'), /OPENAI_API_KEY/);
  const auto = loadConfig(baseEnv({ CONTENT_SOURCE: 'auto' }));
  assert.equal(auto.config.effectiveContentSource, 'static');
  const withKey = loadConfig(baseEnv({ CONTENT_SOURCE: 'auto', OPENAI_API_KEY: 'sk-test' }));
  assert.equal(withKey.config.effectiveContentSource, 'openai');
});

test('unknown template body fields are rejected', () => {
  const { errors } = loadConfig(baseEnv({ WHATSAPP_TEMPLATE_BODY_FIELDS: 'dateLabel,shoutout' }));
  assert.match(errors.join('\n'), /shoutout/);
});

test('multiple body fields are parsed in order', () => {
  const { config, errors } = loadConfig(baseEnv({ WHATSAPP_TEMPLATE_BODY_FIELDS: 'dateLabel, pillar' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.templateBodyFields, ['dateLabel', 'pillar']);
});

test('a missing admin token is a warning, not a startup failure', () => {
  const { errors, warnings } = loadConfig(baseEnv({ ADMIN_TRIGGER_TOKEN: '' }));
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /ADMIN_TRIGGER_TOKEN/);
});
