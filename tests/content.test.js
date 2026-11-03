import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, PILLARS, packToText, ContentError } from '../src/content.js';
import { buildTemplateParams, DeliveryError } from '../src/daily.js';
import { buildService, fakeHttp } from './helpers.js';

const FIXED_NOW = Date.UTC(2026, 10, 3, 6, 30); // 3 Nov 2026, 12:00 IST

/** A pack that satisfies every rule, for tests that break one thing at a time. */
function validPack(overrides = {}) {
  return {
    pillar: 'process',
    format: 'Reel, 20s, vertical 9:16',
    concept:
      'One continuous walk from the front door to the last checkpoint, with each check stamped on screen as it is passed.',
    hook: 'Whitefield handover: 14 checkpoints before keys',
    caption: 'x'.repeat(120),
    cta: 'WhatsApp us CHECKLIST and we will send the printable sheet.',
    hashtags: ['#a', '#b', '#c', '#d', '#e'],
    shotList: ['a', 'b', 'c'],
    onScreenText: ['1 — door alignment', '5 — drawer travel', '8 — leak test'],
    tracking: { metric: 'saves', utmCampaign: 'reel_handover_14_checkpoints' },
    publishTimeIST: '7:30 PM IST',
    ...overrides,
  };
}

function staticService(env = {}) {
  return buildService({ env, now: () => FIXED_NOW });
}

test('a well-formed pack passes validation', () => {
  const check = validatePack(validPack());
  assert.equal(check.ok, true, check.problems.join('; '));
});

test('the static pack bank produces a valid pack for every pillar', async () => {
  const { service } = staticService();
  const seen = new Set();
  for (let day = 0; day < 24; day += 1) {
    const pack = await service.content.generate({ nowMs: FIXED_NOW + day * 86_400_000 });
    const check = validatePack(pack);
    assert.equal(check.ok, true, `pack for ${pack.date} invalid: ${check.problems.join('; ')}`);
    assert.ok(PILLARS.includes(pack.pillar));
    assert.equal(pack.source, 'static');
    assert.ok(pack.hashtags.length >= 5);
    assert.ok(pack.shotList.length >= 3);
    assert.ok(pack.onScreenText.length >= 2);
    assert.ok(pack.tracking.metric);
    assert.ok(pack.tracking.utmCampaign);
    assert.ok(pack.concept.length >= 40);
    seen.add(pack.pillar);
  }
  assert.equal(seen.size, PILLARS.length, 'all six pillars should appear across a rotation');
});

test('every pack carries all eight brief items', async () => {
  const { service } = staticService();
  const pack = await service.content.generate({ nowMs: FIXED_NOW });
  // The brief's eight requirements, mapped to fields.
  assert.ok(pack.format, '1. format and duration');
  assert.ok(PILLARS.includes(pack.pillar), '2. content pillar');
  assert.ok(pack.hook, '3. first-frame hook');
  assert.ok(pack.concept.length > 40, '4. video or post concept');
  assert.ok(pack.shotList.length && pack.onScreenText.length, '5. shot list and on-screen text');
  assert.ok(pack.caption && pack.hashtags.length, '6. caption and hashtags');
  assert.ok(pack.cta, '7. call to action');
  assert.ok(pack.publishTimeIST && pack.tracking.utmCampaign, '8. publishing format and tracking');
});

test('validatePack rejects an over-long hook', () => {
  const check = validatePack(validPack({ hook: 'one two three four five six seven eight nine ten eleven twelve thirteen' }));
  assert.equal(check.ok, false);
  assert.match(check.problems.join('; '), /at most 12/);
});

test('validatePack requires a number or place name in the hook', () => {
  const check = validatePack(validPack({ hook: 'a quiet walkthrough of the finished flat' }));
  assert.match(check.problems.join('; '), /number or a Bengaluru place name/);
});

test('validatePack accepts a place name without a number', () => {
  const check = validatePack(validPack({ hook: 'the Koramangala kitchen nobody wanted to rebuild' }));
  assert.equal(check.ok, true, check.problems.join('; '));
});

test('validatePack catches off-brand words', () => {
  const check = validatePack(validPack({ caption: `A luxury ${'x'.repeat(120)}` }));
  assert.match(check.problems.join('; '), /luxury/);
});

test('validatePack rejects a missing publish time and short hashtag list', () => {
  const problems = validatePack(
    validPack({ hashtags: ['#a'], shotList: [], publishTimeIST: '' }),
  ).problems.join('; ');
  assert.match(problems, /at least 5/);
  assert.match(problems, /at least 3/);
  assert.match(problems, /publishTimeIST/);
});

test('validatePack requires the concept, on-screen text and tracking fields', () => {
  const problems = validatePack(
    validPack({ concept: 'too short', onScreenText: [], tracking: undefined }),
  ).problems.join('; ');
  assert.match(problems, /concept is required/);
  assert.match(problems, /onScreenText/);
  assert.match(problems, /tracking is required/);
});

test('validatePack rejects a tracking slug containing spaces', () => {
  const problems = validatePack(
    validPack({ tracking: { metric: 'saves', utmCampaign: 'reel with spaces' } }),
  ).problems.join('; ');
  assert.match(problems, /must not contain spaces/);
});

test('packToText renders every section including the new ones', () => {
  const text = packToText({
    ...validPack(),
    dateLabel: 'Tue 3 Nov 2026',
    hashtags: ['#a', '#b'],
    shotList: ['shot one', 'shot two'],
  });
  for (const needle of [
    'HOOK',
    'CONCEPT',
    'CAPTION',
    'CALL TO ACTION',
    'HASHTAGS',
    'SHOT LIST',
    'ON-SCREEN TEXT',
    'TRACKING',
    'UTM campaign: reel_handover_14_checkpoints',
    'PUBLISH',
    '1. shot one',
  ]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

test('template body params are built from the configured fields', () => {
  const pack = { dateLabel: 'Tue 3 Nov 2026', pillar: 'trust', hook: 'Nine clauses', concept: 'A text card' };
  assert.deepEqual(buildTemplateParams(pack, ['dateLabel']), ['Tue 3 Nov 2026']);
  assert.deepEqual(buildTemplateParams(pack, ['dateLabel', 'pillar']), ['Tue 3 Nov 2026', 'trust']);
  assert.deepEqual(buildTemplateParams(pack, ['concept']), ['A text card']);
  assert.throws(() => buildTemplateParams(pack, ['format']), DeliveryError);
});

test('a failing content source fails the run without sending anything', async () => {
  const http = fakeHttp((url) => {
    if (url.includes('openai.com')) {
      return { ok: false, status: 500, data: { error: { message: 'upstream exploded' } } };
    }
    return { ok: true, status: 200, data: { messages: [{ id: 'wamid.SHOULD_NOT_HAPPEN' }] } };
  });

  const { service, config } = buildService({
    env: { CONTENT_SOURCE: 'openai', OPENAI_API_KEY: 'sk-test' },
    http,
    now: () => FIXED_NOW,
  });

  await assert.rejects(() => service.runner.runDaily({ trigger: 'test' }), (error) => {
    assert.ok(error instanceof ContentError);
    assert.match(error.message, /OpenAI request failed/);
    return true;
  });

  const whatsappCalls = http.calls.filter((call) => call.url.includes('graph.facebook.com'));
  assert.equal(whatsappCalls.length, 0, 'no WhatsApp message may be sent when generation fails');
  assert.equal((await service.store.getLastRun()).status, 'failed');
  assert.equal(config.deliveryMode, 'link');
});

test('an invalid OpenAI payload is retried once and then rejected', async () => {
  let openaiCalls = 0;
  const http = fakeHttp((url) => {
    if (url.includes('openai.com')) {
      openaiCalls += 1;
      // Valid JSON, but a 30-word hook: fails validation every time.
      return {
        ok: true,
        status: 200,
        data: {
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify(
                    validPack({ hook: Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ') }),
                  ),
                },
              ],
            },
          ],
        },
      };
    }
    return { ok: true, status: 200, data: { messages: [{ id: 'wamid.NOPE' }] } };
  });

  const { service } = buildService({
    env: { CONTENT_SOURCE: 'openai', OPENAI_API_KEY: 'sk-test' },
    http,
    now: () => FIXED_NOW,
  });

  await assert.rejects(() => service.runner.runDaily({ trigger: 'test' }), /failed validation/);
  assert.equal(openaiCalls, 2, 'one attempt plus one repair attempt');
  assert.equal(http.calls.filter((call) => call.url.includes('graph.facebook.com')).length, 0);
});

test('the OpenAI request asks for the eight brief items with a strict schema', async () => {
  const http = fakeHttp((url) => {
    if (url.includes('openai.com')) {
      return {
        ok: true,
        status: 200,
        data: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(validPack()) }] }] },
      };
    }
    return { ok: true, status: 200, data: { messages: [{ id: 'wamid.OK' }] } };
  });

  const { service } = buildService({
    env: { CONTENT_SOURCE: 'openai', OPENAI_API_KEY: 'sk-test' },
    http,
    now: () => FIXED_NOW,
  });
  await service.content.generate({ nowMs: FIXED_NOW });

  const call = http.calls.find((entry) => entry.url.includes('openai.com'));
  const body = JSON.parse(call.options.body);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  const required = body.text.format.schema.required;
  for (const field of ['format', 'pillar', 'hook', 'concept', 'shotList', 'onScreenText', 'caption', 'hashtags', 'cta', 'tracking', 'publishTimeIST']) {
    assert.ok(required.includes(field), `schema should require ${field}`);
  }
  assert.match(body.input, /Never invent project results/);
  assert.match(body.input, /luxury, dream, transform, seamless, elevate/);
});
