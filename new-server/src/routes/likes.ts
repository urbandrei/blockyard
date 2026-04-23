// Toggle a like on a public level. Writes the likes row and bumps the
// denormalized counter on levels.likes inside one transaction.

import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { requireToken } from '../auth/token.js';
import { rateLimit } from '../rateLimit.js';

export const likeRoutes = new Hono();

likeRoutes.post('/levels/:id/like', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const levelId = c.req.param('id')!;

  const gate = rateLimit.checkLike(token);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await c.req.json().catch(() => null) as { liked?: boolean } | null;
  const liked = body?.liked !== false;

  const result = await db.transaction(async (tx) => {
    const [level] = await tx.select({ status: schema.levels.status, likes: schema.levels.likes })
      .from(schema.levels).where(eq(schema.levels.id, levelId)).limit(1);
    if (!level || level.status !== 'public') return null;

    const [existing] = await tx.select({ levelId: schema.likes.levelId })
      .from(schema.likes)
      .where(and(eq(schema.likes.token, token), eq(schema.likes.levelId, levelId)))
      .limit(1);
    const was = !!existing;

    if (liked === was) return { liked, likes: level.likes };

    if (liked) {
      await tx.insert(schema.likes).values({
        token, levelId, createdAt: Date.now(),
      });
      const [updated] = await tx.update(schema.levels)
        .set({ likes: sql`${schema.levels.likes} + 1`, updatedAt: Date.now() })
        .where(eq(schema.levels.id, levelId))
        .returning({ likes: schema.levels.likes });
      return { liked, likes: updated!.likes };
    } else {
      await tx.delete(schema.likes)
        .where(and(eq(schema.likes.token, token), eq(schema.likes.levelId, levelId)));
      const [updated] = await tx.update(schema.levels)
        .set({ likes: sql`GREATEST(${schema.levels.likes} - 1, 0)`, updatedAt: Date.now() })
        .where(eq(schema.levels.id, levelId))
        .returning({ likes: schema.levels.likes });
      return { liked, likes: updated!.likes };
    }
  });

  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json(result);
});

likeRoutes.get('/my/likes', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const rows = await db.select({ levelId: schema.likes.levelId })
    .from(schema.likes)
    .where(eq(schema.likes.token, token));
  return c.json({ ids: rows.map(r => r.levelId) });
});
