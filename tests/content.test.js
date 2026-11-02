import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, PILLARS, packToText, ContentError } from '../src/content.js';
import { buildTemplateParams, DeliveryError } from '../src/daily.js';
import { buildService, fakeHttp } from './helpers.js';

const FIXED_NOW = Date.UTC(2026, 10, 3, 6, 30); // 3 Nov 2026, 12:00 IST

function staticService(env = {}) {
  return buildService({ env, now: () => FIXED_NOW });
}

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
    seen.add(pack.pillar);
  }
  assert.equal(seen.size, PILLARS.length, 'all six pillars should appear across a rotation');
});

test('validatePack rejects an over-long hook', () => {
  const pack = {
    pillar: 'process',
    format: 'Reel, 20s',
    hook: 'one two three four five six seven eight nine ten eleven twelve thirteen',
    caption: 'x'.repeat(120),
    cta: 'WhatsApp us',
    hashtags: ['#a', '#b', '#c', '#d', '#e'],
    shotList: ['a', 'b', 'c'],
    publishTimeIST: '7:30 PM IST',
  };
  const check = validatePack(pack);
  assert.equal(check.ok, false);
  assert.match(check.problems.join('; '), /at most 12/);
});

test('validatePack requires a number or place name in the hook', () => {
  const pack = {
    pillar: 'process',
    format: 'Reel, 20s',
    hook: 'a quiet walkthrough of the finished flat',
    caption: 'x'.repeat(120),
    cta: 'WhatsApp us',
    hashtags: ['#a', '#b', '#c', '#d', '#e'],
    shotList: ['a', 'b', 'c'],
    publishTimeIST: '7:30 PM IST',
  };
  assert.match(validatePack(pack).problems.join('; '), /number or a Bengaluru place name/);
});

test('validatePack catches off-brand words', () => {
  const pack = {
    pillar: 'trust',
    format: 'Static post',
    hook: 'Nine clauses before you pay any advance',
    caption: `A luxury ${'x'.repeat(120)}`,
    cta: 'WhatsApp us',
    hashtags: ['#a', '#b', '#c', '#d', '#e'],
    shotList: ['a', 'b', 'c'],
    publishTimeIST: '7:30 PM IST',
  };
  assert.match(validatePack(pack).problems.join('; '), /luxury/);
});

test('validatePack rejects a missing publish time and short hashtag list', () => {
  const problems = validatePack({ pillar: 'process', format: 'f', hook: '5 things', caption: 'x'.repeat(120), cta: 'c', hashtags: ['#a'], shotList: [], publishTimeIST: '' }).problems.join('; ');
  assert.match(problems, /at least 5/);
  assert.match(problems, /at least 3/);
  assert.match(problems, /publishTimeIST/);
});

test('packToText renders every required section', () => {
  const pack = {
    dateLabel: 'Tue 3 Nov 2026',
    pillar: 'process',
    format: 'Reel, 20s',
    hook: 'Whitefield handover: 14 checkpoints',
    caption: 'caption body',
    cta: 'WhatsApp us',
    hashtags: ['#a', '#b'],
    shotList: ['shot one', 'shot two'],
    publishTimeIST: '7:30 PM IST',
  };
  const text = packToText(pack);
  for (const needle of ['HOOK', 'CAPTION', 'CALL TO ACTION', 'HASHTAGS', 'SHOT LIST', 'PUBLISH', '1. shot one']) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

test('template body params are built from the configured fields', () => {
  const pack = { dateLabel: 'Tue 3 Nov 2026', pillar: 'trust', hook: 'Nine clauses' };
  assert.deepEqual(buildTemplateParams(pack, ['dateLabel']), ['Tue 3 Nov 2026']);
  assert.deepEqual(buildTemplateParams(pack, ['dateLabel', 'pillar']), ['Tue 3 Nov 2026', 'trust']);
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
  assert.equal(service.store.getLastRun().status, 'failed');
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
                  text: JSON.stringify({
                    pillar: 'process',
                    format: 'Reel',
                    hook: Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '),
                    caption: 'x'.repeat(120),
                    cta: 'WhatsApp us',
                    hashtags: ['#a', '#b', '#c', '#d', '#e'],
                    shotList: ['a', 'b', 'c'],
                    publishTimeIST: '7:30 PM IST',
                  }),
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
