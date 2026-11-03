#!/usr/bin/env node
/**
 * Perform the two Meta setup steps that can be done through the Graph API,
 * instead of clicking through the dashboard.
 *
 *   --check                 read the current webhook subscription (default action)
 *   --webhook               register the callback URL and subscribe to `messages`
 *   --template              create the content-pack message template
 *   --apply                 actually write. Without this, nothing is sent.
 *
 * Examples:
 *   GRAPH_TOKEN=EAA... APP_ID=1144843348011771 WABA_ID=123... PUBLIC_BASE_URL=https://x.onrender.com \
 *     META_VERIFY_TOKEN=my-random-token node scripts/setup-meta.js --check
 *
 *   ... node scripts/setup-meta.js --webhook --apply
 *   ... node scripts/setup-meta.js --template --apply
 *
 * Dry run is the default on purpose: these calls change your live Meta app.
 *
 * What this CANNOT do, because Meta has no API for it:
 *   - generate a System User access token  (Business settings → System users)
 *   - add a payment method                 (WhatsApp Manager → Payment settings)
 *   - publish the app / verify the business
 *   - approve the template                 (Meta reviews it; you just submit it)
 *
 * Docs:
 *   Webhooks API     https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *   Message templates https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 */

const VERSION = process.env.META_GRAPH_API_VERSION || 'v26.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

const TOKEN = process.env.GRAPH_TOKEN || process.env.META_ACCESS_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const APP_ID = process.env.APP_ID || process.env.META_APP_ID || '';
const WABA_ID = process.env.WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';

const TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || 'jfi_daily_content_pack';
const TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';
const TEMPLATE_CATEGORY = process.env.TEMPLATE_CATEGORY || 'MARKETING';
const BUTTON_TEXT = process.env.TEMPLATE_BUTTON_TEXT || 'Open pack';
const BODY_TEXT =
  process.env.TEMPLATE_BODY_TEXT || 'Your JFI Studio content pack for {{1}} is ready. Tap the button to open it.';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const APPLY = has('--apply');
const DO_WEBHOOK = has('--webhook');
const DO_TEMPLATE = has('--template');
const CHECK_ONLY = has('--check') || (!DO_WEBHOOK && !DO_TEMPLATE);

const CALLBACK_URL = BASE_URL ? `${BASE_URL}/webhook` : '';
const BUTTON_URL = BASE_URL ? `${BASE_URL}/p/{{1}}` : '';
const SAMPLE_PACK_ID = 'Zx8Kq2LmN4pR7sT1vW3y';

// --- output helpers -------------------------------------------------------
const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;

const problems = [];
const note = (message) => process.stdout.write(`${message}\n`);
const problem = (message) => problems.push(message);
const heading = (title) => note(`\n${bold(title)}\n${dim('─'.repeat(Math.max(24, title.length)))}`);

function die(message) {
  process.stderr.write(`\n${red('✗')} ${message}\n\n`);
  process.exit(1);
}

process.on('uncaughtException', (error) => die(`Unexpected error: ${error.message}`));
process.on('unhandledRejection', (reason) =>
  die(`Unexpected error: ${reason instanceof Error ? reason.message : String(reason)}`),
);

if (typeof fetch !== 'function') {
  die(`This script needs global fetch. Node ${process.version} does not provide it. Use Node 18+ (22 LTS recommended).`);
}
if (!TOKEN) {
  die(
    'No token found. Pass it in the environment, never as an argument:\n' +
      '  GRAPH_TOKEN=EAA... node scripts/setup-meta.js --check\n\n' +
      'Use a System User token from Business settings — a Graph API Explorer token expires.',
  );
}

// --- validation -----------------------------------------------------------
heading('Configuration');

const show = (label, value) => note(`  ${label.padEnd(22)}${value || dim('(not set)')}`);
show('Graph version', VERSION);
show('App ID', APP_ID);
show('WABA ID', WABA_ID);
show('Callback URL', CALLBACK_URL);
show('Verify token', VERIFY_TOKEN ? dim(`set (${VERIFY_TOKEN.length} characters)`) : '');
show('Template', `${TEMPLATE_NAME} / ${TEMPLATE_LANGUAGE} / ${TEMPLATE_CATEGORY}`);

if ((DO_WEBHOOK || CHECK_ONLY) && !APP_ID) {
  problem('APP_ID is not set. It is the App ID from App settings → Basic, e.g. 1144843348011771. Not the Phone Number ID.');
}
if (DO_WEBHOOK && !CALLBACK_URL) {
  problem('PUBLIC_BASE_URL is not set, so the callback URL cannot be built.');
}
if (DO_WEBHOOK && CALLBACK_URL && !CALLBACK_URL.startsWith('https://')) {
  problem(`The callback URL must use https. Got ${CALLBACK_URL}`);
}
if (DO_WEBHOOK && !VERIFY_TOKEN) {
  problem('META_VERIFY_TOKEN is not set. Meta needs a token to echo back during verification.');
}
if (DO_WEBHOOK && /:\/\//.test(VERIFY_TOKEN)) {
  problem(
    `META_VERIFY_TOKEN looks like a URL ("${VERIFY_TOKEN.slice(0, 30)}…"). ` +
      'It must be a random string you invent, not an address. This is the exact mistake that makes Meta say ' +
      '"The callback URL or verify token couldn\'t be validated".',
  );
}
if (DO_WEBHOOK && VERIFY_TOKEN && VERIFY_TOKEN.length < 16) {
  problem('META_VERIFY_TOKEN is short. Use at least 32 random characters.');
}
if (DO_TEMPLATE && !WABA_ID) {
  problem('WABA_ID is not set. Run `npm run discover-ids` to find the WhatsApp Business Account ID.');
}
if (DO_TEMPLATE && !BASE_URL) {
  problem('PUBLIC_BASE_URL is not set, so the template button URL cannot be built.');
}
if (DO_TEMPLATE) {
  const bodyVars = (BODY_TEXT.match(/\{\{\d+\}\}/g) || []).length;
  if (bodyVars !== 1) problem(`The template body must contain exactly one variable {{1}}. Found ${bodyVars}.`);
  if (!BUTTON_URL.endsWith('{{1}}')) problem('The button URL must end with {{1}} — Meta only allows the variable at the very end.');
  if (BUTTON_TEXT.length > 25) problem(`The button text is ${BUTTON_TEXT.length} characters; Meta allows 25.`);
}

if (problems.length) {
  note('');
  for (const item of problems) note(`  ${red('✗')} ${item}`);
  note(`\n${red('Fix these and run again.')}\n`);
  process.exit(1);
}
note(`\n  ${green('✓')} configuration looks valid`);

// --- Graph helpers --------------------------------------------------------
async function graph(method, path, { query = {}, form = null, json = null } = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const init = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  if (json) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`could not reach graph.facebook.com: ${error.message}`);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, data, url: url.origin + url.pathname };
}

function explainFailure(data) {
  const error = data?.error ?? {};
  const hints = {
    100: 'A parameter is wrong or a permission is missing. Check the IDs — the App ID, WABA ID and Phone Number ID are three different values.',
    190: 'The token is invalid or expired. Generate a System User token in Business settings.',
    200: 'The token is missing a permission. You need whatsapp_business_management for templates.',
    368: 'The account is temporarily blocked for a policy reason.',
  };
  const hint = hints[error.code];
  return hint ? `\n    ${yellow('hint:')} ${hint}` : '';
}

// --- Step 1: read the current subscription --------------------------------
async function readSubscription() {
  heading('Current webhook subscription');
  const result = await graph('GET', `${APP_ID}/subscriptions`);
  if (!result.ok) {
    note(`  ${red('✗')} HTTP ${result.status}: ${result.data?.error?.message ?? 'unknown error'}${explainFailure(result.data)}`);
    return null;
  }
  const list = result.data?.data ?? [];
  if (list.length === 0) {
    note(`  ${dim('nothing subscribed yet')}`);
    return null;
  }
  for (const entry of list) {
    note(`  object: ${bold(entry.object)}`);
    note(`    callback: ${entry.callback_url ?? dim('(none)')}`);
    note(`    active:   ${entry.active === false ? red('false') : green('true')}`);
    note(`    fields:   ${(entry.fields ?? []).join(', ') || dim('(none)')}`);
    if (entry.object === 'whatsapp_business_account') {
      const fields = entry.fields ?? [];
      if (!fields.includes('messages')) {
        note(`    ${yellow('!')} "messages" is not subscribed — you will get no inbound messages and no delivery statuses.`);
      }
      if (entry.callback_url && CALLBACK_URL && entry.callback_url !== CALLBACK_URL) {
        note(`    ${yellow('!')} callback differs from PUBLIC_BASE_URL/webhook (${CALLBACK_URL})`);
      }
    }
  }
  return list;
}

// --- Step 2: register the webhook -----------------------------------------
async function registerWebhook() {
  heading(APPLY ? 'Registering webhook' : 'Would register webhook (dry run)');

  const form = {
    object: 'whatsapp_business_account',
    callback_url: CALLBACK_URL,
    verify_token: VERIFY_TOKEN,
    fields: 'messages',
  };

  note(`  ${dim('POST')} ${BASE}/${APP_ID}/subscriptions`);
  for (const [key, value] of Object.entries(form)) {
    note(`    ${key.padEnd(14)}${key === 'verify_token' ? dim('(hidden)') : value}`);
  }

  if (!APPLY) {
    note(`\n  ${yellow('Dry run — nothing sent.')} Add ${bold('--apply')} to perform it.`);
    return;
  }

  // An app access token is the usual credential for app-level subscriptions.
  const subscriptionToken = APP_SECRET ? `${APP_ID}|${APP_SECRET}` : TOKEN;
  if (APP_SECRET) note(`  ${dim('using an app access token (APP_ID|META_APP_SECRET) for this call')}`);

  const url = new URL(`${BASE}/${APP_ID}/subscriptions`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${subscriptionToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }

  if (!response.ok) {
    note(`  ${red('✗')} HTTP ${response.status}: ${data?.error?.message ?? 'unknown error'}${explainFailure(data)}`);
    note(
      `\n  Meta verifies the callback URL immediately by calling it. If it could not reach your service,\n` +
        `  check that ${CALLBACK_URL} responds. Open this in a browser first:\n` +
        `  ${CALLBACK_URL}?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=12345\n`,
    );
    process.exitCode = 1;
    return;
  }
  note(`  ${green('✓')} subscription saved: ${JSON.stringify(data).slice(0, 200)}`);
  await readSubscription();
}

// --- Step 3: create the message template ----------------------------------
function buildTemplate() {
  return {
    name: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    components: [
      {
        type: 'BODY',
        text: BODY_TEXT,
        example: { body_text: [['Tue 3 Nov 2026']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: BUTTON_TEXT,
            url: BUTTON_URL,
            example: [`${BASE_URL}/p/${SAMPLE_PACK_ID}`],
          },
        ],
      },
    ],
  };
}

async function createTemplate() {
  heading(APPLY ? 'Creating message template' : 'Would create message template (dry run)');

  const payload = buildTemplate();
  note(`  ${dim('POST')} ${BASE}/${WABA_ID}/message_templates`);
  note(`${JSON.stringify(payload, null, 2).split('\n').map((line) => `  ${line}`).join('\n')}`);

  if (!APPLY) {
    note(`\n  ${yellow('Dry run — nothing sent.')} Add ${bold('--apply')} to submit it for review.`);
    note(`  ${dim('Meta reviews submitted templates; expect status PENDING, then APPROVED or REJECTED.')}`);
    return;
  }

  const result = await graph('POST', `${WABA_ID}/message_templates`, { json: payload });
  if (!result.ok) {
    note(`  ${red('✗')} HTTP ${result.status}: ${result.data?.error?.message ?? 'unknown error'}${explainFailure(result.data)}`);
    if (result.data?.error?.error_data?.details) {
      note(`    details: ${JSON.stringify(result.data.error.error_data.details)}`);
    }
    process.exitCode = 1;
    return;
  }

  const id = result.data?.id;
  const status = result.data?.status;
  note(`  ${green('✓')} submitted — template id ${id}, status ${bold(status ?? 'unknown')}`);
  if (status && status !== 'APPROVED') {
    note(
      `\n  ${yellow('Not approved yet.')} Meta reviews templates manually. Check status in WhatsApp Manager →\n` +
        `  Message templates. Until it is APPROVED, sends fail with error 132001.`,
    );
  }
}

// --- main -----------------------------------------------------------------
heading('Plan');
note(`  ${CHECK_ONLY ? 'check only' : [DO_WEBHOOK ? 'webhook' : null, DO_TEMPLATE ? 'template' : null].filter(Boolean).join(' + ')}` +
  `  ${APPLY ? red('(APPLY — will write)') : dim('(dry run)')}`);

if (CHECK_ONLY) {
  if (!APP_ID) die('APP_ID is required to read subscriptions.');
  await readSubscription();
} else {
  if (DO_WEBHOOK) {
    // A dry run must not touch the network at all.
    if (APPLY) await readSubscription();
    else note(`\n  ${dim('(dry run: skipping the live subscription read)')}`);
    await registerWebhook();
  }
  if (DO_TEMPLATE) await createTemplate();
}

heading('What this script cannot do');
note('  These have no API and must be done by hand:');
note(`  ${dim('·')} generate a System User access token  → Business settings → Users → System users`);
note(`  ${dim('·')} add a payment method               → WhatsApp Manager → Payment settings`);
note(`  ${dim('·')} publish the app, verify the business, approve the template`);
note('');
