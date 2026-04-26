// Daily-featured-level store. Two tables:
//   featured_levels — one row per UTC day (the historical record).
//   featured_queue  — FIFO of upcoming featureds added by mods via the
//                     /feature slash command.
//
// Rotation is lazy: every read of getToday() calls rotateIfNeeded(), which
// atomically pops the queue head and inserts a new featured_levels row IF
// the current UTC date doesn't yet have an entry. No cron needed.
//
// Drizzle port of the original featuredStore.ts from the legacy server,
// kept structurally identical so the client API contract (today / history /
// by-date) doesn't drift.

import { eq } from 'drizzle-orm';
import { db, pool, schema } from '../db/client.js';

export interface FeaturedRow {
  utcDate: string;     // YYYY-MM-DD
  levelId: string;
  addedBy: string;
  promotedAt: number;  // ms since epoch
}

// Lazy rotation. Inside a transaction:
//   1. Check whether today (UTC) already has a featured row.
//   2. If not, pop the head of featured_queue and insert it as today's row.
//   3. If the queue is empty, no-op (today silently inherits whatever the
//      most-recent row is, from getToday()'s fallback query).
// Idempotent — safe to call from concurrent requests; the SELECT FOR UPDATE
// SKIP LOCKED on the queue head ensures only one wins the pop.
export async function rotateIfNeeded(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL timezone TO 'UTC'`);
    const has = await client.query(
      `SELECT 1 FROM featured_levels WHERE utc_date = current_date`,
    );
    if (has.rowCount && has.rowCount > 0) { await client.query('COMMIT'); return; }
    const popped = await client.query(
      `DELETE FROM featured_queue
       WHERE id = (
         SELECT id FROM featured_queue ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING level_id, added_by`,
    );
    if (popped.rowCount && popped.rowCount > 0) {
      const r = popped.rows[0];
      await client.query(
        `INSERT INTO featured_levels (utc_date, level_id, added_by)
         VALUES (current_date, $1, $2)
         ON CONFLICT (utc_date) DO NOTHING`,
        [r.level_id, r.added_by],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) {}
    throw err;
  } finally {
    client.release();
  }
}

export async function getToday(): Promise<FeaturedRow | null> {
  await rotateIfNeeded();
  const r = await pool.query(
    `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
     FROM featured_levels
     ORDER BY utc_date DESC LIMIT 1`,
  );
  if (!r.rowCount) return null;
  return rowToFeatured(r.rows[0]);
}

export async function getHistory(limit = 30): Promise<FeaturedRow[]> {
  const n = Math.max(1, Math.min(100, limit | 0));
  const r = await pool.query(
    `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
     FROM featured_levels
     ORDER BY utc_date DESC LIMIT $1`,
    [n],
  );
  return r.rows.map(rowToFeatured);
}

export async function getByDate(utcDate: string): Promise<FeaturedRow | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) return null;
  const r = await pool.query(
    `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
     FROM featured_levels
     WHERE utc_date = $1::date`,
    [utcDate],
  );
  if (!r.rowCount) return null;
  return rowToFeatured(r.rows[0]);
}

// Append a level to the FIFO queue. Returns the queue position (1-based)
// after the insert, or null if the level was already queued (UNIQUE
// constraint dedupes).
export async function enqueue(levelId: string, addedBy: string): Promise<{ position: number } | null> {
  const ins = await pool.query(
    `INSERT INTO featured_queue (level_id, added_by)
     VALUES ($1, $2)
     ON CONFLICT (level_id) DO NOTHING
     RETURNING id`,
    [levelId, addedBy],
  );
  if (!ins.rowCount) return null;
  const cnt = await pool.query(`SELECT count(*)::int AS n FROM featured_queue`);
  return { position: cnt.rows[0].n as number };
}

// Remove a level from the queue and (optionally) clear today's row if it
// matches. Returns flags indicating what was removed so the caller can
// produce an informative reply.
export async function dequeue(levelId: string): Promise<{ fromQueue: boolean; fromToday: boolean }> {
  const fromQueue = await db.delete(schema.featuredQueue)
    .where(eq(schema.featuredQueue.levelId, levelId))
    .returning({ id: schema.featuredQueue.id });
  // Clear a featured_levels row for today's UTC date if it points at this
  // level. Past historical rows are not touched — those are an audit log.
  const fromTodayRes = await pool.query(
    `DELETE FROM featured_levels
     WHERE utc_date = (current_date AT TIME ZONE 'UTC')::date
       AND level_id = $1
     RETURNING utc_date`,
    [levelId],
  );
  return {
    fromQueue: fromQueue.length > 0,
    fromToday: !!(fromTodayRes.rowCount && fromTodayRes.rowCount > 0),
  };
}

// All historical featured rows, oldest to newest. Used by the
// /featured-list slash command. Capped at 200 so a long-running game
// doesn't try to spam the entire history into one Discord message.
export async function getAllHistoryAsc(): Promise<FeaturedRow[]> {
  const r = await pool.query(
    `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
     FROM featured_levels
     ORDER BY utc_date ASC LIMIT 200`,
  );
  return r.rows.map(rowToFeatured);
}

// Next UTC-midnight as ms-since-epoch. Drives the client's countdown
// timer beside the featured panel.
export function nextRotateUtcMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function rowToFeatured(row: any): FeaturedRow {
  return {
    utcDate: row.utc_date,
    levelId: row.level_id,
    addedBy: row.added_by,
    promotedAt: new Date(row.promoted_at).getTime(),
  };
}
