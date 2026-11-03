import { escapeHtml } from './util.js';

const STYLE = `
  :root { --ink:#1b1a17; --muted:#6b675f; --line:#e4e0d7; --paper:#faf8f4; --accent:#8a6a3b; --ok:#2f6b3f; --warn:#8a5a1b; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px 64px; background:var(--paper); color:var(--ink);
    font:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .wrap { max-width:760px; margin:0 auto; }
  header { border-bottom:2px solid var(--ink); padding-bottom:14px; margin-bottom:22px; }
  .brand { font-size:12px; letter-spacing:.18em; text-transform:uppercase; color:var(--accent); font-weight:700; }
  h1 { font-size:24px; line-height:1.25; margin:8px 0 6px; }
  h2 { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin:0 0 10px; font-weight:700; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px 16px 18px; margin-bottom:14px; }
  .row { display:flex; gap:10px; align-items:flex-start; padding:9px 0; border-top:1px solid var(--line); }
  .row:first-of-type { border-top:none; padding-top:0; }
  .label { flex:0 0 132px; color:var(--muted); font-size:13px; }
  .val { flex:1; min-width:0; }
  code { display:block; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;
    background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:7px 9px;
    overflow-wrap:anywhere; }
  button { margin-top:6px; font:inherit; font-size:12px; padding:4px 10px; cursor:pointer;
    background:var(--paper); color:var(--accent); border:1px solid var(--line); border-radius:999px; }
  button:active { background:var(--line); }
  .ok { color:var(--ok); font-weight:600; }
  .warn { color:var(--warn); font-weight:600; }
  .note { color:var(--muted); font-size:13px; margin-top:8px; }
  ol { margin:0; padding-left:20px; }
  li { margin:5px 0; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#f2efe9; --muted:#a39e94; --line:#33312c; --paper:#16150f; --accent:#d8b483; --ok:#8fce9f; --warn:#e0b072; }
    body { background:var(--paper); } .card { background:#1e1d17; }
  }
`;

/**
 * A setup sheet for the operator: everything Meta and GitHub need, computed
 * from the URL this request actually arrived on. No secrets are rendered here —
 * the verify token is referenced, never printed.
 */
export function renderSetupPage({ baseUrl, baseUrlSource, config, hasVerifyToken, deliveryBlockedReason }) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const known = Boolean(base);
  const row = (label, value, copyable = true) => `
      <div class="row">
        <div class="label">${escapeHtml(label)}</div>
        <div class="val">
          <code>${escapeHtml(value)}</code>
          ${copyable ? `<button data-copy="${escapeHtml(value)}">Copy</button>` : ''}
        </div>
      </div>`;

  const sourceLabel = {
    PUBLIC_BASE_URL: 'from PUBLIC_BASE_URL',
    RENDER_EXTERNAL_URL: 'auto-detected from Render',
    request: 'from the address of this request',
    unresolved: 'could not be determined',
  }[baseUrlSource] ?? baseUrlSource;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>JFI Studio — setup values</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">JFI Studio · Bengaluru</div>
      <h1>Setup values</h1>
      <div class="note">Everything below is derived from the address this page was opened on (${escapeHtml(sourceLabel)}).
      No secret is shown here.</div>
    </header>

    <section class="card">
      <h2>Public URL</h2>
      ${known ? row('Base URL', base) : '<p class="warn">Could not determine a public URL.</p>'}
      <div class="note">${escapeHtml(sourceLabel)}${known ? '' : ' — open this page through your deployed HTTPS URL.'}</div>
    </section>

    ${deliveryBlockedReason ? `<section class="card"><h2>Delivery is blocked</h2><p class="warn">${escapeHtml(deliveryBlockedReason)}</p></section>` : ''}

    <section class="card">
      <h2>1 · Meta → WhatsApp → Configuration → Webhook</h2>
      ${row('Callback URL', known ? `${base}/webhook` : 'https://<your-url>/webhook')}
      <div class="note">Verify token: the value of <code style="display:inline;padding:1px 5px">META_VERIFY_TOKEN</code>
      from your environment — ${hasVerifyToken ? '<span class="ok">it is set</span>' : '<span class="warn">it is NOT set</span>'}.
      It is never displayed on this page.</div>
      <div class="note">Turn <strong>Attach a client certificate to Webhook requests</strong> OFF.</div>
      <div class="note">Then subscribe to the <strong>messages</strong> field.</div>
    </section>

    <section class="card">
      <h2>2 · WhatsApp Manager → Message templates → Create</h2>
      ${row('Name', config.templateName)}
      ${row('Language', config.templateLanguage)}
      ${row('Category', 'Marketing')}
      ${row('Body (one line)', 'Your JFI Studio content pack for {{1}} is ready. Tap the button to open it.')}
      ${row('Button type', 'URL · Dynamic')}
      ${row('Button text', 'Open pack')}
      ${row('Button URL', known ? `${base}/p/{{1}}` : 'https://<your-url>/p/{{1}}')}
      ${row('Sample body value', 'Tue 3 Nov 2026')}
      ${row('Sample URL value', known ? `${base}/p/Zx8Kq2LmN4pR7sT1vW3y` : 'https://<your-url>/p/Zx8Kq2LmN4pR7sT1vW3y')}
      <div class="note">The {{1}} must be at the very end of the URL. The template carries a link because Meta
      rejects newlines inside template parameters and caps them at 1024 characters.</div>
    </section>

    <section class="card">
      <h2>3 · GitHub → Settings → Secrets and variables → Actions</h2>
      ${row('Variable PUBLIC_BASE_URL', known ? base : 'https://<your-url>')}
      <div class="note">Secret <strong>ADMIN_TRIGGER_TOKEN</strong>: the same value as in Render. This is the one
      URL that still has to be entered by hand, because GitHub has no way to know your Render address.</div>
    </section>

    <section class="card">
      <h2>4 · Then test</h2>
      <ol>
        <li>Open <code style="display:inline;padding:1px 5px">${escapeHtml(known ? `${base}/status` : '/status')}</code> — <em>deliveryBlocked</em> should be false.</li>
        <li>POST to <code style="display:inline;padding:1px 5px">/admin/run-daily</code> with
        <code style="display:inline;padding:1px 5px">Authorization: Bearer &lt;ADMIN_TRIGGER_TOKEN&gt;</code>.</li>
        <li>A message id in the response means Meta accepted it. Delivery is confirmed later by the status webhook.</li>
      </ol>
    </section>
  </div>
<script>
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-copy]');
    if (!button) return;
    var value = button.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = 'Copy'; }, 1500);
      }).catch(function () { button.textContent = 'Select manually'; });
    } else {
      button.textContent = 'Select manually';
    }
  });
</script>
</body>
</html>`;
}
