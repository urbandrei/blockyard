// Public level search + fetch, plus the authenticated publish path.
// Publish writes the DB row inside a transaction, then fires the Discord
// webhook to announce the submission (best-effort — we don't fail the
// request if Discord is down).

import { Hono } from 'hono';
import { and, eq, sql, desc, asc } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { requireToken } from '../auth/token.js';
import { rateLimit } from '../rateLimit.js';
import { encodeShareString, decodeShareString } from '../share.js';
import { postSubmission } from '../moderation/webhook.js';
import type { IndexEntry, LevelDetail, LevelStatus, SearchResult, SortOption } from '../types.js';

export const levelRoutes = new Hono();

// ---- GET /levels (public search) ----

levelRoutes.get('/levels', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const sortParam = c.req.query('sort') as SortOption | undefined;
  const sort: SortOption = sortParam === 'likesDesc' || sortParam === 'likesAsc' || sortParam === 'ratingDesc'
    ? sortParam
    : 'recent';
  const page = Math.max(0, parseInt(c.req.query('page') ?? '0', 10) || 0);
  const pageSize = Math.max(1, Math.min(50, parseInt(c.req.query('pageSize') ?? '20', 10) || 20));

  const matchesPublic = eq(schema.levels.status, 'public');
  const matchesQuery = q
    ? sql`(LOWER(${schema.levels.name}) LIKE ${'%' + q.toLowerCase() + '%'}
         OR LOWER(${schema.levels.author}) LIKE ${'%' + q.toLowerCase() + '%'})`
    : undefined;
  const where = matchesQuery ? and(matchesPublic, matchesQuery) : matchesPublic;

  const orderBy =
    sort === 'likesDesc'  ? [desc(schema.levels.likes),     desc(schema.levels.createdAt)] :
    sort === 'likesAsc'   ? [asc(schema.levels.likes),      desc(schema.levels.createdAt)] :
    sort === 'ratingDesc' ? [
      sql`CASE WHEN ${schema.levels.ratingCount} = 0 THEN 1 ELSE 0 END`,
      sql`(CAST(${schema.levels.ratingSum} AS REAL) / GREATEST(${schema.levels.ratingCount}, 1)) DESC`,
      desc(schema.levels.createdAt),
    ] :                    [desc(schema.levels.createdAt)];

  const [totalRow] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(schema.levels)
    .where(where);
  const total = totalRow?.n ?? 0;

  const rows = await db
    .select()
    .from(schema.levels)
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset(page * pageSize);

  const entries: IndexEntry[] = rows.map(rowToEntry);
  const result: SearchResult = {
    levels: entries,
    hasMore: page * pageSize + entries.length < total,
    total,
  };
  return c.json(result);
});

// ---- GET /levels/:id ----

levelRoutes.get('/levels/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.select().from(schema.levels).where(eq(schema.levels.id, id)).limit(1);
  if (!row || row.status !== 'public') return c.json({ error: 'not found' }, 404);
  const decoded = decodeShareString(row.shareCode);
  if (!decoded) return c.json({ error: 'corrupt level' }, 500);
  const body: LevelDetail = {
    id: row.id,
    name: row.name,
    author: row.author,
    hint: row.hint,
    cols: row.cols,
    rows: row.rows,
    status: row.status,
    likes: row.likes,
    ratingAvg: row.ratingCount > 0 ? row.ratingSum / row.ratingCount : null,
    ratingCount: row.ratingCount,
    completions: row.completions,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    level: decoded,
  };
  return c.json(body);
});

// ---- POST /levels (publish) ----

// ---- DELETE /levels/:id (author-only) ----
//
// Authenticated by token — must match the submitted_by_token on the row.
// Cascades to likes/ratings via the FK ON DELETE CASCADE declarations.
// Short-links keyed by share_code are deliberately not touched here —
// they're content-addressed, not level-addressed, and already-shared
// deep links should keep resolving as plain `?play=` URLs.
levelRoutes.delete('/levels/:id', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const id = c.req.param('id')!;

  const [row] = await db.select({ submittedByToken: schema.levels.submittedByToken })
    .from(schema.levels).where(eq(schema.levels.id, id)).limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.submittedByToken !== token) return c.json({ error: 'forbidden' }, 403);

  await db.delete(schema.levels).where(eq(schema.levels.id, id));
  return c.body(null, 204);
});

levelRoutes.post('/levels', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const ip = clientIp(c.req.header('cf-connecting-ip'), c.req.header('x-forwarded-for'));

  const gate = rateLimit.checkPublish(token, ip);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await safeJson(c);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);

  const meta = extractMeta(body);
  if (!meta) return c.json({ error: 'level missing name/author/board' }, 400);

  // Stamp the embedded id + status before encoding so the share-string
  // round-trips consistently if someone re-imports it via Discord Copy Code.
  const { id, rec } = await db.transaction(async (tx) => {
    const now = Date.now();
    const levelForShare = { ...body, status: 'pending' as LevelStatus };
    const [inserted] = await tx.insert(schema.levels).values({
      status: 'pending',
      author: meta.author,
      name: meta.name,
      hint: meta.hint,
      cols: meta.cols,
      rows: meta.rows,
      createdAt: now,
      updatedAt: now,
      submittedByToken: token,
      submittedFromIp: ip,
      // placeholder — we re-encode with the server-assigned id right after
      shareCode: '',
    }).returning();
    if (!inserted) throw new Error('insert failed');
    const shareCode = encodeShareString({ ...levelForShare, id: inserted.id });
    const [updated] = await tx
      .update(schema.levels)
      .set({ shareCode })
      .where(eq(schema.levels.id, inserted.id))
      .returning();
    return { id: inserted.id, rec: updated! };
  });

  // Fire-and-await so the Discord message id makes it into the row before
  // we respond. Best-effort: a Discord outage shouldn't fail the publish.
  try {
    const messageId = await postSubmission(rec);
    if (messageId) {
      await db.update(schema.levels)
        .set({ discordMessageId: messageId })
        .where(eq(schema.levels.id, id));
    }
  } catch (err) {
    console.error('[discord] postSubmission failed', err);
  }

  return c.json({ id, status: 'pending' as LevelStatus }, 201);
});

// ---- helpers ----

function rowToEntry(r: typeof schema.levels.$inferSelect): IndexEntry {
  return {
    id: r.id,
    name: r.name,
    author: r.author,
    hint: r.hint,
    cols: r.cols,
    rows: r.rows,
    status: r.status,
    likes: r.likes,
    ratingAvg: r.ratingCount > 0 ? r.ratingSum / r.ratingCount : null,
    ratingCount: r.ratingCount,
    completions: r.completions,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

function clientIp(cfIp: string | undefined, xff: string | undefined): string | null {
  const raw = cfIp ?? xff;
  if (!raw) return null;
  return raw.split(',')[0]!.trim() || null;
}

async function safeJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}

function extractMeta(body: any): { name: string; author: string; hint: string | null; cols: number; rows: number } | null {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const author = typeof body.author === 'string' ? body.author.trim() : '';
  const hintRaw = typeof body.instructionalText === 'string' ? body.instructionalText.trim() : '';
  const cols = Number(body?.board?.cols);
  const rows = Number(body?.board?.rows);
  if (!name || !author || !Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    name: name.slice(0, 80),
    author: author.slice(0, 40),
    hint: hintRaw ? hintRaw.slice(0, 200) : null,
    cols, rows,
  };
}
