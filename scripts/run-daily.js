#!/usr/bin/env node
/**
 * Trigger today's content pack from a Render Cron Job.
 *
 * Render cron schedules are UTC, so 08:30 IST is 03:00 UTC:
 *   schedule: 0 3 * * *
 *
 * Calls POST {PUBLIC_BASE_URL}/admin/run-daily and exits non-zero on failure,
 * so Render marks the run as failed instead of silently doing nothing.
 * All the work happens in the web service, which owns the pack store.
 */
import 'dotenv/config';

const baseUrl = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
const token = process.env.ADMIN_TRIGGER_TOKEN ?? '';
const attempts = Number.parseInt(process.env.RUN_DAILY_ATTEMPTS ?? '4', 10);

function fail(message, hint) {
  process.stderr.write(`run-daily failed: ${message}\n`);
  if (hint) process.stderr.write(`hint: ${hint}\n`);
  process.exit(1);
}

if (!baseUrl) fail('PUBLIC_BASE_URL is not set', 'Set it to your Render service URL, e.g. https://your-service.onrender.com');
if (!token) fail('ADMIN_TRIGGER_TOKEN is not set', 'Set the same value on the cron job and the web service');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(`${baseUrl}/admin/run-daily`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 400) };
    }

    if (response.ok) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      if (payload.skipped) process.stdout.write(`Skipped: ${payload.reason}\n`);
      process.exit(0);
    }

    // 401/403/404 will not improve on retry.
    if ([401, 403, 404].includes(response.status)) {
      fail(`HTTP ${response.status}: ${payload.error ?? text.slice(0, 200)}`, 'Check ADMIN_TRIGGER_TOKEN and PUBLIC_BASE_URL match the web service.');
    }

    process.stderr.write(`attempt ${attempt}/${attempts} got HTTP ${response.status}: ${payload.error ?? ''}\n`);
  } catch (error) {
    process.stderr.write(`attempt ${attempt}/${attempts} error: ${error.message}\n`);
  }

  if (attempt < attempts) await sleep(5000 * attempt);
}

fail(`gave up after ${attempts} attempts`, 'The web service may be down or still cold-starting. Check its logs in Render.');
