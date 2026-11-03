# Pluggable storage

**Status: implemented for `file` (default) and `redis`. `vercel-blob` was
considered and deliberately not built — see the end of this document.**

Select with `STORAGE_DRIVER`:

| Value | Backing store | Needs | Where it makes sense |
| --- | --- | --- | --- |
| `file` (default) | Local disk under `DATA_DIR` | Nothing | Render, Docker, any VM. Unchanged behaviour. |
| `redis` | Upstash Redis over HTTPS | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Serverless: Vercel, Netlify, Lambda. |

An unknown value throws at startup. There is no silent fallback, because a
fallback would look like working storage and quietly lose packs.

Tests: `tests/redisStore.test.js` drives the driver against a fake Upstash REST
endpoint that throws on any command it does not implement, and asserts the exact
commands emitted — including that the lock is a single `SET ... NX PX 900000` and
that de-duplication uses `EX 86400`.

---

## Why this matters

`src/store.js` is the only module that touches the filesystem. It owns four
things:

| Concern | Used by | Breaks on serverless because |
| --- | --- | --- |
| Content packs (`packs/<id>.json`, `packs/index.json`) | `GET /p/:id`, the daily runner | A later request may hit a different instance, so pack links 404 |
| Daily-run lock (`daily.lock`) | `runDaily` | Resets between invocations, so a duplicate send is possible |
| Webhook dedupe (`state.json` → `seenEvents`) | `processWebhookBody` | Resets, so Meta retries get processed twice |
| 24-hour window (`state.json` → `lastInbound`) | `text` delivery mode | Resets, so free-form sends are refused more often than necessary |

The store's public API is already an interface — nothing outside `store.js`
knows a file exists. That makes a driver swap contained:

```
init()
savePack(pack)                    getPackById(id)
getPackByDate(dateKey)            latestPack()
updatePack(id, patch)
hasSeenEvent(id)                  markEventSeen(id)
recordInbound(waId)               lastInboundAt(waId)   isWithinServiceWindow(waId)
tryAcquireRunLock(dateKey, owner) releaseRunLock()      getLastRun()  recordRun(record)
```

## How it is built

`src/store.js` is a factory over `src/stores/*.js`. The interface is uniform and
**every method is async**, because Redis is a network call:

```
init()
savePack(pack)   getPackById(id)   getPackByDate(dateKey)   latestPack()
updatePack(id, patch)
hasSeenEvent(id)   markEventSeen(id)
recordInbound(waId)   lastInboundAt(waId)   isWithinServiceWindow(waId)
tryAcquireRunLock(dateKey, owner)   releaseRunLock()
getLastRun()   recordRun(record)
```

Making reads async meant updating every caller: the webhook handler, the pack
page route, `/status` and the daily runner. `processWebhookBody` is now async.

### Why Redis rather than object storage

All four concerns need **atomic read-modify-write** and **expiry**:

- `tryAcquireRunLock` must be atomic — `SET key value NX PX 900000` gives that
  in one command, where the file version relies on a write-then-read race being
  small.
- `markEventSeen` needs TTL, which Redis does natively (`SET ... EX 86400`)
  instead of the manual prune pass the file driver does.
- `lastInbound` is a hash with a TTL.

Vercel Blob is object storage: no atomic set-if-absent, no TTL, and every lock
acquire becomes a read-compare-write with a race window that could send the same
WhatsApp message twice. A pack is about 2 KB, so Blob adds nothing Redis does not
already do.

**Decision: `vercel-blob` is not implemented.** It would add a second service, a
second credential and a real correctness gap, for no capability Redis lacks.
`STORAGE_DRIVER=vercel-blob` fails at startup with a message saying so and
pointing here. If you want it anyway, say so and it is about 80 lines.

### Cost and effort

- Upstash free tier: 10,000 commands/day, 256 MB. One daily pack plus a handful
  of webhook events is well inside that.
- Effort: roughly 150 lines for the Redis driver, ~80 for Blob, plus tests for
  each against a fake HTTP layer. The existing `http` injection point already
  makes that testable without a network.
- Risk: the lock semantics change from "file exists" to "SET NX". That needs
  explicit tests, because a broken lock means duplicate WhatsApp messages.

## What still does not work on Vercel with `redis`

Redis fixes the correctness problems. Two honest caveats remain:

1. **Cold starts.** A free-tier function takes a second or more before app code
   runs. Meta's webhook timeout is generous, but someone tapping a pack link
   notices.
2. **A second service.** Managed Redis has its own free-tier limits, credentials
   and failure mode. Upstash's free tier is 10,000 commands/day — one daily pack
   plus a handful of webhook events is far inside that, but a Redis outage stops
   pack links.
3. **No in-process scheduler.** The daily run still needs an external trigger
   (Vercel Cron or the GitHub Actions workflow). True on every host.

## Recommendation

**Render free plan with `STORAGE_DRIVER=file`** remains the fewest moving parts:
no `.env` file, no second service, URL resolved automatically. Choose Vercel with
`STORAGE_DRIVER=redis` if you need the Vercel platform specifically — it works,
it is just two services instead of one.
