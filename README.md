# JFI Studio — WhatsApp Content Automation

Delivers JFI Studio's daily marketing content pack through the Meta WhatsApp
Cloud API, and serves the full pack on a private web page for one-tap reading
on a phone.

Built for **Render** (Web Service + optional Cron Job), Node.js 22 LTS, Graph
API **v26.0**.

> **Status:** the application code is written, tested and verified locally.
> Nothing has been deployed, no Meta webhook has been verified and no WhatsApp
> message has been delivered — those steps need your Meta and Render accounts.
> See [docs/CHECKLIST.md](docs/CHECKLIST.md) for exactly what is done and what
> still needs you.

---

## What it does, in one paragraph

Every morning at 08:30 IST a job generates one content pack — format and
duration, content pillar, a first-frame hook of at most 12 words containing a
number or a Bengaluru place name, the video or post concept, a shot list with
on-screen text, a ready-to-publish caption with hashtags, a call to action, a
suggested publishing time in IST, and a tracking metric with a UTM campaign
slug. The pack is saved, published
at a private link, and a short approved WhatsApp template is sent to your
recipient number with a button that opens the full pack. If generation or
sending fails, the run fails loudly and **nothing** is sent — the service never
reports a delivery it cannot prove.

---

## The one thing that shapes the whole design

**Meta does not allow newlines, tabs or leading/trailing spaces inside template
parameters, and each body parameter is limited to 1024 characters.** A full
content pack is multi-line and longer than that. So a template cannot carry the
pack itself.

The app therefore defaults to **`link` mode**: the template body carries the
date, and its dynamic URL button opens the complete pack at
`https://<your-service>/p/<unguessable-id>`. That is also why free-form text is
not the default — business-initiated messages outside an open 24-hour customer
service window must be templates.

---

## The other thing you should know before you start

**You cannot send the daily pack to the same number that sends it.** The
WhatsApp Cloud API is built for a business number to message a *different*
recipient. Self-messaging is not a supported workflow and behaves unreliably.

Set `WHATSAPP_RECIPIENT_NUMBER` to a team member's or a client's number that
you control. The app enforces this twice: configuration validation refuses to
start if the recipient equals `WHATSAPP_SENDER_NUMBER`, and at startup it asks
Meta for the business number behind `WHATSAPP_PHONE_NUMBER_ID` and blocks
delivery if they turn out to be the same.

---

## Project structure

```
server.js                  entry point: validate config, start HTTP, scheduler, shutdown
src/
  config.js                all environment validation, one place, fail-fast
  logger.js                structured JSON logs with secret redaction
  http.js                  one HTTP call with timeout + bounded retries
  whatsapp.js              Cloud API client: templates, text, read receipts, error mapping
  content.js               pack generation (OpenAI or built-in bank) + brief validation
  store.js                 pack storage, webhook dedupe, 24h window, daily-run lock
  webhook.js               Meta handshake, signature verification, event processing
  daily.js                 the daily job: generate → save → deliver → record
  packPage.js              the private mobile pack page
  setupPage.js             /setup: every Meta and GitHub value, auto-derived
  rateLimit.js             in-memory fixed-window abuse protection
  app.js                   Express routes and middleware
  service.js               wiring
scripts/
  run-daily.js             standalone trigger script (GitHub Actions or a Render cron job)
  send-test.js             safe end-to-end test (supports --dry-run)
  discover-ids.js          prints your App ID, WABA ID and Phone Number ID from the API
  setup-meta.js            registers the webhook and creates the template via the Graph API
  check-render-yaml.js     validates render.yaml before a deploy (no secrets, correct shape)
Dockerfile                 runs the same app on any container host (Fly, Koyeb, Northflank…)
.github/workflows/ci.yml   tests, audit, secret scan and blueprint check on every push
.github/workflows/daily.yml    free daily scheduler (replaces a paid Render cron job)
.github/workflows/verify-deploy.yml  post-deploy live checks, run from GitHub's network
tests/                     100 tests, node:test, no test framework dependency
docs/
  AUDIT.md                 what was wrong with the previous code and why it changed
  META-WEBHOOK-SETUP.md    exact Meta dashboard steps
  TROUBLESHOOTING.md       every error you are likely to hit
  POLICY.md                data retention, consent, opt-out, WhatsApp policy
  CHECKLIST.md             done / tested / still needs you
render.yaml                Render Blueprint (web service)
.env.example               every variable, documented, no real values
```

---

## Run it locally

Requires Node.js 20.11 or newer (22 LTS recommended).

```bash
npm install
cp .env.example .env      # then fill in the values privately
npm test                  # 79 tests, no network needed
npm start                 # http://localhost:3000/health
```

You can run the whole thing with **no Meta credentials at all** just to see the
content side working: set `CONTENT_SOURCE=static` and leave the Meta variables
in place as dummies. `npm test` needs nothing external.

---

## Deploy to Render

### 1. Push the code

The repository root must contain `server.js`, `package.json`,
`package-lock.json`, `render.yaml`, `.env.example`, `.gitignore`, `README.md`,
`src/`, `scripts/`, `tests/`. ZIP files are not deployable.

### 2. Create the service from the Blueprint

Render Dashboard → **New → Blueprint** → connect
`jainathfabrik-maker/JFI-Studio-WhatsApp-Automation` → apply `render.yaml`.

Build command: `npm ci --omit=dev` — Start command: `npm start` — Health check
path: `/health`.

**There is no URL to copy.** Render injects `RENDER_EXTERNAL_URL` for every web
service, and the app also derives its own origin from each request, so
`PUBLIC_BASE_URL` stays empty unless you use a custom domain.

### 3. Fill in the environment variables

Render will prompt for every variable marked `sync: false`. Set them in
**Dashboard → your service → Environment**. The table below says what each one
is and where the value comes from. Never put a value in `render.yaml`, a
commit, an issue or a chat message.

If you are unsure which number is which — the Phone Number ID, the WhatsApp
Business Account ID and the App ID are three different values and swapping them
is the most common failure — run:

```bash
GRAPH_TOKEN=EAA...your-token npm run discover-ids
```

It reads the token from the environment only, prints every identifier it can
see, says which environment variable each one belongs in, and warns you if the
token is a user token that will expire.

### 4. Confirm the service is up

Open `https://<your-service>.onrender.com/health` — expect `{"ok":true,...}`.

Then open **`/setup`**. It prints every value Meta and GitHub need — callback
URL, template body, button URL, sample values — computed from the address you
opened it on, with copy buttons. It contains no secrets.

### 5. Configure Meta

Follow [docs/META-WEBHOOK-SETUP.md](docs/META-WEBHOOK-SETUP.md). You will need
`https://<your-service>.onrender.com/webhook` and your `META_VERIFY_TOKEN`.

### 6. Schedule the daily run — free, via GitHub Actions

**Render cron jobs cost $1/month minimum and are not on the free plan.** The
free scheduler is `.github/workflows/daily.yml`, which already exists. Enable it
with two settings in **GitHub → Settings → Secrets and variables → Actions**:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `PUBLIC_BASE_URL` | `https://your-service.onrender.com` |
| Secret | `ADMIN_TRIGGER_TOKEN` | the same value as on the web service |

It runs at `0 3 * * *` **UTC** = 08:30 IST, calls `POST /admin/run-daily`,
retries for up to five attempts so a cold start is not reported as a failure,
and exits non-zero on real errors. Trigger it by hand any time from the Actions
tab.

Scheduled workflows are free on public repositories. If you make the repository
private, they draw on the account's included Actions minutes — a daily job of a
few seconds each is negligible.

**If you would rather pay $7/month** for an always-on instance, you can also use
`scripts/run-daily.js` as a paid Render cron job instead, or set
`ENABLE_INTERNAL_CRON=true` to use the in-process timer. The in-process timer is
the weakest option: it dies with the process, so a restart at 08:29 means no
pack that day.

Duplicate protection does not depend on which scheduler you use: the run is
idempotent per calendar day in `TIMEZONE`. A restart, a second instance, a cold
start, or the workflow firing twice all result in exactly one message.

---

## Environment variables

| Variable | Required | Where it comes from |
| --- | --- | --- |
| `META_ACCESS_TOKEN` | **yes** | Meta Business settings → System Users → Generate token (permanent). Starts with `EAA`. |
| `META_APP_SECRET` | **yes** | Meta App Dashboard → App settings → Basic → App secret. Used to verify webhook signatures. |
| `META_VERIFY_TOKEN` | **yes** | A long random string **you invent**. Enter the same value in the Meta webhook screen. Must differ from the tokens above. |
| `META_APP_ID` | no | App settings → Basic. Only `scripts/setup-meta.js` needs it, to register the webhook subscription. Not the Phone Number ID, not the WABA ID. |
| `WHATSAPP_PHONE_NUMBER_ID` | **yes** | Meta App Dashboard → WhatsApp → API Setup. Digits only. Not the phone number, not the WABA ID, not the App ID. |
| `WHATSAPP_RECIPIENT_NUMBER` | **yes** | A number you control, international format, digits only, e.g. `919876543210`. Must differ from the business number. |
| `PUBLIC_BASE_URL` | **no — leave it blank** | Only needed for a custom domain. The app resolves its own URL from Render's `RENDER_EXTERNAL_URL`, and failing that from the origin of the request that triggers the run. |
| `ADMIN_TRIGGER_TOKEN` | yes if you use a Cron Job | A long random string you invent (32+ characters). |
| `WHATSAPP_TEMPLATE_NAME` | yes | The approved template name, default `jfi_daily_content_pack`. |
| `WHATSAPP_TEMPLATE_LANGUAGE` | yes | The template's language code, e.g. `en`. Must match the approved variant exactly. |
| `WHATSAPP_TEMPLATE_BODY_FIELDS` | no | Comma-separated pack fields that fill the template's `{{1}}`, `{{2}}`… Default `dateLabel`. Allowed: `dateLabel`, `pillar`, `hook`, `format`, `publishTimeIST`. |
| `WHATSAPP_TEMPLATE_URL_BUTTON_INDEX` | no | Index of the dynamic URL button, default `0`. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | no | WABA ID, used only by `/admin/diagnostics`. |
| `WHATSAPP_SENDER_NUMBER` | no | The business number, digits only, for the self-send guard. If blank the app looks it up from Meta. |
| `META_GRAPH_API_VERSION` | no | Default `v26.0`. Raise deliberately after reading Meta's changelog. |
| `WHATSAPP_DELIVERY_MODE` | no | `link` (default) or `text`. |
| `CONTENT_SOURCE` | no | `auto` (default: OpenAI if a key is set, else the built-in bank), `openai`, or `static`. |
| `OPENAI_API_KEY` | no | OpenAI API project key. Separate billing from a ChatGPT subscription. |
| `OPENAI_MODEL` | no | Default `gpt-6-luna`. |
| `NODE_ENV` | no | `production` on Render. |
| `PORT` | no | Render injects it. Only needed locally. |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error`, `silent`. |
| `TIMEZONE` | no | Default `Asia/Kolkata`. Drives the day boundary and the cron timezone. |
| `DATA_DIR` | no | Where packs and run state are written. Default `./data`. Use `/var/data` if you attach a Render disk. |
| `ENABLE_INTERNAL_CRON` | no | `false` (default). Set `true` only for a single always-on instance. |
| `DAILY_CRON` | no | Default `30 8 * * *`, interpreted in `TIMEZONE`. |
| `META_TIMEOUT_MS` / `META_MAX_RETRIES` | no | Defaults `15000` / `2`. |
| `OPENAI_TIMEOUT_MS` | no | Default `60000`. |

Aliases are accepted for the variables that have drifted between drafts, and the
service warns at startup so you can rename them: `META_API_VERSION` and
`WHATSAPP_GRAPH_VERSION` for `META_GRAPH_API_VERSION`, `DAILY_SCHEDULE` for
`DAILY_CRON`, plus `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_RECIPIENT` for their `META_*` /
`*_NUMBER` equivalents.

Any mistake in these is caught at startup: the process prints the offending
variable **names** (never values) with where to set them, then exits 1.

---

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Render health check. Cheap, no network, no disk. |
| GET | `/status` | none | Resolved configuration, last run, whether delivery is blocked. No secrets, no phone numbers. |
| GET | `/webhook` | token in query | Meta subscription handshake. |
| POST | `/webhook` | `x-hub-signature-256` | Message and delivery-status events. |
| POST | `/admin/run-daily` | `Bearer ADMIN_TRIGGER_TOKEN` | Run today's job. Body `{"force":true}` re-sends. |
| POST | `/admin/resend-latest` | `Bearer ADMIN_TRIGGER_TOKEN` | Re-send the most recent pack. |
| GET | `/admin/diagnostics` | `Bearer ADMIN_TRIGGER_TOKEN` | Asks Meta for the business number and reports whether it matches the recipient. |
| GET | `/p/:id` | unguessable id | The private pack page opened by the WhatsApp button. |
| GET | `/setup` | none | Every value Meta and GitHub need, derived from the request host. No secrets. |

---

## How correctness is enforced

**Configuration.** Every variable is validated once, at startup, in
`src/config.js`. Placeholders like `vXX.X` are rejected; the recipient must be
digits; the Graph version must look like `v26.0`; `link` mode without
`PUBLIC_BASE_URL` is refused. All problems are reported together, then the
process exits.

**Webhook security.** The `x-hub-signature-256` header is verified with HMAC
SHA-256 over the exact raw request body using the app secret, compared in
constant time. A missing, malformed or mismatched signature gets a 401 and the
event is dropped.

**No duplicate processing.** Every inbound message id and every
`message id + status` pair is recorded; a repeat is counted and ignored.
Replay-safe for 24 hours.

**No duplicate sends.** The daily run takes a lock and checks whether today's
pack is already `sent`. Only one message leaves the service per day, whatever
the scheduler does.

**Honest reporting.** A successful send means Meta returned a `wamid`. The API
response is logged as *accepted*, and `/status` says so explicitly. Actual
delivery is confirmed only by the `delivered` / `read` status webhooks, which
the app logs. `deliveryConfirmed` is `false` in every API response.

**Content quality.** The brief is checked mechanically, not trusted: hook ≤ 12
words, hook contains a number or a Bengaluru place name, caption length,
hashtag count, at least three shots, an IST publish time, and none of the
off-brand words. An OpenAI answer that fails gets one repair attempt with the
problems quoted back, then the run fails.

**Failures are loud.** If generation or delivery fails, the pack is marked
`failed`, the error is logged with a plain-language hint, `/status` shows it,
and the admin endpoint returns an error. Nothing is retried in a way that could
double-send.

---

## Tests

```bash
npm test
```

100 tests across configuration validation, the webhook handshake, signature
verification, event deduplication, message sending and payload shape, Meta
error mapping, retry and timeout behaviour, the daily-run guard, timezone and
DST-boundary handling, rate limiting, the 24-hour window, the content brief's
eight required items, and every HTTP route. They use a fake transport, so no network,
credentials or Meta account is involved.

CI runs the same suite on Node 20 and 22 on every push to `main`, plus
`npm audit`, a credential-shaped-string scan, a check that no `.env` is
committed, `node scripts/check-render-yaml.js`, and a boot check confirming the
service exits 1 with a readable message when configuration is missing. Because
`render.yaml` sets `autoDeploy: true`, a red build means a red deploy — run
`node scripts/check-render-yaml.js` locally before pushing if you change that
file.

---

## Security notes

- No secret is ever logged. Logs are one JSON object per line, with
  token-shaped strings scrubbed, secret-named fields redacted, and phone
  numbers masked to `919***210`.
- `.env` files are git-ignored (`.env`, `.env.*`, `!/.env.example`).
- Admin endpoints use a constant-time bearer comparison and are disabled
  entirely if no token is set.
- The pack page URL contains a 22-character random id and is marked
  `noindex, nofollow`. It is a shared-secret link: anyone with it can read the
  pack, so do not forward it.
- **Make the repository private before adding any business configuration.**
- If a real access token, app secret or verify token was ever committed or
  pasted somewhere, rotate it in Meta and replace it in Render.

---

## Hosting on a free tier

The default `render.yaml` now uses `plan: free`: $0, no credit card. What you
accept for that:

| Constraint | Effect here | Mitigation built in |
| --- | --- | --- |
| Sleeps after 15 min idle, ~60s to wake | The first request of the day is slow | The daily workflow retries up to 5 times; health checks tolerate it |
| No persistent disk, filesystem wiped on redeploy **and on spin-down** | Pack links stop working after the service restarts or sleeps | The pack page explains this instead of showing a bare 404. Read the pack soon after it arrives, or move to a paid instance for permanent links |
| No cron jobs ($1/month minimum) | Cannot schedule on Render itself | `.github/workflows/daily.yml` schedules it from GitHub, free |
| 750 instance-hours/month | Far more than a daily job needs | — |

**The honest trade-off:** on a free instance the WhatsApp button works for
roughly as long as the service stays awake — 15 minutes after the last request.
For a pack read shortly after it arrives that is fine. If you want links that
never expire, either move to `starter` ($7/month) with the disk block in
`render.yaml` uncommented, or host on a free tier that does not sleep.

### Free alternatives, checked October 2026

Render's free plan was not the only option, and `Dockerfile` is included so the
app runs unchanged on any container host. Terms change often — verify before
trusting a free tier with a business workflow.

| Host | Free allowance | Sleeps? | Card? | Notes |
| --- | --- | --- | --- | --- |
| **Render** | 512 MB / 0.1 CPU, 750 instance-hours | 15 min idle | No | What `render.yaml` targets. No disk, no cron on free. |
| **Northflank** | 2 services, 512 MB each, 1 free database | Always on | — | Most generous documented free tier for an always-on service. |
| **Koyeb** | 1 service, 512 MB / 0.1 CPU | Reported always-on; some sources say scales to zero | Reported yes | Sources disagree — confirm at sign-up. |
| **SnapDeploy** | 4 containers, 100 container-hours/month | 15 min idle | No | Sleeps like Render; 100 hours caps a 24/7 service. |
| **Hostless / Botkeep / Deplexo / Abasthan** | ~512 MB, always-on claims | Claimed no | Claimed no | Small, new providers. Treat the claims as unverified and do not put business data there first. |
| **Oracle Cloud Always Free** | 4 ARM cores / 24 GB RAM VM | Never | Yes (verification only) | The most capable free option, but you administer the VM. |
| **Fly.io** | No free tier for new accounts since Oct 2024 | — | Yes | Trial only. |
| **Railway** | ~$1/month of credit | Credit runs out | Yes for paid | Not sustainable for a daily job long-term. |
| **Vercel / Netlify / Cloudflare Workers** | Generous serverless | Scale to zero | — | **Wrong shape for this app**: no persistent process, no local disk, so the pack store and the run lock do not survive. Would need a rewrite onto external storage. |

**What not to do:** do not pick a serverless platform for this app without
changing where packs are stored. The code deliberately keeps them on local disk
because that is correct for a single always-on service. On serverless, the
WhatsApp button would 404 for almost every tap.

---

## Known limits, stated plainly

- **Accepted ≠ delivered.** The app reports what Meta confirmed and nothing
  more. Delivery, read receipts and failures arrive later by webhook.
- **Render's free tier sleeps**, so the in-process timer is not reliable there.
  Use `.github/workflows/daily.yml` (free) rather than a paid Render cron job.
- **On a free instance, `DATA_DIR` is wiped on each deploy *and* each
  spin-down.** Dedupe memory and pack history reset, and pack links stop
  resolving. Sends stay correct because the per-day guard is re-derived, but a
  restart immediately after a send could allow one repeat. Attach the disk
  (`render.yaml`, commented) on a paid plan to close both gaps.
- **Marketing templates on the Cloud API sunset on 13 October 2027.** If your
  daily pack template is categorised as *marketing*, Meta expects it to move to
  the Marketing Messages API for WhatsApp by then. Service, utility and
  authentication messages are unaffected. Plan for it; nothing in this code
  blocks on it today.
- **The built-in static pack bank is a fixed rotation of six real packs**, used
  when no OpenAI key is configured. It is genuine content, not placeholder
  text, but it repeats every six days. Set `OPENAI_API_KEY` for daily variety.
- **Rate limiting is per instance and in memory.** It protects against a flood
  consuming CPU; it is not a distributed quota, and it resets on restart. The
  real controls are the webhook HMAC and the admin bearer token.
- **`npm audit` reports zero vulnerabilities** as of this commit, and the only
  dependency with a transitive tree (`node-cron`) is now v4, which has none.

---

## Official references

- WhatsApp Cloud API — <https://developers.facebook.com/docs/whatsapp/cloud-api>
- Graph API changelog — <https://developers.facebook.com/docs/graph-api/changelog>
- Message templates — <https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates>
- Webhooks reference — <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks>
- Cloud API error codes — <https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes>
- Render Blueprint spec — <https://render.com/docs/blueprint-spec>
- Render Cron Jobs — <https://render.com/docs/cronjobs>
- OpenAI Responses API — <https://developers.openai.com/api/docs/guides>
