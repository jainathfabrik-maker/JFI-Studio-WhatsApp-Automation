# Data, consent and WhatsApp policy

This service sends business-initiated WhatsApp messages. That puts it inside
Meta's WhatsApp Business Messaging Policy and, in India, inside the DPDP Act
2023. This page states what the code does, what it stores, and what the operator
must do that the code cannot.

---

## What the service stores

Everything lives in `DATA_DIR` on the service's own disk. There is no external
database and no third-party analytics.

| Stored | Where | Contents | Retention |
| --- | --- | --- | --- |
| Content packs | `packs/<id>.json` | The generated marketing pack: hook, caption, hashtags, shot list, on-screen text, tracking slug | Last 120 packs, then the oldest is dropped from the index |
| Pack index | `packs/index.json` | `date → pack id` | Same as above |
| Run state | `state.json` | Last run result, message ids returned by Meta, dedupe event ids (24h), last inbound timestamp per sender (48h) | Rolling, pruned on every write |
| Run lock | `daily.lock` | `dateKey`, pid, timestamp | Deleted when the run ends; treated as stale after 15 minutes |

**Not stored:** message bodies, media, contact names, profile photos, or any
inbound message content. The webhook handler reads only the message *type* and
the sender's WhatsApp id, and keeps the id only as a timestamp for the 24-hour
window.

**Not stored:** any credential. Tokens and secrets are read from the environment
on each request and never written to disk, a log line, or a pack.

---

## What the service logs

Structured JSON, one object per line. Never a token, an app secret, a verify
token, a message body, or a full phone number.

- Phone numbers are masked to `919***210` before logging.
- Any string shaped like a Meta token (`EAA…`) or an OpenAI key (`sk-…`) is
  replaced with `***REDACTED***` even if it arrives in an error message.
- Object keys matching `token`, `secret`, `password`, `authorization`, `apikey`,
  `credential` or `cookie` are replaced with `[redacted]` before output.

Logs are held by Render according to your Render plan's retention. Treat them as
operational data, not as a business record.

---

## Consent — required before you message anyone

The Cloud API requires opt-in for business-initiated messages. The service
cannot obtain it for you, and it does not attempt to.

Before adding a number to `WHATSAPP_RECIPIENT_NUMBER`, you need:

1. A clear affirmative action from that person — a form, a WhatsApp message, a
   signed engagement letter. Silence, a pre-ticked box, or a scraped number is
   not consent.
2. A record of when and how consent was given, and for what. Keep it outside
   this service; this service deliberately holds no consent records.
3. A statement of what they will receive — "a daily content pack for internal
   review" is honest; "marketing offers" would need different consent and a
   different template category.

If the recipient is a member of your own team, that is still a person whose
number you are using. Confirm they are happy to receive a daily message.

---

## Opt-out

Every business-initiated message must be easy to stop. The service does not
implement an automatic opt-out keyword, so handle it as a process:

1. If someone replies asking to stop, honour it immediately — set
   `WHATSAPP_RECIPIENT_NUMBER` to a different number or pause the cron job.
2. Record the opt-out outside this service, and do not re-add the number.
3. Meta also maintains its own block list: once a user blocks the business, sends
   to them fail with error 131026. The service logs that failure and does not
   retry it.

Adding an automatic opt-out handler would mean replying to inbound messages,
which needs its own approved template and a 24-hour window. It is not enabled
here, deliberately, rather than half-built.

---

## Template category matters

The daily pack template is normally **Marketing**. Choose the category honestly
in WhatsApp Manager — mislabelling a marketing template as Utility to reach more
people is a policy violation and gets templates paused (error 132007).

Meta has announced that **marketing messages on the Cloud API sunset on
13 October 2027**, after which marketing templates move to the Marketing
Messages API for WhatsApp. Service, utility and authentication messages stay on
the Cloud API. If your template is marketing, plan that migration.

---

## Data minimisation choices in the code

- The webhook handler returns 200 and discards the message body rather than
  storing it.
- The pack page URL contains a 22-character random id, is marked
  `noindex, nofollow`, and is not linked from anywhere else. It is a
  shared-secret link: anyone holding it can read the pack, so treat it as
  confidential and do not forward it.
- `/status` exposes configuration shape and the last run outcome, never a phone
  number, token or business identifier.
- Error responses never include a secret. Stack traces appear only when
  `NODE_ENV` is not `production`.

---

## Deletion

- To delete all stored packs and state: stop the service, remove `DATA_DIR`, and
  restart. On Render without a persistent disk this happens automatically on
  each deploy.
- To delete a single pack, remove `packs/<id>.json` and its entry in
  `packs/index.json`.
- To remove a recipient entirely, clear their entry from `state.json` under
  `lastInbound`, and stop sending to them.

---

## Your obligations as the operator

The code cannot do these for you:

- Hold a lawful basis and a consent record for each recipient.
- Keep the repository private and rotate any credential that has been exposed.
- Complete business verification and display-name approval.
- Attach a payment method before business-initiated messages stop being free.
- Publish the app; while it is unpublished, Meta delivers no production webhook
  data.
- Respond to data-subject requests (access, correction, erasure) for the numbers
  you have messaged.

---

## References

- WhatsApp Business Messaging Policy — <https://business.whatsapp.com/policy>
- WhatsApp Cloud API opt-in requirements — <https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in>
- Marketing Messages API sunset — <https://developers.facebook.com/docs/whatsapp/marketing-messages-api-for-whatsapp>
- India DPDP Act 2023 — <https://www.meity.gov.in/data-protection-framework>
