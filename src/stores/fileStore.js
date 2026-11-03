import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_EVENTS = 5000;
const RUN_LOCK_STALE_MS = 15 * 60 * 1000;
const PACK_INDEX_KEEP = 120;

/**
 * Filesystem storage driver — the default.
 *
 * Every method returns a promise so all drivers share one interface. Internally
 * this one is mostly synchronous, which is fine: it is only ever used on a host
 * with a persistent process and a real disk.
 *
 * Everything lives under DATA_DIR. Losing that directory costs dedupe memory and
 * pack history, never correctness of a send.
 */
export function createFileStore({ dir, logger, now = () => Date.now() }) {
  const root = path.resolve(dir);
  const packsDir = path.join(root, 'packs');
  const statePath = path.join(root, 'state.json');
  const indexPath = path.join(packsDir, 'index.json');
  const lockPath = path.join(root, 'daily.lock');

  let state = { lastRun: null, lastInbound: {}, seenEvents: {} };
  let index = {};
  let loaded = false;
  let writeChain = Promise.resolve();

  function ensureDirs() {
    fs.mkdirSync(packsDir, { recursive: true });
  }

  function load() {
    if (loaded) return;
    ensureDirs();
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('Could not read state file; starting fresh', { reason: error.message });
    }
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('Could not read pack index; rebuilding lazily', { reason: error.message });
      index = {};
    }
    loaded = true;
  }

  /** Serialise all writes so two requests can never interleave a half-written file. */
  function enqueue(task) {
    writeChain = writeChain.then(task, task);
    return writeChain;
  }

  async function writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, filePath);
  }

  function pruneEvents() {
    const cutoff = now() - EVENT_TTL_MS;
    const entries = Object.entries(state.seenEvents ?? {});
    const kept = entries.filter(([, ts]) => ts >= cutoff);
    if (kept.length > MAX_TRACKED_EVENTS) kept.splice(0, kept.length - MAX_TRACKED_EVENTS);
    state.seenEvents = Object.fromEntries(kept);
  }

  function pruneInbound() {
    const cutoff = now() - 48 * 60 * 60 * 1000;
    const kept = Object.entries(state.lastInbound ?? {}).filter(([, ts]) => ts >= cutoff);
    state.lastInbound = Object.fromEntries(kept);
  }

  function persistState() {
    pruneEvents();
    pruneInbound();
    return enqueue(() => writeJsonAtomic(statePath, state));
  }

  function getPackById(id) {
    load();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id ?? ''))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(packsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    driver: 'file',
    persistent: true,
    root,

    async init() {
      load();
      logger.info('Store ready', { driver: 'file', dir: root, packs: Object.keys(index).length });
    },

    // --- Packs -------------------------------------------------------------
    async savePack(pack) {
      load();
      const record = { ...pack, savedAt: new Date(now()).toISOString() };
      index[record.date] = record.id;
      const keep = Object.keys(index).sort().slice(-PACK_INDEX_KEEP);
      index = Object.fromEntries(keep.map((key) => [key, index[key]]));
      await enqueue(async () => {
        await writeJsonAtomic(path.join(packsDir, `${record.id}.json`), record);
        await writeJsonAtomic(indexPath, index);
      });
      return record;
    },

    async getPackById(id) {
      return getPackById(id);
    },

    async getPackByDate(dateKey) {
      load();
      const id = index[dateKey];
      return id ? getPackById(id) : null;
    },

    async latestPack() {
      load();
      const dates = Object.keys(index).sort();
      const last = dates.at(-1);
      return last ? getPackById(index[last]) : null;
    },

    async updatePack(id, patch) {
      load();
      const existing = getPackById(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      await enqueue(() => writeJsonAtomic(path.join(packsDir, `${id}.json`), updated));
      return updated;
    },

    // --- Webhook dedupe ----------------------------------------------------
    async hasSeenEvent(eventId) {
      load();
      const seen = state.seenEvents?.[eventId];
      if (!seen) return false;
      return now() - seen < EVENT_TTL_MS;
    },

    async markEventSeen(eventId) {
      load();
      state.seenEvents[eventId] = now();
      await persistState();
    },

    // --- 24-hour window ----------------------------------------------------
    async recordInbound(waId) {
      load();
      if (!waId) return;
      state.lastInbound[waId] = now();
      await persistState();
    },

    async lastInboundAt(waId) {
      load();
      return state.lastInbound?.[waId] ?? null;
    },

    async isWithinServiceWindow(waId, windowMs = 24 * 60 * 60 * 1000) {
      const last = await this.lastInboundAt(waId);
      return Boolean(last) && now() - last < windowMs;
    },

    // --- Daily run guard ---------------------------------------------------
    async tryAcquireRunLock(dateKey, owner = `${process.pid}`) {
      load();
      const current = await this.getPackByDate(dateKey);
      if (current?.status === 'sent') return { acquired: false, reason: 'already-sent-today' };

      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const fresh = now() - (lock.at ?? 0) < RUN_LOCK_STALE_MS;
        if (fresh && lock.dateKey === dateKey && lock.owner !== owner) {
          return { acquired: false, reason: 'another-run-in-progress' };
        }
      } catch {
        // No lock file, or unreadable/stale: fall through and take it.
      }

      fs.writeFileSync(lockPath, JSON.stringify({ dateKey, owner, at: now() }), 'utf8');
      return { acquired: true, reason: 'lock-acquired' };
    },

    async releaseRunLock() {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    },

    async getLastRun() {
      load();
      return state.lastRun ?? null;
    },

    async recordRun(record) {
      load();
      state.lastRun = { ...record, at: new Date(now()).toISOString() };
      await persistState();
    },
  };
}
