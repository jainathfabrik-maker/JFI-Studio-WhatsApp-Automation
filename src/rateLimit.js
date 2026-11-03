/**
 * Minimal fixed-window rate limiter. No dependency, no external store.
 *
 * Scope, deliberately: this is abuse protection for a single-instance service,
 * not a distributed quota. Counters live in memory, so a restart clears them
 * and two Render instances would each keep their own. That is proportionate
 * here — the admin surface is already behind a 32+ character bearer token and
 * the webhook is already behind an HMAC signature check. The limiter exists to
 * stop a flood from consuming CPU, not to be the primary control.
 */
export function createRateLimiter({ windowMs = 60_000, max = 600, name = 'requests', now = () => Date.now() } = {}) {
  const buckets = new Map();

  function prune(currentTime) {
    if (buckets.size < 5000) return;
    for (const [key, bucket] of buckets) {
      if (currentTime >= bucket.resetAt) buckets.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const key = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const currentTime = now();
    prune(currentTime);

    let bucket = buckets.get(key);
    if (!bucket || currentTime >= bucket.resetAt) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: `Rate limit exceeded for ${name}. Retry in ${retryAfter} second(s).`,
        code: 'rate-limited',
      });
    }

    return next();
  };
}
