#!/usr/bin/env node
/**
 * Discover the WhatsApp identifiers this account actually has, and tell you
 * which environment variable each one belongs in.
 *
 * Usage (never paste the token into a chat or a commit):
 *
 *   GRAPH_TOKEN=EAA... node scripts/discover-ids.js
 *   GRAPH_TOKEN=EAA... node scripts/discover-ids.js --json
 *
 * Reads the token from the environment only. It is never printed, never
 * written to disk, and never included in an error message.
 *
 * What it resolves:
 *   - who/what the token belongs to, and when it expires
 *   - the granted scopes (you need the two whatsapp_business_* ones)
 *   - App ID, WhatsApp Business Account IDs, Phone Number IDs
 *
 * Official docs:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers
 *   https://developers.facebook.com/docs/facebook-login/guides/access-tokens/debugging
 */

const VERSION = process.env.META_GRAPH_API_VERSION || 'v26.0';
const BASE = `https://graph.facebook.com/${VERSION}`;
const TOKEN = process.env.GRAPH_TOKEN || process.env.META_ACCESS_TOKEN || '';
const asJson = process.argv.includes('--json');

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Fail with a readable message instead of a stack trace, whatever breaks.
process.on('uncaughtException', (error) => die(`Unexpected error: ${error.message}`));
process.on('unhandledRejection', (reason) =>
  die(`Unexpected error: ${reason instanceof Error ? reason.message : String(reason)}`),
);

if (typeof fetch !== 'function') {
  die(`This script needs global fetch.\n\nNode ${process.version} does not provide it. Use Node 18 or newer (22 LTS recommended).`);
}

if (!TOKEN) {
  process.stderr.write(
    'No token found.\n\n' +
      'Pass it in the environment, never as an argument (arguments end up in shell history):\n' +
      '  GRAPH_TOKEN=EAA... node scripts/discover-ids.js\n\n' +
      'Use a System User token from Business settings, not a Graph API Explorer token.\n',
  );
  process.exit(1);
}

async function graph(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(
      `could not reach graph.facebook.com (${error.message}). Check the network, a proxy, or that this machine can make outbound HTTPS calls.`,
    );
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!response.ok) {
    const error = data.error ?? {};
    const detail = error.message ? ` (code ${error.code}): ${error.message}` : `HTTP ${response.status}`;
    throw new Error(`GET /${path} failed${detail}`);
  }
  return data;
}

/** Best effort: try the call, return null instead of throwing. */
async function tryGraph(path, params = {}) {
  try {
    return await graph(path, params);
  } catch (error) {
    return { __error: error.message };
  }
}

function fmtExpiry(expiresAt) {
  if (expiresAt === 0) return 'never (this is a System User token — correct for a scheduled job)';
  if (!expiresAt) return 'unknown';
  const when = new Date(expiresAt * 1000);
  const days = Math.round((when.getTime() - Date.now()) / 86_400_000);
  const suffix = days <= 0 ? 'ALREADY EXPIRED' : `${days} day(s) left`;
  return `${when.toISOString()} — ${suffix}`;
}

const out = {
  graphVersion: VERSION,
  identity: null,
  token: null,
  businesses: [],
  warnings: [],
};

try {
  const me = await graph('me', { fields: 'id,name' });
  out.identity = me;

  const debug = await tryGraph('debug_token', { input_token: TOKEN });
  if (debug.__error) {
    out.token = { note: `could not inspect the token: ${debug.__error}` };
  } else {
    const info = debug.data ?? {};
    out.token = {
      type: info.type,
      appId: info.app_id,
      isValid: info.is_valid,
      expiresAt: info.expires_at,
      expiresAtHuman: fmtExpiry(info.expires_at),
      scopes: info.scopes,
      granularScopes: (info.granular_scopes ?? []).map((entry) => entry.scope),
    };
  }

  // Walk businesses -> WhatsApp Business Accounts -> phone numbers.
  const businesses = await tryGraph('me/businesses', { fields: 'id,name', limit: '50' });
  if (businesses.__error) {
    out.warnings.push(`Could not list businesses: ${businesses.__error}`);
  }

  for (const business of businesses.data ?? []) {
    const record = { businessId: business.id, businessName: business.name, wabas: [] };
    const wabas = await tryGraph(`${business.id}/owned_whatsapp_business_accounts`, {
      fields: 'id,name',
      limit: '50',
    });
    if (wabas.__error) {
      record.error = wabas.__error;
    }
    for (const waba of wabas.data ?? []) {
      const wabaRecord = { wabaId: waba.id, wabaName: waba.name, phoneNumbers: [] };
      const numbers = await tryGraph(`${waba.id}/phone_numbers`, {
        fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status',
        limit: '50',
      });
      if (numbers.__error) wabaRecord.error = numbers.__error;
      for (const number of numbers.data ?? []) {
        wabaRecord.phoneNumbers.push({
          phoneNumberId: number.id,
          displayPhoneNumber: number.display_phone_number,
          verifiedName: number.verified_name,
          qualityRating: number.quality_rating,
          platformType: number.platform_type,
        });
      }
      record.wabas.push(wabaRecord);
    }
    out.businesses.push(record);
  }
} catch (error) {
  out.warnings.push(`Fatal: ${error.message}`);
}

// --- Interpret ------------------------------------------------------------
const phoneNumbers = out.businesses.flatMap((b) => b.wabas.flatMap((w) => w.phoneNumbers));
const wabas = out.businesses.flatMap((b) => b.wabas);

if (out.token?.expiresAt !== undefined && out.token.expiresAt !== 0) {
  out.warnings.push(
    'This token expires. A daily scheduled job needs a System User token (expires_at = 0). ' +
      'Generate one in Business settings → Users → System users → Generate token.',
  );
}
const scopes = out.token?.scopes ?? out.token?.granularScopes ?? [];
if (scopes.length) {
  for (const needed of ['whatsapp_business_messaging', 'whatsapp_business_management']) {
    if (!scopes.includes(needed)) out.warnings.push(`Token is missing the "${needed}" scope.`);
  }
}
if (phoneNumbers.length === 0 && out.warnings.length === 0) {
  out.warnings.push(
    'No phone numbers found. Either the token cannot see the business, or the number is not yet ' +
      'registered to the WhatsApp Business Account. Read the Phone Number ID from WhatsApp Manager → ' +
      'Account tools → Phone numbers.',
  );
}
if (phoneNumbers.length > 1) {
  out.warnings.push('More than one phone number found — use the one you actually send from.');
}

// --- Report ---------------------------------------------------------------
if (asJson) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(phoneNumbers.length ? 0 : 1);
}

const line = (label, value) => process.stdout.write(`  ${label.padEnd(30)}${value ?? '—'}\n`);

process.stdout.write(`\nGraph API ${VERSION}\n`);
process.stdout.write(`\n${'='.repeat(64)}\nToken\n${'='.repeat(64)}\n`);
line('Belongs to', out.identity?.name ?? '—');
line('Token type', out.token?.type ?? '—');
line('App ID', out.token?.appId ?? '—');
line('Valid', out.token?.isValid === undefined ? '—' : String(out.token.isValid));
line('Expires', out.token?.expiresAtHuman ?? '—');
line('Scopes', (out.token?.scopes ?? []).join(', ') || '—');

process.stdout.write(`\n${'='.repeat(64)}\nWhatsApp Business Accounts\n${'='.repeat(64)}\n`);
if (wabas.length === 0) process.stdout.write('  none visible to this token\n');
for (const waba of wabas) {
  line('WABA name', waba.wabaName ?? '—');
  line('WABA ID', waba.wabaId);
  if (waba.error) line('error', waba.error);
}

process.stdout.write(`\n${'='.repeat(64)}\nPhone numbers\n${'='.repeat(64)}\n`);
if (phoneNumbers.length === 0) process.stdout.write('  none visible to this token\n');
for (const number of phoneNumbers) {
  line('Display number', number.displayPhoneNumber);
  line('Verified name', number.verifiedName);
  line('PHONE NUMBER ID', number.phoneNumberId);
  line('Quality rating', number.qualityRating ?? '—');
  line('Platform', number.platformType ?? '—');
  process.stdout.write('\n');
}

process.stdout.write(`${'='.repeat(64)}\nPut these in Render → Environment\n${'='.repeat(64)}\n`);
line('META_ACCESS_TOKEN', 'the token you passed in (System User token, not a user token)');
line('WHATSAPP_PHONE_NUMBER_ID', phoneNumbers[0]?.phoneNumberId ?? 'NOT FOUND');
line('WHATSAPP_BUSINESS_ACCOUNT_ID', wabas[0]?.wabaId ?? 'NOT FOUND');
line('META_APP_SECRET', 'App settings → Basic (not available from the API)');
line('WHATSAPP_RECIPIENT_NUMBER', 'a DIFFERENT number you control, digits only');
line('WHATSAPP_SENDER_NUMBER', phoneNumbers[0]?.displayPhoneNumber?.replace(/\D/g, '') ?? 'NOT FOUND');

if (out.warnings.length) {
  process.stdout.write(`\n${'='.repeat(64)}\nWarnings\n${'='.repeat(64)}\n`);
  for (const warning of out.warnings) process.stdout.write(`  ! ${warning}\n`);
}
process.stdout.write('\n');
process.exit(phoneNumbers.length ? 0 : 1);
