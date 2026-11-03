# Proposal: pluggable storage

**Status: not implemented. Awaiting your approval.**

This is a design proposal, not a description of the current code. Today the app
stores everything on the local filesystem, which is correct for Render, Docker
and any VM, and wrong for serverless.

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

## Proposed shape

One new variable, `STORAGE_DRIVER`, defaulting to `file` so nothing changes for
existing deployments:

| `STORAGE_DRIVER` | Backing store | Needs |
| --- | --- | --- |
| `file` (default) | Local disk under `DATA_DIR` | Nothing. Current behaviour, byte for byte. |
| `redis` | Upstash Redis over HTTPS | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| `vercel-blob` | Vercel Blob | `BLOB_READ_WRITE_TOKEN` (Vercel injects it when a Blob store is attached) |

`src/store.js` keeps its current implementation and is renamed internally to
`fileDriver`. Two new modules, `src/store/redisDriver.js` and
`src/store/blobDriver.js`, implement the same API. `createStore` picks one from
config and throws at startup on an unknown value — never silently falls back,
because a silent fallback would look like working storage and lose data.

### Why Redis is the better of the two

All four concerns need **atomic read-modify-write** and **expiry**:

- `tryAcquireRunLock` must be atomic — `SET key value NX PX 900000` gives that
  in one command, where the file version relies on a write-then-read race being
  small.
- `markEventSeen` needs TTL, which Redis does natively (`SET ... EX 86400`)
  instead of the manual prune pass the file driver does.
- `lastInbound` is a hash with a TTL.

Vercel Blob is object storage: no atomic set-if-absent, no TTL, and every lock
acquire becomes a read-compare-write with a race window. It would work for pack
bodies and be genuinely worse for the lock and dedupe. If Vercel is the target,
the honest recommendation is **Redis for state + Blob (or Redis) for packs**.

### Cost and effort

- Upstash free tier: 10,000 commands/day, 256 MB. One daily pack plus a handful
  of webhook events is well inside that.
- Effort: roughly 150 lines for the Redis driver, ~80 for Blob, plus tests for
  each against a fake HTTP layer. The existing `http` injection point already
  makes that testable without a network.
- Risk: the lock semantics change from "file exists" to "SET NX". That needs
  explicit tests, because a broken lock means duplicate WhatsApp messages.

## What would still not work on Vercel

Even with a pluggable store, three things remain true, and I would not want them
hidden:

1. **Cold starts.** A free-tier function takes a second or more before the
   first line of app code runs. Meta's webhook timeout is generous, but a
   user tapping a pack link notices.
2. **No in-process scheduler.** The daily run still has to come from an external
   trigger (Vercel Cron, GitHub Actions, or `POST /admin/run-daily`). That is
   already true today.
3. **Two moving parts instead of one.** A managed Redis is a second service to
   keep alive, with its own free-tier limits, credentials and failure mode. On
   Render with a disk, the filesystem is one fewer thing that can be wrong.

## Recommendation

If the goal is a working deployment this week: **Render free plan**, which needs
no `.env` file, no storage driver and no second service. The URL resolves
automatically from `RENDER_EXTERNAL_URL`.

If Vercel is a firm requirement, say so and I will implement `redis` +
`vercel-blob` drivers behind `STORAGE_DRIVER`, with tests for the lock and
dedupe semantics, and leave `file` as the default so Render and Docker are
untouched.
