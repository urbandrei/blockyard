// In-memory sliding-window rate limit. Keyed on "<bucket>:<id>".
// Resets on process restart — fine for a single-user laptop server.

type Bucket = { times: number[]; limit: number; windowMs: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private config: { publishPerDay: number; likePerMinute: number }) {}

  checkPublish(token: string, ip: string | null): { ok: boolean; retryAfterMs?: number } {
    const a = this.hit(`publish:tok:${token}`, this.config.publishPerDay, 24 * 60 * 60 * 1000);
    if (!a.ok) return a;
    if (!ip) return { ok: true };
    return this.hit(`publish:ip:${ip}`, this.config.publishPerDay, 24 * 60 * 60 * 1000);
  }

  checkLike(token: string): { ok: boolean; retryAfterMs?: number } {
    return this.hit(`like:tok:${token}`, this.config.likePerMinute, 60 * 1000);
  }

  private hit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = this.buckets.get(key) ?? { times: [], limit, windowMs };
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
