// Anonymous play telemetry. Two endpoints:
//
//   POST  /plays            { kind, levelId } → { id }
//     Creates a session row owned by the calling token. Hint count + time
//     start at 0. The client gets back an id it patches on exit.
//
//   PATCH /plays/:id        { completed?, hintCount?, timeSpentMs? }
//     Idempotent end-of-session update. completed=true is sticky (a later
//     PATCH cannot un-complete). On the FIRST transition to completed for
//     a community session, levels.completions is bumped in the same
//     transaction so the listing query keeps reading a denormalized count.
//     Server clamps timeSpentMs into [0, 24h] so a forged client can't
//     poison aggregate dashboards.
//
// No FK on level_id — campaign ids ('level-7') aren't in the levels table,
// and we don't want a community-level delete to wipe historical telemetry
// (the cascade is on tokens, not levels).
//
// Anonymity: rows carry the calling token (so we can scope PATCHes), and
// nothing else. Multiple sessions per token are intentional — replays are
// genuine signal.

import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { requireToken } from '../auth/token.js';
import { rateLimit } from '../rateLimit.js';

export const playRoutes = new Hono();

const MAX_TIME_SPENT_MS = 24 * 60 * 60 * 1000; // 24h cap so a buggy/forged
                                               // client can't dump nonsense.
const MAX_HINT_COUNT    = 1000;                // any real run is < 50.

playRoutes.post('/plays', requireToken(), async (c) => {
  const { token } = c.get('auth');

  const gate = rateLimit.checkPlay(token);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await c.req.json().catch(() => null) as { kind?: unknown; levelId?: unknown } | null;
  const kind = body?.kind === 'campaign' || body?.kind === 'community' ? body.kind : null;
  const levelId = typeof body?.levelId === 'string' ? body.levelId.trim() : '';
  if (!kind) return c.json({ error: 'kind must be "campaign" or "community"' }, 400);
  if (!levelId || levelId.length > 200) return c.json({ error: 'invalid levelId' }, 400);

  const now = Date.now();
  const [row] = await db.insert(schema.plays).values({
    kind,
    levelId,
    anonToken: token,
    openedAt: now,
    completedAt: null,
    hintCount: 0,
    timeSpentMs: 0,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: schema.plays.id });

  return c.json({ id: row!.id }, 201);
});

playRoutes.patch('/plays/:id', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const id = c.req.param('id')!;

  const gate = rateLimit.checkPlay(token);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await c.req.json().catch(() => null) as {
    completed?: unknown; hintCount?: unknown; timeSpentMs?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const wantCompleted = body.completed === true;
  const hintCount = typeof body.hintCount === 'number' && Number.isFinite(body.hintCount)
    ? Math.max(0, Math.min(MAX_HINT_COUNT, Math.floor(body.hintCount)))
    : null;
  const timeSpentMs = typeof body.timeSpentMs === 'number' && Number.isFinite(body.timeSpentMs)
    ? Math.max(0, Math.min(MAX_TIME_SPENT_MS, Math.floor(body.timeSpentMs)))
    : null;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.plays)
      .where(and(eq(schema.plays.id, id), eq(schema.plays.anonToken, token)))
      .limit(1);
    if (!row) return null;

    const now = Date.now();
    const isFirstCompletion = wantCompleted && row.completedAt == null;

    // hintCount: monotonic — never decrease. Lets retried PATCHes (e.g. a
    // shutdown handler that fires twice on scene-swap + page-unload) be
    // safely idempotent without losing counts.
    const nextHints = hintCount != null ? Math.max(row.hintCount, hintCount) : row.hintCount;
    const nextTime  = timeSpentMs != null ? Math.max(row.timeSpentMs, timeSpentMs) : row.timeSpentMs;

    await tx.update(schema.plays).set({
      hintCount:    nextHints,
      timeSpentMs:  nextTime,
      // completed_at is sticky — once set, never cleared.
      completedAt:  row.completedAt ?? (wantCompleted ? now : null),
      updatedAt:    now,
    }).where(eq(schema.plays.id, id));

    // Bump the denormalized counter ONLY on the first transition for a
    // community level — campaign levels don't have a `levels` row, and
    // re-PATCHing the same session must not double-count.
    if (isFirstCompletion && row.kind === 'community') {
      await tx.update(schema.levels)
        .set({ completions: sql`${schema.levels.completions} + 1`, updatedAt: now })
        .where(eq(schema.levels.id, row.levelId));
    }

    return { id, completed: row.completedAt != null || wantCompleted };
  });

  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json(result);
});

// Anti-leak guard: do not expose a public read of arbitrary play rows.
// Aggregate views are served by the Discord /stats command path, which
// reads the table directly via db, not by hitting any HTTP endpoint here.
void isNull;
