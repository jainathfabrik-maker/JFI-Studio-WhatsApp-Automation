# Audit of the previous repository

What was there, what was broken, and what changed. Everything below was
confirmed by extracting both ZIP archives and diffing them, not assumed.

---

## What the repository actually contained

```
JFI_Studio_WhatsApp_Automation_Deployment_Ready.zip
JFI_Studio_WhatsApp_Automation_Starter.zip
README.md          (75 bytes: "# JFI-Studio-WhatsApp-Automation ...")
```

No source files at the repository root. **Render cannot build this.** A web
service runs `npm ci` and `npm start` against the repository root; a ZIP is not
a source tree.

The two archives were extracted and compared:

- `server.js` is **byte-identical** in both. "Deployment-ready" was the starter
  plus a `render.yaml`, not a fixed version.
- The starter's `package.json` declares `"send-test": "node send-test.js"` but
  **no `send-test.js` exists** — that script fails with MODULE_NOT_FOUND.
- `package-lock.json` was absent from both.
- Neither archive contained any tests.

So there was no "newer fixed version" to prefer. The code below is a rewrite of
the same intended design, keeping everything that worked.

---

## Bugs that would have stopped it working

### 1. The primary delivery path would have been rejected by Meta

`sendApprovedTemplate()` sent the entire content pack as **one** template body
parameter:

```js
parameters: [{ type: 'text', text: contentPack.slice(0, 900) }]
```

Two problems, both fatal:

- **Template parameters cannot contain newlines or tabs.** The generated pack is
  multi-line, so Meta rejects it (error `132012`).
- **The 1024-character cap is on the parameter, and the 900-character slice was
  a silent truncation** that also cut the shot list off mid-sentence.

There was no way to send a real content pack through that template. This is the
single biggest design flaw, and it is why the corrected version defaults to a
template with a **dynamic URL button** pointing at a hosted pack page.

### 2. The default OpenAI model does not exist any more

`OPENAI_MODEL` defaulted to `gpt-5.4-mini`, which is deprecated. Every
generation would have failed on a 404-style model error.

### 3. `OPENAI_API_KEY` was mandatory

It was in the `required` array, so the service refused to run without OpenAI —
even though the content pipeline can work without it.

### 4. Environment validation was fragile

```js
function missingEnv() {
  return required.filter(k => !process.env[k] || process.env[k].includes('vXX'));
}
```

- Any value containing the substring `vXX` counted as missing. A legitimate
  token containing that sequence would be misreported.
- Nothing checked that the Graph version looked like `v26.0`, that the recipient
  was digits, that the Phone Number ID was numeric, or that the recipient and
  sender differed unless an optional variable happened to be set.
- Validation ran **inside the daily job**, not at startup, so a
  mis-configuration looked like a service that deployed fine and then failed
  silently every morning.

### 5. No timeouts and no retries

`fetch` was called bare. A hung Meta or OpenAI connection would hang the daily
run indefinitely, with no log line explaining why.

### 6. Duplicate sends were possible

`node-cron` ran in-process with **no idempotency guard at all**:

- Restart the service after 08:30 and a manual run plus the timer could both
  fire.
- Scale to two instances and both send.
- On Render's free tier the instance sleeps, so the timer often never fires —
  and nothing noticed.

### 7. Duplicate webhook processing

Signature verification was correct and has been kept. But there was **no
deduplication**: Meta retries a webhook if your 200 is slow, and every retry
re-ran the handler. There was also no protection against a non-JSON body
(verification would HMAC an empty buffer).

### 8. No graceful shutdown

No `SIGTERM` handler. Render sends `SIGTERM` on every deploy and restart; the
process died mid-run, potentially after Meta accepted a message but before the
result was recorded.

### 9. Logging

`console.log` / `console.error` with free-text messages — not filterable in
Render's log viewer, no severity, and no redaction layer to stop a token or a
phone number reaching the log if someone added one later.

### 10. Admin authentication

```js
if (!adminKey || req.get('authorization') !== `Bearer ${adminKey}`) return res.sendStatus(401);
```

A plain `!==` string comparison — not constant-time. Also `err.message` was
returned to the caller, and there was no `/status` or diagnostics endpoint to
debug a deployment without reading logs.

### 11. Variable names drifted from the brief

The code and `.env.example` used `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION` and
`WHATSAPP_RECIPIENT`, while the brief specified `META_ACCESS_TOKEN`,
`META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_API_VERSION` and
`WHATSAPP_RECIPIENT_NUMBER`. The corrected version uses the brief's names as
canonical and still accepts the old ones as aliases, warning at startup so you
can rename them.

### 12. Minor

- `.env.example` shipped `WHATSAPP_GRAPH_VERSION=vXX.X`, a value that produces a
  broken URL if used as-is.
- The starter `.gitignore` did not ignore `.env.*` (the deployment ZIP fixed
  this).
- `app.listen(port)` bound implicitly rather than to `0.0.0.0`.
- No tests, no `/status`, no diagnostics, no way to test sending without
  consuming a real daily run.

---

## What was kept

The parts that were right, preserved deliberately:

- Verifying `x-hub-signature-256` with HMAC-SHA256 over the raw body, compared
  in constant time.
- The GET subscription handshake returning the challenge.
- The content brief itself — the pillars, the 12-word hook rule, the banned
  words, the "never invent results, testimonials or prices" instruction. All of
  it is now *enforced in code* rather than only asked for in the prompt.
- Asia/Kolkata as the timezone and 08:30 as the delivery time.
- The self-send guard, now backed by an actual lookup of the business number
  from Meta instead of an optional environment variable.
- The honest README posture: this never claims a delivery it cannot prove.

---

## What the rewrite adds

Startup validation with actionable messages · structured redacting logs ·
timeout and bounded backoff on every outbound call · Meta error codes mapped to
plain-language hints · webhook deduplication · a per-day idempotent run lock ·
graceful shutdown · a private mobile pack page · a safe test path with a dry
run · `/status` and `/admin/diagnostics` · 79 automated tests · a `link`
delivery mode that actually works outside the 24-hour window.
