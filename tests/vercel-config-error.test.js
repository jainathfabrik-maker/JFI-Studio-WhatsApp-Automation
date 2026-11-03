/**
 * When configuration is invalid, the Vercel entry point must still export a
 * handler and answer with a readable 500. A module that throws leaves Vercel
 * reporting an opaque "Node.js process exited with exit status: 1", which is
 * exactly the failure this entry point exists to replace.
 *
 * This lives in its own file because api/index.js validates at module load, so
 * the environment must be broken before the import and cannot be repaired
 * afterwards in the same process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

Object.assign(process.env, {
  NODE_ENV: 'test',
  VERCEL: '1',
  VERCEL_URL: 'broken-example.vercel.app',
  LOG_LEVEL: 'silent',
  // Deliberately missing META_ACCESS_TOKEN, META_APP_SECRET,
  // META_VERIFY_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_RECIPIENT_NUMBER.
});

const { default: handler } = await import('../api/index.js');

const server = await new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();

test.after(() => new Promise((resolve) => server.close(resolve)));

function get(requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${requestPath}`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('a misconfigured deployment still exports a handler', () => {
  assert.equal(typeof handler, 'function');
});

test('it answers 500 with the offending variable names', async () => {
  const response = await get('/health');
  assert.equal(response.status, 500);
  assert.equal(response.json.ok, false);
  assert.match(response.json.error, /Configuration is invalid/i);
  assert.ok(Array.isArray(response.json.problems));
  assert.ok(response.json.problems.length >= 5, 'every missing variable should be listed');

  const joined = response.json.problems.join('\n');
  for (const key of ['META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_RECIPIENT_NUMBER']) {
    assert.match(joined, new RegExp(key), `${key} should be named`);
  }
});

test('the response names variables but never leaks a value', async () => {
  const response = await get('/health');
  // Nothing value-shaped should appear: no token, no long digit run.
  assert.ok(!/EAA[A-Za-z0-9_-]{20,}/.test(response.text));
  assert.ok(!/sk-[A-Za-z0-9_-]{20,}/.test(response.text));
  assert.equal(response.json.hint.includes('Environment Variables'), true);
});
