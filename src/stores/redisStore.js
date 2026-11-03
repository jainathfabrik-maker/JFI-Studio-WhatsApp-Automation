import { requestJson } from '../http.js';

const EVENT_TTL_SECONDS = 24 * 60 * 60;
const INBOUND_TTL_SECONDS = 48 * 60 * 60;
const RUN_LOCK_STALE_MS = 15 * 60 * 1000;
const PACK_INDEX_KEEP = 120;
const COMMAND_TIMEOUT_MS = 8000;

/**
 * Redis storage driver, speaking the Upstash REST API (plain HTTPS + JSON, so
 * no TCP client and no extra dependency).
 *
 * Why Redis rather than object storage: every operation here needs either
 * atomicity or expiry.
 *   - the daily-run lock is one `SET key value NX PX 900000`, which is atomic.
 *     An object store would need read-compare-write and has a race window that
 *     could send the same WhatsApp message twice.
 *   - webhook de-duplication and the 24-hour window are `SET ... EX`, so Redis
 *     expires them; the file driver has to prune by hand.
 *
 * Key layout (prefix `jfi:`):
 *   jfi:pack:<id>       JSON pack
 *   jfi:index:<date>    pack id for that date
 *   jfi:dates           sorted set of dates, score = YYYYMMDD
 *   jfi:evt:<id>        seen webhook event, TTL 24h
 *   jfi:in:<waId>       last inbound timestamp, TTL 48h
 *   jfi:lock            daily-run lock, TTL 15m
 *   jfi:lastrun         last run record
 */
export function createRedisStore({ url, token, logger, now = () => Date.now(), http = requestJson, prefix = 'jfi' }) {
  if (!url || !token) {
    throw new Error('The redis storage driver needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }
  const base = String(url).replace(/\/+$/, '');
  const key = (suffix) => `${prefix}:${suffix}`;

  /**
   * Raw POST to the Upstash REST API. Returns the parsed body untouched, because
   * the two endpoints have different shapes: a single command answers
   * `{ result }`, while `/pipeline` answers an array of `{ result }` objects.
   */
  async function post(path, body, label) {
    const response = await http(`${base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxRetries: 1,
      label,
    });

    if (!response.ok) {
      const detail = response.data?.error ?? `HTTP ${response.status}`;
      throw new Error(`Redis ${label} failed: ${detail}`);
    }
    return response.data;
  }

  async function command(args) {
    const data = await post('', args, String(args[0]).toLowerCase());
    if (data?.error) throw new Error(`Redis ${args[0]} failed: ${data.error}`);
    return data?.result ?? null;
  }

  async function pipeline(commands) {
    if (commands.length === 0) return [];
    const results = await post('/pipeline', commands, 'pipeline');
    if (!Array.isArray(results)) throw new Error('Redis pipeline returned an unexpected shape.');
    for (const entry of results) {
      if (entry?.error) throw new Error(`Redis pipeline step failed: ${entry.error}`);
    }
    return results.map((entry) => entry?.result ?? null);
  }

  async function getJson(k) {
    const raw = await command(['GET', k]);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      logger.warn('Redis value was not valid JSON; ignoring', { key: k });
      return null;
    }
  }

  return {
    driver: 'redis',
    persistent: true,

    async init() {
      // A round trip at start-up turns a wrong URL or token into a clear error
      // instead of a mystery on the first send.
      await command(['PING']);
      logger.info('Store ready', { driver: 'redis', host: new URL(base).host });
    },

    // --- Packs -------------------------------------------------------------
    async savePack(pack) {
      const record = { ...pack, savedAt: new Date(now()).toISOString() };
      const score = Number(String(record.date).replace(/-/g, ''));
      await pipeline([
        ['SET', key(`pack:${record.id}`), JSON.stringify(record)],
        ['SET', key(`index:${record.date}`), record.id],
        ['ZADD', key('dates'), String(score), record.date],
        // Keep the newest N dates; ZREMRANGEBYRANK 0 -121 drops all but the top 120.
        ['ZREMRANGEBYRANK', key('dates'), '0', String(-(PACK_INDEX_KEEP + 1))],
      ]);
      return record;
    },

    async getPackById(id) {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id ?? ''))) return null;
      return getJson(key(`pack:${id}`));
    },

    async getPackByDate(dateKey) {
      const id = await command(['GET', key(`index:${dateKey}`)]);
      return id ? this.getPackById(id) : null;
    },

    async latestPack() {
      const dates = await command(['ZREVRANGE', key('dates'), '0', '0']);
      const latest = Array.isArray(dates) ? dates[0] : null;
      return latest ? this.getPackByDate(latest) : null;
    },

    async updatePack(id, patch) {
      const existing = await this.getPackById(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      await command(['SET', key(`pack:${id}`), JSON.stringify(updated)]);
      return updated;
    },

    // --- Webhook dedupe ----------------------------------------------------
    async hasSeenEvent(eventId) {
      const exists = await command(['EXISTS', key(`evt:${eventId}`)]);
      return Number(exists) === 1;
    },

    async markEventSeen(eventId) {
      await command(['SET', key(`evt:${eventId}`), '1', 'EX', String(EVENT_TTL_SECONDS)]);
    },

    // --- 24-hour window ----------------------------------------------------
    async recordInbound(waId) {
      if (!waId) return;
      await command(['SET', key(`in:${waId}`), String(now()), 'EX', String(INBOUND_TTL_SECONDS)]);
    },

    async lastInboundAt(waId) {
      const raw = await command(['GET', key(`in:${waId}`)]);
      // Number(null) is 0, which would read as "epoch" instead of "never".
      if (raw === null || raw === undefined || raw === '') return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    },

    async isWithinServiceWindow(waId, windowMs = 24 * 60 * 60 * 1000) {
      const last = await this.lastInboundAt(waId);
      return Boolean(last) && now() - last < windowMs;
    },

    // --- Daily run guard ---------------------------------------------------
    async tryAcquireRunLock(dateKey, owner = 'process') {
      const current = await this.getPackByDate(dateKey);
      if (current?.status === 'sent') return { acquired: false, reason: 'already-sent-today' };

      // Atomic: only one caller can win this SET.
      const acquired = await command([
        'SET',
        key('lock'),
        JSON.stringify({ dateKey, owner, at: now() }),
        'NX',
        'PX',
        String(RUN_LOCK_STALE_MS),
      ]);

      if (acquired === null) return { acquired: false, reason: 'another-run-in-progress' };
      return { acquired: true, reason: 'lock-acquired' };
    },

    async releaseRunLock() {
      await command(['DEL', key('lock')]);
    },

    async getLastRun() {
      return getJson(key('lastrun'));
    },

    async recordRun(record) {
      await command(['SET', key('lastrun'), JSON.stringify({ ...record, at: new Date(now()).toISOString() })]);
    },
  };
}
