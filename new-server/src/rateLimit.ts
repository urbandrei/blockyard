// In-memory sliding-window rate limit. Keyed on "<bucket>:<id>". Resets on
// process restart — fine for a single-shard Render Web Service. If we ever
// scale to multiple instances, move to Redis or a DB-backed bucket.

import { env } from './env.js';

type Bucket = { times: number[] };

class RateLimiter {
  private buckets = new Map<string, Bucket>();

  checkPublish(token: string, ip: string | null): { ok: boolean; retryAfterMs?: number } {
    const a = this.hit(`publish:tok:${token}`, env.RATE_PUBLISH_PER_DAY, 24 * 60 * 60 * 1000);
    if (!a.ok) return a;
    if (!ip) return { ok: true };
    return this.hit(`publish:ip:${ip}`, env.RATE_PUBLISH_PER_DAY, 24 * 60 * 60 * 1000);
  }

  checkLike(token: string): { ok: boolean; retryAfterMs?: number } {
    return this.hit(`like:tok:${token}`, env.RATE_LIKE_PER_MINUTE, 60 * 1000);
  }

  checkRate(token: string): { ok: boolean; retryAfterMs?: number } {
    return this.hit(`rate:tok:${token}`, env.RATE_RATING_PER_MINUTE, 60 * 1000);
  }

  // Plays telemetry — POST /plays (start) + PATCH /plays/:id (end). Generous
  // limit because each level run produces 1 POST + 1 PATCH; bots that try
  // to spam fake completions get throttled at this layer first.
  checkPlay(token: string): { ok: boolean; retryAfterMs?: number } {
    return this.hit(`play:tok:${token}`, env.RATE_PLAY_PER_MINUTE, 60 * 1000);
  }

  private hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = this.buckets.get(key) ?? { times: [] };
    bucket.times = bucket.times.filter(t => t > cutoff);
    if (bucket.times.length >= limit) {
      const retryAfterMs = bucket.times[0]! + windowMs - now;
      this.buckets.set(key, bucket);
      return { ok: false, retryAfterMs };
    }
    bucket.times.push(now);
    this.buckets.set(key, bucket);
    return { ok: true };
  }
}

export const rateLimit = new RateLimiter();
