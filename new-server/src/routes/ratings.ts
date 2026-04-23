// Upsert a 1..5-star rating. rating_sum + rating_count on the levels row
// are the denormalized aggregate so sort-by-average-rating is a single
// index-scan. All writes happen inside one transaction.

import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { requireToken } from '../auth/token.js';
import { rateLimit } from '../rateLimit.js';

export const ratingRoutes = new Hono();

ratingRoutes.post('/levels/:id/rating', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const levelId = c.req.param('id');

  const gate = rateLimit.checkRate(token);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await c.req.json().catch(() => null) as { stars?: number } | null;
  const stars = Number(body?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return c.json({ error: 'stars must be an integer 1-5' }, 400);
  }

  const result = await db.transaction(async (tx) => {
    const [level] = await tx.select({ status: schema.levels.status })
      .from(schema.levels).where(eq(schema.levels.id, levelId)).limit(1);
    if (!level || level.status !== 'public') return null;

    const [prior] = await tx.select({ stars: schema.ratings.stars })
      .from(schema.ratings)
      .where(and(eq(schema.ratings.token, token), eq(schema.ratings.levelId, levelId)))
      .limit(1);
    const now = Date.now();

    if (prior) {
      const delta = stars - prior.stars;
      await tx.update(schema.ratings)
        .set({ stars, updatedAt: now })
        .where(and(eq(schema.ratings.token, token), eq(schema.ratings.levelId, levelId)));
      await tx.update(schema.levels)
        .set({
          ratingSum: sql`${schema.levels.ratingSum} + ${delta}`,
          updatedAt: now,
        })
        .where(eq(schema.levels.id, levelId));
    } else {
      await tx.insert(schema.ratings).values({
        token, levelId, stars, createdAt: now, updatedAt: now,
      });
      await tx.update(schema.levels)
        .set({
          ratingSum: sql`${schema.levels.ratingSum} + ${stars}`,
          ratingCount: sql`${schema.levels.ratingCount} + 1`,
          updatedAt: now,
        })
        .where(eq(schema.levels.id, levelId));
    }

    const [after] = await tx.select({
      ratingSum: schema.levels.ratingSum,
      ratingCount: schema.levels.ratingCount,
    }).from(schema.levels).where(eq(schema.levels.id, levelId)).limit(1);
    return after!;
  });

  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json({
    ratingAvg: result.ratingCount > 0 ? result.ratingSum / result.ratingCount : 0,
    ratingCount: result.ratingCount,
    yourStars: stars,
  });
});

ratingRoutes.get('/my/ratings', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const rows = await db.select({ levelId: schema.ratings.levelId, stars: schema.ratings.stars })
    .from(schema.ratings)
    .where(eq(schema.ratings.token, token));
  return c.json({ ratings: rows });
});
