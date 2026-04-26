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
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { decodeShareString } from '../share.js';
import { getToday, getHistory, getByDate, type FeaturedRow } from '../moderation/featuredStore.js';

export const featuredRoutes = new Hono();

featuredRoutes.get('/featured/today', async (c) => {
  const row = await getToday();
  if (!row) return c.json(null);
  const payload = await rowWithLevel(row);
  return c.json(payload);
});

featuredRoutes.get('/featured/history', async (c) => {
  const limitParam = c.req.query('limit');
  const limit = Math.max(1, Math.min(100, parseInt(limitParam ?? '30', 10) || 30));
  const rows = await getHistory(limit);
  // History entries don't carry the full level body — the client uses this
  // for the streak strip + a "tap a past day" affordance that fetches the
  // body on demand via /featured/level/:date. Keeps the response small.
  return c.json({
    entries: rows.map((r) => ({
      utcDate: r.utcDate,
      levelId: r.levelId,
      addedBy: r.addedBy,
      promotedAt: r.promotedAt,
    })),
  });
});

featuredRoutes.get('/featured/level/:date', async (c) => {
  const utcDate = c.req.param('date')!;
  const row = await getByDate(utcDate);
  if (!row) return c.json({ error: 'not found' }, 404);
  const payload = await rowWithLevel(row);
  if (!payload) return c.json({ error: 'not found' }, 404);
  return c.json(payload);
});

// Hydrate a featured row with the full level body. If the underlying level
// has been removed / unpublished since being featured, returns null so the
// client can hide the panel cleanly.
async function rowWithLevel(row: FeaturedRow) {
  const [lvl] = await db.select().from(schema.levels)
    .where(eq(schema.levels.id, row.levelId)).limit(1);
  if (!lvl) return null;
  if (lvl.status !== 'public') return null;
  const decoded = decodeShareString(lvl.shareCode);
  if (!decoded) return null;
  return {
    utcDate: row.utcDate,
    levelId: row.levelId,
    addedBy: row.addedBy,
    promotedAt: row.promotedAt,
    name: lvl.name,
    author: lvl.author,
    level: decoded,
  };
}
