import cron from 'node-cron';
import { isValidTimezone, normalizePhone } from './util.js';
import { STORAGE_DRIVERS } from './store.js';

/**
 * Canonical variable name -> legacy names still accepted so an existing
 * deployment does not break. Anything read through an alias is reported back
 * so the README can tell the operator to rename it.
 */
const ALIASES = {
  META_ACCESS_TOKEN: ['WHATSAPP_ACCESS_TOKEN'],
  META_APP_SECRET: ['WHATSAPP_APP_SECRET'],
  META_VERIFY_TOKEN: ['WHATSAPP_VERIFY_TOKEN'],
  META_GRAPH_API_VERSION: ['META_API_VERSION', 'WHATSAPP_GRAPH_VERSION'],
  DAILY_CRON: ['DAILY_SCHEDULE'],
  WHATSAPP_RECIPIENT_NUMBER: ['WHATSAPP_RECIPIENT'],
};

const SECRET_KEYS = [
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'ADMIN_TRIGGER_TOKEN',
  'OPENAI_API_KEY',
];

const REQUIRED_KEYS = [
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_RECIPIENT_NUMBER',
];

/** Where each variable is set, so the startup error is actionable. */
const LOCATION = {
  META_ACCESS_TOKEN: 'Render → Environment (from Meta Business settings → System Users → Generate token)',
  META_APP_SECRET: 'Render → Environment (from Meta App Dashboard → App settings → Basic)',
  META_VERIFY_TOKEN: 'Render → Environment (a long random string you invent, also entered in the Meta webhook screen)',
  WHATSAPP_PHONE_NUMBER_ID: 'Render → Environment (from Meta App Dashboard → WhatsApp → API Setup)',
  WHATSAPP_RECIPIENT_NUMBER: 'Render → Environment (a number you control, different from the business number)',
  ADMIN_TRIGGER_TOKEN: 'Render → Environment (a long random string you invent)',
  PUBLIC_BASE_URL: 'Render → Environment (your service URL, e.g. https://your-service.onrender.com)',
  META_APP_ID: 'Render → Environment (from Meta App Dashboard → App settings → Basic)',
};

const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  LOG_LEVEL: 'info',
  TIMEZONE: 'Asia/Kolkata',
  DATA_DIR: './data',
  ENABLE_INTERNAL_CRON: 'false',
  DAILY_CRON: '30 8 * * *',
  META_GRAPH_API_VERSION: 'v26.0',
  WHATSAPP_DELIVERY_MODE: 'link',
  WHATSAPP_TEMPLATE_NAME: 'jfi_daily_content_pack',
  WHATSAPP_TEMPLATE_LANGUAGE: 'en',
  WHATSAPP_TEMPLATE_URL_BUTTON_INDEX: '0',
  WHATSAPP_TEMPLATE_BODY_FIELDS: 'dateLabel',
  CONTENT_SOURCE: 'auto',
  OPENAI_MODEL: 'gpt-6-luna',
  META_TIMEOUT_MS: '15000',
  META_MAX_RETRIES: '2',
  OPENAI_TIMEOUT_MS: '60000',
};

const DELIVERY_MODES = new Set(['link', 'text']);
const TEMPLATE_BODY_FIELDS = new Set(['dateLabel', 'pillar', 'hook', 'format', 'concept', 'publishTimeIST']);
const CONTENT_SOURCES = new Set(['auto', 'openai', 'static']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
const PLACEHOLDER_VALUES = new Set([
  'changeme',
  'change-me',
  'your-token',
  'your_token',
  'todo',
  'placeholder',
  'xxxx',
  'your-verify-token',
]);

function read(env, key) {
  const names = [key, ...(ALIASES[key] ?? [])];
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && String(value).trim() !== '') {
      return { value: String(value).trim(), source: name };
    }
  }
  return { value: undefined, source: null };
}

function boolOf(value, fallback) {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function intOf(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function looksLikePlaceholder(value) {
  const lower = String(value).toLowerCase();
  if (PLACEHOLDER_VALUES.has(lower)) return true;
  return /^vx+\.x+$/i.test(value);
}

/**
 * Validate every environment variable and return a frozen config object.
 * Never throws and never logs a value — callers decide what to do with
 * `errors` (server.js prints the variable names and exits 1).
 */
export function loadConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const aliasNotes = [];
  const get = (key) => {
    const { value, source } = read(env, key);
    if (value !== undefined && source && source !== key) {
      aliasNotes.push({ canonical: key, used: source });
    }
    return value ?? DEFAULTS[key];
  };

  const nodeEnv = get('NODE_ENV');
  const isProduction = nodeEnv === 'production';

  // --- Runtime -------------------------------------------------------------
  const port = intOf(get('PORT'), 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('PORT must be an integer between 1 and 65535.');
  }

  const logLevel = get('LOG_LEVEL').toLowerCase();
  if (!LOG_LEVELS.has(logLevel)) {
    errors.push(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')}.`);
  }

  const timezone = get('TIMEZONE');
  if (!isValidTimezone(timezone)) {
    errors.push(`TIMEZONE "${timezone}" is not a valid IANA timezone. Use Asia/Kolkata.`);
  }

  const dataDir = get('DATA_DIR');

  // Serverless platforms recycle instances and give no persistent disk, which
  // changes what the app can promise. Detected rather than configured so it
  // cannot drift out of sync with where the code actually runs.
  const isServerless = Boolean(env.VERCEL) || Boolean(env.NETLIFY) || Boolean(env.AWS_LAMBDA_FUNCTION_NAME);

  // --- Storage -------------------------------------------------------------
  const storageDriver = (get('STORAGE_DRIVER') || 'file').toLowerCase();
  if (!STORAGE_DRIVERS.includes(storageDriver)) {
    errors.push(
      `STORAGE_DRIVER "${storageDriver}" is not supported. Use one of: ${STORAGE_DRIVERS.join(', ')}.` +
        (storageDriver === 'vercel-blob'
          ? ' The vercel-blob driver was considered and deliberately not built — see docs/STORAGE-PROPOSAL.md. Redis covers the same need without the lock race.'
          : ''),
    );
  }

  const redisUrl = String(env.UPSTASH_REDIS_REST_URL ?? '').trim().replace(/\/+$/, '');
  const redisToken = String(env.UPSTASH_REDIS_REST_TOKEN ?? '').trim();
  if (storageDriver === 'redis') {
    if (!redisUrl) errors.push('STORAGE_DRIVER is "redis" but UPSTASH_REDIS_REST_URL is not set.');
    if (!redisToken) errors.push('STORAGE_DRIVER is "redis" but UPSTASH_REDIS_REST_TOKEN is not set.');
    if (redisUrl && !/^https:\/\/[^/]+$/.test(redisUrl)) {
      errors.push('UPSTASH_REDIS_REST_URL must be an https URL such as https://xxx.upstash.io (no trailing slash, no path).');
    }
  }

  if (storageDriver === 'file' && isServerless) {
    warnings.push(
      'Running on a serverless platform with STORAGE_DRIVER=file: there is no persistent disk, so pack links will usually 404 and the run lock and webhook de-duplication reset between invocations. Set STORAGE_DRIVER=redis with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to fix this.',
    );
  }

  // --- Scheduler -----------------------------------------------------------
  const dailyCron = get('DAILY_CRON');
  const cronValid = cron.validate(dailyCron);
  if (!cronValid) {
    errors.push('DAILY_CRON is not a valid cron expression. The default for 08:30 IST is "30 8 * * *".');
  }
  const enableInternalCron = boolOf(env.ENABLE_INTERNAL_CRON, false);
  if (enableInternalCron && isProduction) {
    warnings.push(
      'ENABLE_INTERNAL_CRON is on in production. A Render Cron Job is more reliable than an in-process timer because it still runs after a restart or a sleeping instance. Keep this on only for a single always-on instance.',
    );
  }

  // --- Meta credentials ----------------------------------------------------
  const values = {};
  for (const key of SECRET_KEYS.concat(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_RECIPIENT_NUMBER', 'PUBLIC_BASE_URL'])) {
    values[key] = get(key);
  }

  for (const key of REQUIRED_KEYS) {
    if (!values[key]) {
      errors.push(`Missing required variable ${key}. Set it in ${LOCATION[key] ?? 'the environment'}.`);
    }
  }

  for (const key of SECRET_KEYS) {
    const value = values[key];
    if (value && looksLikePlaceholder(value)) {
      errors.push(`${key} still contains a placeholder value. Replace it with the real value.`);
    }
  }

  const graphVersion = get('META_GRAPH_API_VERSION');
  if (!/^v\d{1,3}\.\d$/.test(graphVersion)) {
    errors.push(
      `META_GRAPH_API_VERSION "${graphVersion}" is not a valid Graph API version. Use a version from Meta's changelog, e.g. v26.0.`,
    );
  }

  const phoneNumberId = values.WHATSAPP_PHONE_NUMBER_ID ?? '';
  if (phoneNumberId && !/^\d{5,25}$/.test(phoneNumberId)) {
    errors.push(
      'WHATSAPP_PHONE_NUMBER_ID must be the numeric Phone Number ID (digits only) — not the phone number, the WABA ID, or the App ID.',
    );
  }

  const businessAccountId = get('WHATSAPP_BUSINESS_ACCOUNT_ID') ?? '';
  if (businessAccountId && !/^\d{5,25}$/.test(businessAccountId)) {
    warnings.push('WHATSAPP_BUSINESS_ACCOUNT_ID should be numeric digits only; it will be ignored if invalid.');
  }

  const appId = get('META_APP_ID') ?? '';
  if (appId && !/^\d{5,25}$/.test(appId)) {
    errors.push(
      `META_APP_ID "${appId}" is not numeric. It is the App ID from App settings → Basic — not the Phone Number ID and not the WABA ID.`,
    );
  }
  if (!appId) {
    warnings.push(
      'META_APP_ID is not set. It is only needed for webhook-subscription tooling (scripts/setup-meta.js); the service itself does not require it.',
    );
  }

  const recipientRaw = values.WHATSAPP_RECIPIENT_NUMBER ?? '';
  const recipient = normalizePhone(recipientRaw);
  if (recipientRaw && !/^\d{8,15}$/.test(recipient)) {
    errors.push(
      'WHATSAPP_RECIPIENT_NUMBER must be 8–15 digits in international format without "+" or spaces, e.g. 919876543210.',
    );
  }

  const senderNumber = normalizePhone(get('WHATSAPP_SENDER_NUMBER') ?? '');
  if (senderNumber && recipient && senderNumber === recipient) {
    errors.push(
      'WHATSAPP_RECIPIENT_NUMBER equals WHATSAPP_SENDER_NUMBER. The WhatsApp Cloud API is designed for a business number to message a different recipient; sending the daily pack to the same number that sends it is not a supported workflow. Set the recipient to a team member or customer number you control.',
    );
  }

  const verifyToken = values.META_VERIFY_TOKEN ?? '';
  if (verifyToken && (verifyToken === values.META_ACCESS_TOKEN || verifyToken === values.META_APP_SECRET)) {
    errors.push('META_VERIFY_TOKEN must not be the same value as META_ACCESS_TOKEN or META_APP_SECRET.');
  }
  if (verifyToken && verifyToken.length < 16) {
    warnings.push('META_VERIFY_TOKEN is short. Use at least 32 random characters.');
  }

  const accessToken = values.META_ACCESS_TOKEN ?? '';
  if (accessToken && !accessToken.startsWith('EAA')) {
    warnings.push(
      'META_ACCESS_TOKEN does not look like a Meta Graph API token (they normally start with "EAA"). Double-check you pasted the access token, not the App ID or the WABA ID.',
    );
  }

  const adminToken = values.ADMIN_TRIGGER_TOKEN ?? '';
  if (adminToken && adminToken.length < 24) {
    warnings.push('ADMIN_TRIGGER_TOKEN is short. Use at least 32 random characters.');
  }
  if (adminToken && (adminToken === accessToken || adminToken === verifyToken)) {
    errors.push('ADMIN_TRIGGER_TOKEN must be a different value from the Meta tokens.');
  }
  if (!adminToken) {
    warnings.push(
      'ADMIN_TRIGGER_TOKEN is not set, so /admin/* endpoints and a Render Cron Job cannot be used. Set it if you want the manual trigger or an external scheduler.',
    );
  }

  // --- Delivery ------------------------------------------------------------
  const deliveryMode = get('WHATSAPP_DELIVERY_MODE').toLowerCase();
  if (!DELIVERY_MODES.has(deliveryMode)) {
    errors.push(`WHATSAPP_DELIVERY_MODE must be "link" or "text", not "${deliveryMode}".`);
  }

  const templateName = get('WHATSAPP_TEMPLATE_NAME');
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) {
    errors.push('WHATSAPP_TEMPLATE_NAME must be lowercase letters, digits and underscores (Meta template naming rule).');
  }
  const templateLanguage = get('WHATSAPP_TEMPLATE_LANGUAGE');
  const templateUrlButtonIndex = intOf(get('WHATSAPP_TEMPLATE_URL_BUTTON_INDEX'), 0);
  if (!Number.isInteger(templateUrlButtonIndex) || templateUrlButtonIndex < 0 || templateUrlButtonIndex > 9) {
    errors.push('WHATSAPP_TEMPLATE_URL_BUTTON_INDEX must be an integer between 0 and 9.');
  }

  const templateBodyFields = String(get('WHATSAPP_TEMPLATE_BODY_FIELDS'))
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  const unknownFields = templateBodyFields.filter((field) => !TEMPLATE_BODY_FIELDS.has(field));
  if (unknownFields.length) {
    errors.push(
      `WHATSAPP_TEMPLATE_BODY_FIELDS contains unsupported field(s): ${unknownFields.join(', ')}. Allowed: ${[...TEMPLATE_BODY_FIELDS].join(', ')}.`,
    );
  }

  // Hosts inject their own public URL. Read whichever one is present so nobody
  // has to copy an address into a variable by hand:
  //   Render  -> RENDER_EXTERNAL_URL (already a full URL)
  //   Vercel  -> VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL (host only, no scheme)
  // PUBLIC_BASE_URL stays as an explicit override for a custom domain.
  const asOrigin = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return withScheme.replace(/\/+$/, '');
  };

  // Render always supplies a full URL, so anything else there is junk and is
  // ignored. Vercel supplies a bare hostname, so a scheme is added for it.
  const renderRaw = String(env.RENDER_EXTERNAL_URL ?? '').trim().replace(/\/+$/, '');
  const renderExternalUrl = /^https?:\/\/[^/]+$/.test(renderRaw) ? renderRaw : '';
  const vercelUrl = asOrigin(env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL);

  let publicBaseUrl = (values.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  if (publicBaseUrl) {
    try {
      const parsed = new URL(publicBaseUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
      if (isProduction && parsed.protocol !== 'https:') {
        errors.push('PUBLIC_BASE_URL must use https in production; WhatsApp recipients cannot open an http link.');
      }
    } catch {
      errors.push('PUBLIC_BASE_URL must be an absolute URL such as https://your-service.onrender.com (no trailing slash).');
      publicBaseUrl = '';
    }
  }
  const hostUrl = [renderExternalUrl, vercelUrl].find((candidate) => /^https?:\/\/[^/]+$/.test(candidate)) ?? '';
  const resolvedBaseUrl = publicBaseUrl || hostUrl;
  const baseUrlSource = publicBaseUrl
    ? 'PUBLIC_BASE_URL'
    : renderExternalUrl && resolvedBaseUrl === renderExternalUrl
      ? 'RENDER_EXTERNAL_URL'
      : vercelUrl && resolvedBaseUrl === vercelUrl
        ? 'VERCEL_URL'
        : 'unresolved';

  // Deliberately a warning, not an error. On a first deploy nobody can know the
  // URL before Render creates the service, so refusing to boot would crash-loop
  // it before the URL could even be read. The service starts, /health answers,
  // /status explains the situation, and a send either uses the detected URL or
  // refuses with a clear reason.
  if (deliveryMode === 'link' && !resolvedBaseUrl) {
    warnings.push(
      'No public URL could be determined, so link delivery will fall back to the URL of the incoming request. ' +
        'On Render this resolves automatically via RENDER_EXTERNAL_URL; set PUBLIC_BASE_URL only if you use a custom domain.',
    );
  }

  // --- Content -------------------------------------------------------------
  const contentSource = get('CONTENT_SOURCE').toLowerCase();
  if (!CONTENT_SOURCES.has(contentSource)) {
    errors.push(`CONTENT_SOURCE must be one of: ${[...CONTENT_SOURCES].join(', ')}.`);
  }
  const openaiKey = values.OPENAI_API_KEY ?? '';
  if (contentSource === 'openai' && !openaiKey) {
    errors.push('CONTENT_SOURCE is "openai" but OPENAI_API_KEY is not set.');
  }
  const effectiveContentSource =
    contentSource === 'auto' ? (openaiKey ? 'openai' : 'static') : contentSource;

  const config = {
    nodeEnv,
    isProduction,
    port,
    logLevel,
    timezone,
    dataDir,
    isServerless,
    storageDriver,
    redis: { url: redisUrl, token: redisToken },
    enableInternalCron,
    dailyCron: cronValid ? dailyCron : DEFAULTS.DAILY_CRON,
    graphApiVersion: graphVersion,
    graphBaseUrl: `https://graph.facebook.com/${graphVersion}`,
    phoneNumberId,
    businessAccountId,
    appId,
    recipientNumber: recipient,
    senderNumber,
    accessToken,
    appSecret: values.META_APP_SECRET ?? '',
    verifyToken,
    adminToken,
    deliveryMode,
    templateName,
    templateLanguage,
    templateUrlButtonIndex,
    templateBodyFields: templateBodyFields.length ? templateBodyFields : ['dateLabel'],
    publicBaseUrl,
    resolvedBaseUrl,
    baseUrlSource,
    publicBaseUrlConfigured: Boolean(resolvedBaseUrl),
    contentSource,
    effectiveContentSource,
    openaiKey,
    openaiModel: get('OPENAI_MODEL'),
    metaTimeoutMs: intOf(get('META_TIMEOUT_MS'), 15_000),
    metaMaxRetries: intOf(get('META_MAX_RETRIES'), 2),
    openaiTimeoutMs: intOf(get('OPENAI_TIMEOUT_MS'), 60_000),
  };

  return { config: Object.freeze(config), errors, warnings, aliasNotes };
}

/** Human-readable, value-free summary of the resolved configuration. */
export function describeConfig(config) {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    timezone: config.timezone,
    graphApiVersion: config.graphApiVersion,
    appId: config.appId || undefined,
    deliveryMode: config.deliveryMode,
    baseUrlSource: config.baseUrlSource,
    serverless: config.isServerless,
    storageDriver: config.storageDriver,
    contentSource: config.effectiveContentSource,
    templateName: config.templateName,
    templateLanguage: config.templateLanguage,
    templateBodyFields: config.templateBodyFields,
    internalCron: config.enableInternalCron,
    dataDir: config.dataDir,
  };
}
