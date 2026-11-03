import { createStore } from './store.js';
import { createWhatsAppClient } from './whatsapp.js';
import { createContentGenerator } from './content.js';
import { createDailyRunner } from './daily.js';
import { createApp } from './app.js';
import { requestJson } from './http.js';

/**
 * Build the whole service from a validated config.
 *
 * `http` is injectable so tests can drive Meta and OpenAI responses without a
 * network, and so a transport change stays in one place.
 *
 * `safety` is shared mutable state for the last-line self-send guard: the
 * startup check flips it on if Meta reports that the recipient IS the sending
 * business number, and every delivery path refuses while it is set.
 */
export function createService({ config, logger, http = requestJson, now = () => Date.now() }) {
  const store = createStore({
    driver: config.storageDriver,
    dir: config.dataDir,
    logger,
    now,
    http,
    redis: config.redis,
  });
  // Not awaited: init only warms the driver and surfaces a bad URL or token
  // early. Each driver method is self-sufficient, so a request never depends on
  // this having finished.
  Promise.resolve(store.init()).catch((error) =>
    logger.error('Storage driver failed to initialise', { driver: store.driver, message: error.message }),
  );

  const safety = { blocked: false, reason: null };

  const whatsapp = createWhatsAppClient({ config, logger, http });
  const content = createContentGenerator({ config, logger, http, now });
  const runner = createDailyRunner({ config, logger, store, whatsapp, content, now, safety });
  const app = createApp({ config, logger, store, whatsapp, runner, safety });

  return { app, store, whatsapp, content, runner, safety };
}
