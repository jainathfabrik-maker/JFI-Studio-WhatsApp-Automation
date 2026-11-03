# Checklist

Everything in this repository was built and verified locally in a sandbox.
Nothing was deployed, no Meta webhook was verified, and no WhatsApp message was
delivered — those need your accounts and credentials.

---

## Complete

- [x] Audited the repository and both ZIP archives; documented every defect in
      [AUDIT.md](AUDIT.md).
- [x] Rewrote the application as a production-ready Node.js service.
- [x] Webhook subscription handshake (GET) with constant-time token comparison.
- [x] Webhook signature verification (HMAC-SHA256 over the raw body,
      constant-time compare) on every POST.
- [x] Prompt acknowledgement: the handler does only in-memory work, then
      returns 200.
- [x] Webhook event deduplication, 24-hour replay window.
- [x] Outbound messaging against `POST /{version}/{phone-number-id}/messages`
      with the supported template and text payloads.
- [x] Correct separation of Phone Number ID, WABA ID and App ID, with a
      validation message that names the mistake.
- [x] Recipient configurable by environment variable, normalised to digits.
- [x] Self-send guard: refused at startup when the numbers are declared equal,
      and blocked at delivery when Meta reports the recipient *is* the business
      number.
- [x] Explicit explanation of why self-messaging is not supported.
- [x] Token expiry, rate limits, timeouts and network failures handled, with
      Meta error codes mapped to plain-language hints.
- [x] Bounded retries with exponential back-off, honouring `Retry-After`.
- [x] Structured JSON logging with secret redaction and phone masking.
- [x] `GET /health` for Render.
- [x] `GET /status`, `GET /admin/diagnostics`.
- [x] Graceful shutdown on SIGTERM/SIGINT with a forced-exit backstop.
- [x] Startup validation of every variable, reporting all problems at once,
      naming variables only — never values.
- [x] Daily content pack with all eight required elements — format and duration,
      pillar, first-frame hook, video/post concept, shot list with on-screen text,
      caption with hashtags, call to action, publishing time and tracking
      metadata. The brief is enforced in code (hook length, number-or-place,
      banned words, hashtag/shot/on-screen counts, UTM slug, IST time), not just
      asked for in the prompt.
- [x] Daily schedule at 08:30 Asia/Kolkata via `.github/workflows/daily.yml`
      (free), with a paid Render cron job or the in-process timer as
      alternatives.
- [x] Idempotent per calendar day: a restart, a second instance or a duplicate
      scheduler hit cannot send twice.
- [x] OpenAI key only through environment variables; no hardcoded secrets.
- [x] Generation failure logs, marks the pack failed, and sends nothing.
- [x] Source tree at the repository root, deployable without a ZIP.
- [x] `package.json`, `package-lock.json`, `render.yaml`, `.env.example`,
      `.gitignore`, `README.md`, `src/`, `scripts/`, `tests/`, `docs/`.
- [x] `.gitignore` excludes `.env`, `.env.*`, key material, logs and runtime data.
- [x] `render.yaml` contains no secret values (`sync: false` for every secret).
- [x] `META_APP_ID`, `META_API_VERSION` and `DAILY_SCHEDULE` supported as
      requested, with the earlier names kept as aliases and a startup warning so
      they can be renamed.
- [x] Rate limiting / abuse protection on the webhook and admin surfaces.
- [x] Data retention, consent, opt-out and WhatsApp policy documented
      ([POLICY.md](POLICY.md)).
- [x] 102 automated tests: webhook verification, signature validation, sending,
      invalid configuration, error handling, dedupe, run guard, timezone and
      DST boundaries, rate limiting, 24-hour window, the eight pack items, every
      route.
- [x] All 102 tests pass locally, and **CI passes on GitHub's runners for both
      Node 22 and Node 24** (verified from the Actions API, not assumed).
- [x] `Dockerfile` included, so the app runs on any container host if Render
      stops suiting.
- [x] `npm audit` reports **0 vulnerabilities**; `node-cron` upgraded to v4
      (no dependencies) to clear the transitive `uuid` advisory.
- [x] Secret scan: no credential-shaped strings and no `.env` file in the tree.
- [x] Live boot smoke test: server starts, `/health`, `/status`, webhook
      handshake, signature rejection, admin auth, and a real outbound attempt
      that failed honestly instead of reporting success.
- [x] README rewritten for a beginner: exact deploy steps, variable table, Meta
      setup, troubleshooting, known limits.
- [x] Meta webhook and template instructions written out step by step.
- [x] Troubleshooting guide covering every error likely to be hit.
- [x] Clean ZIP backup produced.

---

## Needs your action

These cannot be done from here — they require your Meta and Render accounts, and
in some cases your judgement.

### Meta

- [ ] Make the repository **private** before adding business configuration.
- [ ] Rotate any credential that has ever been committed, pasted into a chat,
      or stored in a ZIP — then put the new value only in Render.
- [ ] Confirm which Meta app and WhatsApp Business Account are the right ones.
- [ ] Generate a **permanent** System User access token → `META_ACCESS_TOKEN`.
- [ ] Copy the app secret → `META_APP_SECRET`.
- [ ] Invent a random `META_VERIFY_TOKEN` (32+ characters).
- [ ] Read the **App ID** → `META_APP_ID` (only `setup-meta.js` needs it).
- [ ] Read the **Phone Number ID** (not the phone number, not the WABA ID) →
      `WHATSAPP_PHONE_NUMBER_ID`.
- [ ] Create and get approval for the template, with a body variable and a
      dynamic URL button `https://<your-service>/p/{{1}}` — see
      [META-WEBHOOK-SETUP.md](META-WEBHOOK-SETUP.md) §5.
- [ ] Choose a **recipient number that is not the sending business number**, and
      make sure it has opted in.
- [ ] Set the webhook callback URL to `https://<your-service>/webhook` and
      subscribe to the `messages` field.
- [ ] Complete business verification, display-name approval and payment setup if
      they are not already done for this account.
- [ ] Add the recipient to the test-number allow-list if you are still on a test
      number.

### Render

- [ ] Connect the repository and apply `render.yaml` (now on the free plan).
- [ ] Enter every `sync: false` variable in the dashboard.
- [ ] Leave `PUBLIC_BASE_URL` blank — the app derives its own URL. Open
      `/setup` on the live service for every value Meta and GitHub need.
- [ ] Set `ADMIN_TRIGGER_TOKEN` (32+ characters).

### GitHub (the free scheduler)

- [ ] Settings → Secrets and variables → Actions → **Variables**: add
      `PUBLIC_BASE_URL`.
- [ ] Settings → Secrets and variables → Actions → **Secrets**: add
      `ADMIN_TRIGGER_TOKEN` with the same value as on Render.
- [ ] Run the *Daily content pack* workflow once by hand to confirm it returns
      200.
- [ ] Optional: attach the persistent disk (commented in `render.yaml`) on a
      paid plan so pack links survive a restart.
- [ ] Deploy and confirm `GET /health` returns `{"ok":true}`.
- [ ] Run `GET /admin/diagnostics` and confirm
      `senderMatchesRecipient: false`.
- [ ] Run `POST /admin/run-daily` once by hand.
- [ ] Confirm the message arrives, then confirm a `delivered` line appears in
      the logs — that is the only proof of delivery.
- [ ] Open the button in the message and confirm the pack page renders.

---

## Deliberately not done

- **No deployment was attempted.** No Render account, no Meta app, no
  credentials — and a claim of deployment that was not performed would be worth
  nothing to you.
- **No webhook was verified against Meta.** The handshake is tested against a
  simulated request; Meta's own verification needs your token.
- **No WhatsApp message was sent.** The outbound path is tested against a fake
  transport and a live attempt that failed honestly.
- **The two obsolete ZIP archives were deleted from the repository** in this
  round, as requested. They remain in the Git history if you ever want them
  back, and a fresh ZIP of the corrected source was delivered separately.
