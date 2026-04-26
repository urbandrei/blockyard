// URL shortener. Stores (short_code → full share-string) pairs so clients
// can share tiny links instead of 2KB `?play=<base64>` URLs that break in
// chat apps and link previews.
//
//   POST /shorts/:id?  body: { shareCode } → 201 { code, shareCode }
//     Creates or returns a short code for the given share-string. Same
//     input always produces the same code (idempotent, safe to spam).
//
//   GET  /shorts/:code            → 200 { code, shareCode } | 404
//     Client-side resolver. Returns the full share-string so the client
//     can decode and play the level on whatever origin it's running on.
//     No HTTP redirect — the client keeps the user on its own domain.
//
// Why no /s/:code → 302 redirect? Because the sharer's origin (itch vs
// block-yard.com) should be preserved. A block-yard user shares a
// block-yard-flavored URL; an itch user shares an itch URL. Both URLs
// embed the SAME code, and each origin resolves it via this endpoint.

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, schema } from '../db/client.js';
import { requireToken } from '../auth/token.js';
import { rateLimit } from '../rateLimit.js';

export const shortsRoutes = new Hono();

// 8 chars of base64url from sha256 → 64^8 = ~281 trillion. Deterministic
// so re-shortening the same content is a no-op. If two distinct share
// codes ever collide on the first 8 chars we bump to 10, 12, 14, …
function shortCodeFor(shareCode: string, extraChars = 0): string {
  return createHash('sha256').update(shareCode).digest('base64url').slice(0, 8 + extraChars);
}

// Shared helper — HTTP POST /shorts and the Discord "Social Link" button
// both call this. Returns the short code; inserts on first call, returns
// the existing row on subsequent calls with the same share code.
//
// Dedupe is keyed on `id`, not `share_code`: id = sha256(shareCode)[:8+extra]
// is itself a deterministic hash of the input, so any two requests with the
// same share_code compute the same id and hit the PK on insert. Looking up
// by id (PK index) also avoids ever needing a btree on share_code, which
// can exceed Postgres' 2704-byte per-tuple index cap on large levels.
export async function getOrCreateShortCode(shareCode: string): Promise<string> {
  let extra = 0;
  while (extra < 8) {
    const id = shortCodeFor(shareCode, extra);
    const [existing] = await db.select().from(schema.shortLinks)
      .where(eq(schema.shortLinks.id, id)).limit(1);
    if (existing) {
      if (existing.shareCode === shareCode) return id;
      // Same id, different share_code — first-N-chars hash collision.
      // Bump prefix length and try again.
      extra += 2;
      continue;
    }
    try {
      await db.insert(schema.shortLinks).values({
        id, shareCode, createdAt: Date.now(),
      });
      return id;
    } catch (err: any) {
      if (err?.code !== '23505') throw err;
      const [raced] = await db.select().from(schema.shortLinks)
        .where(eq(schema.shortLinks.id, id)).limit(1);
      if (raced?.shareCode === shareCode) return id;
      extra += 2;
    }
  }
  throw new Error('could not allocate short code');
}

shortsRoutes.post('/shorts', requireToken(), async (c) => {
  const { token } = c.get('auth');
  // Reuse the like-bucket shape — "cheap write, limit per minute".
  const gate = rateLimit.checkLike(token);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await c.req.json().catch(() => null) as { shareCode?: string } | null;
  const shareCode = typeof body?.shareCode === 'string' ? body.shareCode.trim() : '';
  if (!shareCode) return c.json({ error: 'shareCode required' }, 400);
  if (shareCode.length > 20000) return c.json({ error: 'shareCode too long' }, 413);

  try {
    const code = await getOrCreateShortCode(shareCode);
    return c.json({ code, shareCode });
  } catch (err) {
    console.error('[shorts] allocation failed', err);
    return c.json({ error: 'could not allocate short code' }, 500);
  }
});

shortsRoutes.get('/shorts/:code', async (c) => {
  const code = c.req.param('code')!;
  const [row] = await db.select({ shareCode: schema.shortLinks.shareCode })
    .from(schema.shortLinks).where(eq(schema.shortLinks.id, code)).limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ code, shareCode: row.shareCode });
});
