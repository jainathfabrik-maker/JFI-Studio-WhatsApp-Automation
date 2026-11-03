# Meta webhook and template setup

Exact steps in the Meta Developer Dashboard. Steps marked **required** block the
app from working. Steps marked **conditional** depend on your account state.

Official docs: <https://developers.facebook.com/docs/whatsapp/cloud-api/get-started>

---

## 0. Before you touch the dashboard

Have these ready:

- The deployed service URL: `https://<your-service>.onrender.com`
- The value you chose for `META_VERIFY_TOKEN` in Render (a long random string)
- Access to the Meta Business portfolio that owns the WhatsApp Business Account
- A payment method, if the account is not already on a paid messaging tier

---

## 1. Open the right app — required

1. Go to <https://developers.facebook.com/apps>.
2. Open the app that has the **WhatsApp** product added.
3. Confirm the business portfolio shown in the top bar is the one that owns your
   WhatsApp Business Account.

If the app has no WhatsApp product, add it: **App Dashboard → Add product →
WhatsApp → Set up**.

---

## 2. Find the three different IDs — required

These are three separate values and mixing them up is the most common failure.

| What you need | Where to find it | Looks like |
| --- | --- | --- |
| **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup → "From" number → Phone number ID | `123456789012345` |
| **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp → API Setup, or Business settings → Accounts → WhatsApp accounts | `987654321098765` |
| **App ID** | App settings → Basic | `1234567890123456` |

The **App ID is not the Phone Number ID.** Neither is the phone number itself.
`/admin/diagnostics` will tell you what the Phone Number ID resolves to, which
is the fastest way to confirm you used the right one.

---

## 3. Get a permanent access token — required

The token on the API Setup page is temporary and expires in about 24 hours.
Do not use it for a scheduled job.

1. **business.facebook.com → Business settings → Users → System users.**
2. Create (or pick) a system user of type **Admin**.
3. **Assign assets** → add your WhatsApp Business Account and the app, with
   full control.
4. **Generate new token** → choose the app → select the
   `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
5. Copy the token **once** and paste it straight into Render as
   `META_ACCESS_TOKEN`. Never into a file, a commit, or a chat.

Meta tokens start with `EAA`. If yours does not, you have copied the wrong
value.

---

## 4. Get the app secret — required

**App Dashboard → App settings → Basic → App secret → Show.**

Paste it into Render as `META_APP_SECRET`. This is what verifies the
`x-hub-signature-256` header on every inbound webhook; without it the app
rejects every webhook with 401.

---

## 5. Create the message template — required

> **Automated alternative.** Steps 5 and 6 can both be done through the Graph API
> instead of the dashboard:
>
> ```bash
> GRAPH_TOKEN=EAA... APP_ID=<app-id> WABA_ID=<waba-id> \
>   PUBLIC_BASE_URL=https://<your-service>.onrender.com \
>   META_VERIFY_TOKEN=<your-token> node scripts/setup-meta.js --webhook --template
> ```
>
> It is a dry run unless you add `--apply`, so the first run just prints the exact
> requests. Add `--check` to read your current subscription and report whether
> `messages` is subscribed. Everything below still describes what is being
> created, and is the way to do it if you prefer the dashboard.

The default delivery mode needs one approved template with **a body variable and
a dynamic URL button**.

1. **WhatsApp Manager → Message templates → Create template.**
2. Category: choose what the content honestly is. A daily marketing content
   pack is normally **Marketing**; a message that only delivers an internal
   operational update may qualify as **Utility**. Meta decides during review —
   do not mislabel it to dodge the category, that gets templates paused.
3. Name: `jfi_daily_content_pack` (must match `WHATSAPP_TEMPLATE_NAME`).
4. Language: `en` (must match `WHATSAPP_TEMPLATE_LANGUAGE`).
5. **Body** — one variable, single line, for example:

   ```
   Your JFI Studio content pack for {{1}} is ready. Tap the button to open it.
   ```

6. **Buttons → URL → Dynamic.**
   - Button text: `Open pack` (max 25 characters)
   - URL: `https://<your-service>.onrender.com/p/{{1}}`
   - The variable must be at the **very end** of the URL. That is a Meta rule.
7. Sample values: `Tue 3 Nov 2026` for the body, `abc123XYZ` for the URL.
8. Submit and wait for **Approved**.

**Why the URL button and not the pack text?** Meta rejects newlines, tabs and
leading/trailing spaces inside template parameters, and caps each body
parameter at 1024 characters. A full content pack is multi-line and longer than
that, so the template carries a pointer and the button opens the real thing.

If your approved template has a different number of body variables, set
`WHATSAPP_TEMPLATE_BODY_FIELDS` to match, e.g. `dateLabel,pillar` for two
variables. The allowed fields are `dateLabel`, `pillar`, `hook`, `format` and
`publishTimeIST`. The app refuses to send if the count does not match, rather
than letting Meta return error 132000.

---

## 6. Configure the webhook — required

1. **App Dashboard → WhatsApp → Configuration → Webhook → Edit.**
2. **Callback URL:** `https://<your-service>.onrender.com/webhook`
3. **Verify token:** the exact value of `META_VERIFY_TOKEN` in Render. It is
   case-sensitive and must match character for character.
4. Click **Verify and save**. Meta sends `GET /webhook?hub.mode=subscribe…`;
   the service answers with the challenge, and the dashboard shows a green
   confirmation.
5. **Webhook fields → Manage.** Subscribe to **`messages`**. That single field
   carries both inbound messages and outbound delivery statuses
   (`sent`, `delivered`, `read`, `failed`).

If verification fails with a 403, the verify token does not match, or
`META_VERIFY_TOKEN` is not set in Render. Check the service logs — the app logs
`Webhook verification rejected` with a reason and never logs the token.

---

## 7. Add the recipient — required

1. In Render, set `WHATSAPP_RECIPIENT_NUMBER` to a number you control, in
   international format without `+`, e.g. `919876543210`.
2. It must be a **different** number from the business number behind
   `WHATSAPP_PHONE_NUMBER_ID`.
3. Optionally set `WHATSAPP_SENDER_NUMBER` to the business number so the guard
   can run without a network call.

**About sending to the same number:** you previously wanted the business number
to message itself. The Cloud API does not support that as a dependable
workflow. The app will refuse it — at startup, and again at delivery time — with
an explicit error rather than a silent failure. Use a second number: a personal
phone, a team member's phone, or a second business number.

---

## 8. Test it — required

1. Confirm the service is healthy: `GET /health` → `{"ok":true,...}`.
2. Confirm the sender/recipient guard: `GET /admin/diagnostics` with
   `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`. Expect
   `senderMatchesRecipient: false`.
3. Generate and send: `POST /admin/run-daily` with the same header.
   A `200` with `"accepted": true` means Meta took the message.
4. Watch the logs for `WhatsApp delivery status` — `delivered` then possibly
   `read` confirm the message actually landed. **Accepted is not delivered.**
5. If you would rather not consume a day's pack, `npm run send-test` re-sends
   the most recent pack, and `npm run send-test -- --dry-run` prints the exact
   request and sends nothing.

---

## 9. Production access, business verification, payment — conditional

These are account-level and cannot be done from this code. Check each one in
**WhatsApp Manager → Overview / Account tools**.

- **Test number only?** A test number can message up to five verified
  recipients. Add your recipient under API Setup → "To" → Manage phone number
  list, and confirm the code it receives. Fine for a pilot, not for production.
- **Business verification** — usually needed to raise messaging limits and to
  display a verified business name. Business settings → Business info →
  Verification.
- **Display name approval** — the name customers see. Must be approved before
  the number is live for customers.
- **Payment method** — attach one in WhatsApp Manager → Account tools →
  Payment settings. Without it, outbound messages fail once any free
  allowance is exhausted.
- **Messaging limits** — new numbers start at a low 24-hour tier and scale with
  quality rating and volume. A single daily message will not approach it.
- **Opt-in** — you need a lawful basis and a record of consent for each
  recipient. Meta requires opt-in for business-initiated messages.

---

## 10. Two dated things worth putting in a calendar

- **Graph API versions retire roughly two years after release.** v26.0 is
  current at the time of writing. When you upgrade, change
  `META_GRAPH_API_VERSION`, redeploy, and re-run `npm test` plus one
  `send-test`.
- **Marketing messages on the Cloud API sunset on 13 October 2027.** Marketing
  templates move to the Marketing Messages API for WhatsApp; service, utility
  and authentication messages stay on the Cloud API. If your daily pack template
  is categorised as marketing, plan the migration before that date.
