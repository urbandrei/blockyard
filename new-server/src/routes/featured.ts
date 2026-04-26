// Daily-featured-level HTTP routes. The client polls /featured/today on
// HomeScene entry to drive the featured-panel; /featured/history feeds
// the streak strip; /featured/level/:date is a catch-up fetch when the
// player taps a past day.
//
// Each response carries both the metadata row AND the full decoded level
// body so the client can render + launch without a second hop. Returns
// null (404 for by-date) when the underlying record is missing or has
// been moderated away (status flipped off 'public').

import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { decodeShareString } from '../share.js';
import {
  getToday, getHistory, getByDate, nextRotateUtcMs,
  type FeaturedRow,
} from '../moderation/featuredStore.js';

export const featuredRoutes = new Hono();

// Response shape (matches the existing client expectations in
// HomeScene._loadFeaturedAsync):
//   { entry: { utcDate, levelId, addedBy, promotedAt },
//     name, author, level, nextRotateUtcMs }
// `null` when no featured row exists OR the underlying level is no longer
// public (deleted / unpublished). The client treats null as "hide the
// panel" — but we still surface nextRotateUtcMs in a sibling response
// shape so the countdown shows even before the first pick lands.
featuredRoutes.get('/featured/today', async (c) => {
  const row = await getToday();
  if (!row) {
    // No featured pick yet — give the client just the countdown so the
    // panel can render an "empty + counting down" state if it wants to.
    return c.json({ nextRotateUtcMs: nextRotateUtcMs() });
  }
  const hydrated = await hydrateRow(row);
  if (!hydrated) {
    // Featured row exists but the level is gone / unpublished. Hide the
    // panel rather than serving a stale name+id.
    return c.json({ nextRotateUtcMs: nextRotateUtcMs() });
  }
  return c.json({
    entry: {
      utcDate:    row.utcDate,
      levelId:    row.levelId,
      addedBy:    row.addedBy,
      promotedAt: row.promotedAt,
    },
    name:   hydrated.name,
    author: hydrated.author,
    level:  hydrated.level,
    nextRotateUtcMs: nextRotateUtcMs(),
  });
});

// History entries carry name + author so the streak strip can label past
// days without a per-entry round trip. Levels that have since been
// deleted/unpublished still appear in the list (the historical record is
// kept) but with placeholder labels — the streak strip uses utcDate as
// the source of truth for "did we play that day".
featuredRoutes.get('/featured/history', async (c) => {
  const limitParam = c.req.query('limit');
  const limit = Math.max(1, Math.min(100, parseInt(limitParam ?? '30', 10) || 30));
  const rows = await getHistory(limit);
  const ids = Array.from(new Set(rows.map((r) => r.levelId)));
  const lvls = ids.length === 0 ? [] : await db.select({
    id: schema.levels.id, name: schema.levels.name, author: schema.levels.author,
  }).from(schema.levels).where(inArray(schema.levels.id, ids));
  const byId = new Map(lvls.map((l) => [l.id, l]));
  return c.json({
    entries: rows.map((r) => {
      const lvl = byId.get(r.levelId);
      return {
        utcDate: r.utcDate,
        levelId: r.levelId,
        addedBy: r.addedBy,
        promotedAt: r.promotedAt,
        name:   lvl ? lvl.name   : 'Featured level',
        author: lvl ? lvl.author : 'unknown',
      };
    }),
  });
});

featuredRoutes.get('/featured/level/:date', async (c) => {
  const utcDate = c.req.param('date')!;
  const row = await getByDate(utcDate);
  if (!row) return c.json({ error: 'not found' }, 404);
  const hydrated = await hydrateRow(row);
  if (!hydrated) return c.json({ error: 'not found' }, 404);
  return c.json({
    entry: {
      utcDate:    row.utcDate,
      levelId:    row.levelId,
      addedBy:    row.addedBy,
      promotedAt: row.promotedAt,
    },
    name:   hydrated.name,
    author: hydrated.author,
    level:  hydrated.level,
  });
});

// Hydrate a featured row with the full level body. Returns null when the
// underlying level row is missing or no longer public.
async function hydrateRow(row: FeaturedRow) {
  const [lvl] = await db.select().from(schema.levels)
    .where(eq(schema.levels.id, row.levelId)).limit(1);
  if (!lvl) return null;
  if (lvl.status !== 'public') return null;
  const decoded = decodeShareString(lvl.shareCode);
  if (!decoded) return null;
  return { name: lvl.name, author: lvl.author, level: decoded };
}
