// Postgres-backed daily-featured-level store.
//
// Two tables:
//   featured_levels — one row per UTC day (the historical record).
//   featured_queue  — FIFO of upcoming featureds added by mods via the
//                     bot's /feature command.
//
// Rotation is lazy: every read of `getToday()` calls `rotateIfNeeded()`,
// which atomically pops the queue head and inserts a new featured_levels
// row IF the current UTC date doesn't yet have an entry. No cron needed.
//
// When `DATABASE_URL` is unset the store init() returns silently and all
// reads return null, so the rest of the server keeps working without a DB.

import pg from 'pg';

const { Pool } = pg;
type PgPool = pg.Pool;

export interface FeaturedRow {
  utcDate: string;     // YYYY-MM-DD
  levelId: string;
  addedBy: string;
  promotedAt: number;  // ms since epoch
}

export interface QueueRow {
  id: number;
  levelId: string;
  addedBy: string;
  queuedAt: number;
}

export class FeaturedStore {
  private pool: PgPool | null = null;
  private enabled = false;

  async init(databaseUrl: string | undefined): Promise<void> {
    if (!databaseUrl) {
      console.warn('[featured] DATABASE_URL not set — featured-level routes will return null');
      return;
    }
    this.pool = new Pool({
      connectionString: databaseUrl,
      // Render Postgres requires SSL; local dev DBs typically don't. Detect
      // by looking for sslmode in the URL — let the user override explicitly.
      ssl: /sslmode=require/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    // Bail loudly if the connection is broken so it's not a silent regression.
    this.pool.on('error', (err) => console.error('[featured] pool error', err));

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS featured_levels (
        utc_date    DATE PRIMARY KEY,
        level_id    TEXT NOT NULL,
        added_by    TEXT NOT NULL,
        promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS featured_queue (
        id        SERIAL PRIMARY KEY,
        level_id  TEXT NOT NULL UNIQUE,
        added_by  TEXT NOT NULL,
        queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    this.enabled = true;
    console.log('[featured] postgres ready (featured_levels + featured_queue)');
  }

  isEnabled(): boolean { return this.enabled; }

  /**
   * Lazy rotation. Inside a transaction:
   *   1. Check whether today (UTC) already has a featured row.
   *   2. If not, pop the head of featured_queue and insert it as today's row.
   *   3. If the queue is empty, no-op (today silently inherits whatever the
   *      most-recent row is, from `getToday()`'s fallback query).
   *
   * Idempotent — safe to call from multiple concurrent requests; the
   * SELECT FOR UPDATE on the queue head ensures only one wins the pop.
   */
  async rotateIfNeeded(): Promise<void> {
    if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Postgres `current_date` honors the session timezone. We force UTC
      // so the rotation lines up with the client's UTC streak math.
      await client.query(`SET LOCAL timezone TO 'UTC'`);
      const has = await client.query(
        `SELECT 1 FROM featured_levels WHERE utc_date = current_date`,
      );
      if (has.rowCount && has.rowCount > 0) { await client.query('COMMIT'); return; }

      // Lock + pop the queue head atomically.
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

  /**
   * Today's featured row. Falls back to the most recent row if the queue
   * was empty when this UTC day rolled over (so the client always has
   * *something* to display).
   */
  async getToday(): Promise<FeaturedRow | null> {
    if (!this.pool) return null;
    await this.rotateIfNeeded();
    const r = await this.pool.query(
      `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
       FROM featured_levels
       ORDER BY utc_date DESC LIMIT 1`,
    );
    if (!r.rowCount) return null;
    return rowToFeatured(r.rows[0]);
  }

  async getHistory(limit = 30): Promise<FeaturedRow[]> {
    if (!this.pool) return [];
    const n = Math.max(1, Math.min(100, limit | 0));
    const r = await this.pool.query(
      `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
       FROM featured_levels
       ORDER BY utc_date DESC LIMIT $1`,
      [n],
    );
    return r.rows.map(rowToFeatured);
  }

  async getByDate(utcDate: string): Promise<FeaturedRow | null> {
    if (!this.pool) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) return null;
    const r = await this.pool.query(
      `SELECT utc_date::text AS utc_date, level_id, added_by, promoted_at
       FROM featured_levels
       WHERE utc_date = $1::date`,
      [utcDate],
    );
    if (!r.rowCount) return null;
    return rowToFeatured(r.rows[0]);
  }

  /**
   * Append a level to the FIFO queue. Returns the queue position (1-based)
   * after the insert, or null if the level was already queued (UNIQUE
   * constraint dedupes).
   */
  async enqueue(levelId: string, addedBy: string): Promise<{ position: number } | null> {
    if (!this.pool) return null;
    const ins = await this.pool.query(
      `INSERT INTO featured_queue (level_id, added_by)
       VALUES ($1, $2)
       ON CONFLICT (level_id) DO NOTHING
       RETURNING id`,
      [levelId, addedBy],
    );
    if (!ins.rowCount) return null; // duplicate
    const cnt = await this.pool.query(`SELECT count(*)::int AS n FROM featured_queue`);
    return { position: cnt.rows[0].n as number };
  }

  /** Returns the next UTC midnight as ms-since-epoch — used by the client
   *  to drive the countdown timer next to the panel. */
  static nextRotateUtcMs(now = Date.now()): number {
    const d = new Date(now);
    d.setUTCHours(24, 0, 0, 0); // floor(today UTC) + 1 day
    return d.getTime();
  }
}

function rowToFeatured(row: any): FeaturedRow {
  return {
    utcDate: row.utc_date,
    levelId: row.level_id,
    addedBy: row.added_by,
    promotedAt: new Date(row.promoted_at).getTime(),
  };
}
