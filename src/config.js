import cron from 'node-cron';
import { isValidTimezone, normalizePhone } from './util.js';

/**
 * Canonical variable name -> legacy names still accepted so an existing
 * deployment does not break. Anything read through an alias is reported back
 * so the README can tell the operator to rename it.
 */
const ALIASES = {
  META_ACCESS_TOKEN: ['WHATSAPP_ACCESS_TOKEN'],
  META_APP_SECRET: ['WHATSAPP_APP_SECRET'],
  META_VERIFY_TOKEN: ['WHATSAPP_VERIFY_TOKEN'],
  META_GRAPH_API_VERSION: ['WHATSAPP_GRAPH_VERSION'],
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
const TEMPLATE_BODY_FIELDS = new Set(['dateLabel', 'pillar', 'hook', 'format', 'publishTimeIST']);
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
  if (deliveryMode === 'link' && !publicBaseUrl) {
    errors.push(
      `WHATSAPP_DELIVERY_MODE is "link" but PUBLIC_BASE_URL is not set. Set it in ${LOCATION.PUBLIC_BASE_URL}, or switch to WHATSAPP_DELIVERY_MODE=text (only works inside an open 24-hour window).`,
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
    enableInternalCron,
    dailyCron: cronValid ? dailyCron : DEFAULTS.DAILY_CRON,
    graphApiVersion: graphVersion,
    graphBaseUrl: `https://graph.facebook.com/${graphVersion}`,
    phoneNumberId,
    businessAccountId,
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
    deliveryMode: config.deliveryMode,
    contentSource: config.effectiveContentSource,
    templateName: config.templateName,
    templateLanguage: config.templateLanguage,
    templateBodyFields: config.templateBodyFields,
    internalCron: config.enableInternalCron,
    dataDir: config.dataDir,
  };
}
