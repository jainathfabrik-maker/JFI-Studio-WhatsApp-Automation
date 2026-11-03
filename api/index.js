/**
 * Vercel serverless entry point.
 *
 * `src/app.js` is a factory, not a default export, which is why Vercel's
 * auto-detection failed with:
 *   Invalid export found in module "/var/task/src/app.js".
 *   The default export must be a function or server.
 *
 * This module builds exactly the same Express app that `server.js` builds and
 * exports it as the default export. It deliberately does NOT:
 *   - call app.listen()            (Vercel owns the socket)
 *   - start the in-process cron    (serverless instances do not stay alive)
 *   - run the startup Meta lookup  (would add latency to a cold start, and the
 *                                   daily runner still enforces the guard)
 *
 * Everything else — signature verification, admin bearer auth, config
 * validation, secret redaction — is the same code path as production on Render
 * and in Docker.
 */
import { loadConfig, describeConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createService } from '../src/service.js';

// Vercel mounts the filesystem read-only except /tmp. Without this the pack
// store cannot create its directory and every request fails.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = '/tmp/jfi-data';
}

const { config, errors, warnings } = loadConfig(process.env);

/** A readable 500 is far more useful than a stack trace in the Vercel log. */
function configurationErrorHandler(problems) {
  const body = {
    ok: false,
    error: 'Configuration is invalid, so this deployment cannot serve requests.',
    // Variable NAMES only. Never a value.
    problems,
    hint: 'Set these in Vercel → Project → Settings → Environment Variables, then redeploy. /health stays unavailable until they are correct.',
  };
  return function handler(_req, res) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  };
}

function buildHandler() {
  if (errors.length > 0) {
    return configurationErrorHandler(errors);
  }

  const logger = createLogger({ level: config.logLevel });
  for (const warning of warnings) logger.warn(warning);

  try {
    const { app } = createService({ config, logger });
    logger.info('Vercel handler ready', { ...describeConfig(config), runtime: 'vercel' });
    return app;
  } catch (error) {
    // A throwing module leaves Vercel with an opaque "process exited" message.
    logger.error('Could not build the app for Vercel', { message: error.message });
    return configurationErrorHandler([`Runtime initialisation failed: ${error.message}`]);
  }
}

const handler = buildHandler();

export default handler;
