import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_DRIVERS } from '../src/store.js';
import { createRedisStore } from '../src/stores/redisStore.js';
import { silentLogger } from './helpers.js';

/**
 * A fake Upstash REST endpoint: enough of Redis to prove the driver builds the
 * right commands and honours the lock semantics. It is deliberately strict — an
 * unsupported command throws, so a typo in the driver fails loudly here.
 */
function fakeUpstash() {
  const strings = new Map();
  const ttls = new Map();
  const zsets = new Map();
  const calls = [];

  function exec(args) {
    const [rawCommand, ...rest] = args;
    const command = String(rawCommand).toUpperCase();
    switch (command) {
      case 'PING':
        return 'PONG';
      case 'SET': {
        const [key, value, ...options] = rest;
        const upper = options.map((option) => String(option).toUpperCase());
        if (upper.includes('NX') && strings.has(key)) return null;
        strings.set(key, String(value));
        const exIndex = upper.indexOf('EX');
        const pxIndex = upper.indexOf('PX');
        if (exIndex !== -1) ttls.set(key, Number(options[exIndex + 1]) * 1000);
        if (pxIndex !== -1) ttls.set(key, Number(options[pxIndex + 1]));
        return 'OK';
      }
      case 'GET':
        return strings.has(rest[0]) ? strings.get(rest[0]) : null;
      case 'DEL':
        return strings.delete(rest[0]) ? 1 : 0;
      case 'EXISTS':
        return strings.has(rest[0]) ? 1 : 0;
      case 'ZADD': {
        const [key, score, member] = rest;
        if (!zsets.has(key)) zsets.set(key, new Map());
        zsets.get(key).set(member, Number(score));
        return 1;
      }
      case 'ZREVRANGE': {
        const set = zsets.get(rest[0]) ?? new Map();
        return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([member]) => member);
      }
      case 'ZREMRANGEBYRANK':
        return 0;
      default:
        throw new Error(`fakeUpstash: unsupported command ${command}`);
    }
  }

  const http = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    if (String(url).endsWith('/pipeline')) {
      return { ok: true, status: 200, data: body.map((args) => ({ result: exec(args) })), attempts: 1, retryable: false };
    }
    return { ok: true, status: 200, data: { result: exec(body) }, attempts: 1, retryable: false };
  };

  http.calls = calls;
  http.strings = strings;
  http.ttls = ttls;
  http.zsets = zsets;
  return http;
}

const URL_BASE = 'https://fake-upstash.upstash.io';
const TOKEN = 'fake-token';

function build(overrides = {}) {
  const http = fakeUpstash();
  const store = createRedisStore({
    url: URL_BASE,
    token: TOKEN,
    logger: silentLogger,
    http,
    now: () => Date.UTC(2026, 10, 3, 6, 30),
    ...overrides,
  });
  return { store, http };
}

test('the factory exposes exactly the supported drivers', () => {
  assert.deepEqual(STORAGE_DRIVERS, ['file', 'redis']);
});

test('an unknown driver throws instead of silently falling back', () => {
  assert.throws(() => createStore({ driver: 'vercel-blob', dir: '/tmp/x', logger: silentLogger }), /not supported/);
  assert.throws(() => createStore({ driver: 'nope', dir: '/tmp/x', logger: silentLogger }), /no silent fallback/);
});

test('the redis driver refuses to construct without credentials', () => {
  assert.throws(() => createRedisStore({ url: '', token: 'x', logger: silentLogger }), /UPSTASH_REDIS_REST_URL/);
  assert.throws(() => createRedisStore({ url: URL_BASE, token: '', logger: silentLogger }), /UPSTASH_REDIS_REST_TOKEN/);
});

test('init pings, and sends the bearer token plus a JSON array body', async () => {
  const { store, http } = build();
  await store.init();
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, URL_BASE);
  assert.deepEqual(http.calls[0].body, ['PING']);
  assert.equal(http.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(http.calls[0].headers['Content-Type'], 'application/json');
});

test('savePack writes the pack, the date index and the sorted set in one pipeline', async () => {
  const { store, http } = build();
  await store.savePack({ id: 'pack_abc12345', date: '2026-11-03', status: 'generated', pillar: 'process' });

  const pipelineCall = http.calls.find((call) => String(call.url).endsWith('/pipeline'));
  assert.ok(pipelineCall, 'should use a pipeline');
  const commands = pipelineCall.body.map((args) => args[0]);
  assert.deepEqual(commands, ['SET', 'SET', 'ZADD', 'ZREMRANGEBYRANK']);

  assert.ok(http.strings.has('jfi:pack:pack_abc12345'));
  assert.equal(http.strings.get('jfi:index:2026-11-03'), 'pack_abc12345');
  assert.equal(http.zsets.get('jfi:dates').get('2026-11-03'), 20261103);
});

test('a pack round-trips through getPackById and getPackByDate', async () => {
  const { store } = build();
  await store.savePack({ id: 'pack_roundtrip1', date: '2026-11-03', status: 'sent', hook: 'a hook' });

  const byId = await store.getPackById('pack_roundtrip1');
  assert.equal(byId.hook, 'a hook');
  assert.equal(byId.status, 'sent');
  assert.ok(byId.savedAt, 'savePack should stamp savedAt');

  const byDate = await store.getPackByDate('2026-11-03');
  assert.equal(byDate.id, 'pack_roundtrip1');

  assert.equal(await store.getPackByDate('2026-01-01'), null);
});

test('getPackById rejects a malformed id without touching Redis', async () => {
  const { store, http } = build();
  // The guard is /^[A-Za-z0-9_-]{8,64}$/, so anything with a path separator or a
  // dot is refused before it can reach Redis as a key.
  assert.equal(await store.getPackById('has/slashes/inside'), null);
  assert.equal(await store.getPackById('has.dots.inside.it'), null);
  assert.equal(await store.getPackById('short'), null);
  assert.equal(await store.getPackById(`${'a'.repeat(200)}`), null);
  assert.equal(http.calls.length, 0, 'a malformed id must not become a Redis command');
});

test('latestPack reads the newest date from the sorted set', async () => {
  const { store } = build();
  await store.savePack({ id: 'pack_older1234', date: '2026-11-02', status: 'sent' });
  await store.savePack({ id: 'pack_newer1234', date: '2026-11-03', status: 'sent' });

  const latest = await store.latestPack();
  assert.equal(latest.id, 'pack_newer1234');
});

test('latestPack returns null when nothing has been saved', async () => {
  const { store } = build();
  assert.equal(await store.latestPack(), null);
});

test('updatePack merges rather than replacing', async () => {
  const { store } = build();
  await store.savePack({ id: 'pack_update123', date: '2026-11-03', status: 'generated', hook: 'keep me' });

  const updated = await store.updatePack('pack_update123', { status: 'sent', messageIds: ['wamid.1'] });
  assert.equal(updated.status, 'sent');
  assert.equal(updated.hook, 'keep me', 'existing fields must survive');

  assert.equal(await store.updatePack('pack_missing999', { status: 'sent' }), null);
});

test('webhook dedupe uses a 24-hour TTL', async () => {
  const { store, http } = build();
  assert.equal(await store.hasSeenEvent('msg:wamid.1'), false);

  await store.markEventSeen('msg:wamid.1');
  assert.equal(await store.hasSeenEvent('msg:wamid.1'), true);

  const setCall = http.calls.find((call) => call.body[0] === 'SET' && call.body[1] === 'jfi:evt:msg:wamid.1');
  assert.deepEqual(setCall.body.slice(2), ['1', 'EX', '86400']);
});

test('the 24-hour window is recorded with a 48-hour TTL', async () => {
  const { store, http } = build();
  assert.equal(await store.lastInboundAt('919876543210'), null);
  assert.equal(await store.isWithinServiceWindow('919876543210'), false);

  await store.recordInbound('919876543210');
  const setCall = http.calls.find((call) => call.body[0] === 'SET' && call.body[1] === 'jfi:in:919876543210');
  assert.deepEqual(setCall.body.slice(2), [String(Date.UTC(2026, 10, 3, 6, 30)), 'EX', '172800']);

  assert.equal(await store.isWithinServiceWindow('919876543210'), true);
});

test('the run lock is a single atomic SET NX PX', async () => {
  const { store, http } = build();
  const lock = await store.tryAcquireRunLock('2026-11-03', 'process-a');
  assert.equal(lock.acquired, true);

  const setCall = http.calls.find((call) => call.body[0] === 'SET' && call.body[1] === 'jfi:lock');
  assert.equal(setCall.body[3], 'NX');
  assert.equal(setCall.body[4], 'PX');
  assert.equal(setCall.body[5], '900000', 'stale after 15 minutes');
});

test('a second runner cannot take a held lock', async () => {
  const { store } = build();
  assert.equal((await store.tryAcquireRunLock('2026-11-03', 'process-a')).acquired, true);

  const second = await store.tryAcquireRunLock('2026-11-03', 'process-b');
  assert.equal(second.acquired, false);
  assert.equal(second.reason, 'another-run-in-progress');
});

test('releasing the lock lets the next run proceed', async () => {
  const { store } = build();
  await store.tryAcquireRunLock('2026-11-03', 'process-a');
  await store.releaseRunLock();
  assert.equal((await store.tryAcquireRunLock('2026-11-03', 'process-b')).acquired, true);
});

test('a day already marked sent is not re-run', async () => {
  const { store, http } = build();
  await store.savePack({ id: 'pack_alreadysent', date: '2026-11-03', status: 'sent' });
  http.calls.length = 0;

  const lock = await store.tryAcquireRunLock('2026-11-03', 'process-b');
  assert.equal(lock.acquired, false);
  assert.equal(lock.reason, 'already-sent-today');
  assert.ok(
    !http.calls.some((call) => call.body[1] === 'jfi:lock'),
    'no lock should be written when the day is already done',
  );
});

test('a failed day is retryable because only "sent" blocks a re-run', async () => {
  const { store } = build();
  await store.savePack({ id: 'pack_failed1234', date: '2026-11-03', status: 'failed' });
  assert.equal((await store.tryAcquireRunLock('2026-11-03', 'process-b')).acquired, true);
});

test('last run is stored and read back', async () => {
  const { store } = build();
  assert.equal(await store.getLastRun(), null);

  await store.recordRun({ date: '2026-11-03', status: 'sent', packId: 'pack_lastrun123' });
  const lastRun = await store.getLastRun();
  assert.equal(lastRun.status, 'sent');
  assert.equal(lastRun.packId, 'pack_lastrun123');
  assert.ok(lastRun.at);
});

test('a Redis error is surfaced, not swallowed', async () => {
  const http = async () => ({ ok: false, status: 401, data: { error: 'WRONGPASS bad credentials' }, attempts: 1 });
  const store = createRedisStore({ url: URL_BASE, token: 'bad', logger: silentLogger, http });
  await assert.rejects(() => store.init(), /WRONGPASS/);
});

test('a pipeline step error is surfaced', async () => {
  const http = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/pipeline')) {
      return { ok: true, status: 200, data: body.map(() => ({ error: 'OOM command not allowed' })), attempts: 1 };
    }
    return { ok: true, status: 200, data: { result: null }, attempts: 1 };
  };
  const store = createRedisStore({ url: URL_BASE, token: 'x', logger: silentLogger, http });
  await assert.rejects(() => store.savePack({ id: 'pack_oob123456', date: '2026-11-03' }), /pipeline step failed/);
});

test('a corrupt stored value does not crash a read', async () => {
  const { store, http } = build();
  http.strings.set('jfi:pack:pack_corrupt12', 'not json at all');
  assert.equal(await store.getPackById('pack_corrupt12'), null);
});
