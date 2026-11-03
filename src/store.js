import { createFileStore } from './stores/fileStore.js';
import { createRedisStore } from './stores/redisStore.js';

/**
 * Storage driver selection.
 *
 * The interface is uniform and every method is async:
 *
 *   init()
 *   savePack(pack)  getPackById(id)  getPackByDate(dateKey)  latestPack()
 *   updatePack(id, patch)
 *   hasSeenEvent(id)  markEventSeen(id)
 *   recordInbound(waId)  lastInboundAt(waId)  isWithinServiceWindow(waId)
 *   tryAcquireRunLock(dateKey, owner)  releaseRunLock()
 *   getLastRun()  recordRun(record)
 *
 * `file` is the default and behaves exactly as before. `redis` exists so the
 * app can run somewhere without a persistent disk (Vercel, Netlify, any
 * serverless host).
 *
 * An unknown driver throws at startup. It must never fall back silently: a
 * fallback would look like working storage and quietly lose packs.
 */
export const STORAGE_DRIVERS = ['file', 'redis'];

export function createStore({ driver = 'file', dir, logger, now = () => Date.now(), http, redis = {}, prefix }) {
  switch (driver) {
    case 'file':
      return createFileStore({ dir, logger, now });
    case 'redis':
      return createRedisStore({
        url: redis.url,
        token: redis.token,
        logger,
        now,
        http,
        ...(prefix ? { prefix } : {}),
      });
    default:
      throw new Error(
        `STORAGE_DRIVER "${driver}" is not supported. Supported values: ${STORAGE_DRIVERS.join(', ')}. ` +
          'Set STORAGE_DRIVER in the environment; there is no silent fallback.',
      );
  }
}
