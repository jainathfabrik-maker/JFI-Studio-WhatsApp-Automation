#!/usr/bin/env node
/**
 * Structural checks on render.yaml, run in CI and before a deploy.
 *
 * There is no YAML parser dependency here on purpose: this validates the
 * specific things that break a Render deploy or leak a secret, which is a
 * smaller and more honest job than pretending to be a full YAML validator.
 *
 * Exits 1 with a list of problems, 0 when the file is safe to deploy.
 */
import fs from 'node:fs';

const FILE = process.argv[2] ?? 'render.yaml';
const problems = [];

let raw;
try {
  raw = fs.readFileSync(FILE, 'utf8');
} catch (error) {
  console.error(`✗ cannot read ${FILE}: ${error.message}`);
  process.exit(1);
}

// Comments are documentation, not configuration — check only live lines.
const content = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

// --- 1. No secrets -------------------------------------------------------
if (/EAA[A-Za-z0-9_-]{20,}/.test(content)) problems.push('a Meta token-shaped value (EAA…) appears in the file');
if (/sk-[A-Za-z0-9_-]{20,}/.test(content)) problems.push('an OpenAI key-shaped value (sk-…) appears in the file');
if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(content)) problems.push('a private key block appears in the file');
if (/app_secret\s*[:=]\s*\S/i.test(content)) problems.push('an app secret value appears in the file');

// --- 2. Required service shape ------------------------------------------
for (const needle of [
  'type: web',
  'runtime: node',
  'buildCommand:',
  'startCommand:',
  'healthCheckPath: /health',
  'autoDeploy: true',
]) {
  if (!content.includes(needle)) problems.push(`missing "${needle}"`);
}

if (!/buildCommand:\s*npm (ci|install)/.test(content)) {
  problems.push('buildCommand should run npm ci or npm install');
}
if (!/startCommand:\s*npm start|startCommand:\s*node server\.js/.test(content)) {
  problems.push('startCommand should be "npm start" or "node server.js"');
}

// --- 3. YAML hygiene -----------------------------------------------------
if (/\t/.test(content)) problems.push('the file contains a tab; YAML requires spaces');

// --- 4. sync:false blocks must not also carry a value -------------------
const blocks = content.split(/\n(?=\s*- key: )/);
for (const block of blocks) {
  const key = block.match(/- key:\s*(\S+)/)?.[1];
  if (!key) continue;
  if (/sync:\s*false/.test(block) && /^\s*value:/m.test(block)) {
    problems.push(`${key} is marked sync:false but also sets a value — Render will not prompt for it`);
  }
  if (!/sync:\s*false/.test(block) && !/^\s*value:/m.test(block) && !/fromService|fromDatabase|generateValue/.test(block)) {
    problems.push(`${key} has neither a value nor sync:false`);
  }
}

// --- 5. Every secret the app needs must be declared ---------------------
const requiredSecrets = [
  'META_ACCESS_TOKEN',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_RECIPIENT_NUMBER',
  'PUBLIC_BASE_URL',
  'ADMIN_TRIGGER_TOKEN',
];
for (const key of requiredSecrets) {
  if (!content.includes(`key: ${key}`)) problems.push(`does not declare required variable ${key}`);
}

// --- 6. No absolute secret-looking paths --------------------------------
if (/DATA_DIR[\s\S]{0,80}value:\s*\/var\/data/.test(content) && !content.includes('mountPath: /var/data')) {
  problems.push('DATA_DIR points at /var/data but no disk is mounted there');
}

if (problems.length) {
  console.error(`✗ ${FILE} is not safe to deploy:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ ${FILE} passed: no secrets, correct service shape, all required variables declared.`);
