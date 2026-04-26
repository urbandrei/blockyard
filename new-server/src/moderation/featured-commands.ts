// Handlers for the four moderator slash commands that work over a level's
// share link (any format — see levelLookup.ts):
//
//   /feature        share:<…>     — queue a public level for the next daily rotation.
//   /unpublish      share:<…>     — flip a public level to 'rejected' so it disappears
//                                   from public listings (search + featured panel).
//   /featured-list                — every historical featured pick, oldest → newest,
//                                   each as a short link.
//   /feature-remove share:<…>     — drop a level from the queue and from today's row
//                                   if it's currently featured.
//
// All replies are ephemeral (flag 64) so they don't pollute the moderator
// channel for everyone else.

import { eq, inArray } from 'drizzle-orm';
import { InteractionResponseType } from 'discord-interactions';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { enqueue, dequeue, getAllHistoryAsc } from './featuredStore.js';
import { resolveLevelIdFromInput } from './levelLookup.js';
import { getOrCreateShortCode } from '../routes/shorts.js';
import type { DiscordCommandOption, DiscordInteractionLite } from './interactions.js';

// ---- /feature -------------------------------------------------------------

export async function handleFeatureCommand(c: any, interaction: DiscordInteractionLite) {
  const moderator = interaction.member?.user?.username ?? interaction.user?.username ?? 'unknown';
  const raw = String(((interaction.data?.options ?? []) as DiscordCommandOption[])
    .find((o) => o.name === 'share')?.value ?? '').trim();
  if (!raw) return c.json(ephemeralText('missing `share` option'));

  const levelId = await resolveLevelIdFromInput(raw);
  if (!levelId) return c.json(ephemeralText(`Could not resolve a level from \`${truncate(raw, 80)}\`.`));

  const [row] = await db.select({
    id: schema.levels.id,
    name: schema.levels.name,
    author: schema.levels.author,
    status: schema.levels.status,
  }).from(schema.levels).where(eq(schema.levels.id, levelId)).limit(1);
  if (!row) return c.json(ephemeralText(`No level with id \`${levelId}\` on the server.`));
  if (row.status !== 'public') {
    return c.json(ephemeralText(`Level **${row.name}** is **${row.status}** — only public levels can be featured.`));
  }

  const result = await enqueue(levelId, moderator);
  if (!result) {
    return c.json(ephemeralText(`**${row.name}** by ${row.author} is already in the queue.`));
  }
  return c.json(ephemeralText(
    `Queued **${row.name}** by ${row.author} at position **${result.position}**.`,
  ));
}

// ---- /unpublish -----------------------------------------------------------

export async function handleUnpublishCommand(c: any, interaction: DiscordInteractionLite) {
  const moderator = interaction.member?.user?.username ?? interaction.user?.username ?? 'unknown';
  const raw = String(((interaction.data?.options ?? []) as DiscordCommandOption[])
    .find((o) => o.name === 'share')?.value ?? '').trim();
  if (!raw) return c.json(ephemeralText('missing `share` option'));

  const levelId = await resolveLevelIdFromInput(raw);
  if (!levelId) return c.json(ephemeralText(`Could not resolve a level from \`${truncate(raw, 80)}\`.`));

  const [row] = await db.select({
    name: schema.levels.name, author: schema.levels.author, status: schema.levels.status,
  }).from(schema.levels).where(eq(schema.levels.id, levelId)).limit(1);
  if (!row) return c.json(ephemeralText(`No level with id \`${levelId}\` on the server.`));
  if (row.status !== 'public') {
    return c.json(ephemeralText(`Level **${row.name}** is already **${row.status}** — nothing to unpublish.`));
  }

  // Flip status to 'rejected' so the level drops out of public search +
  // the featured panel (which filters for status === 'public'). Stash the
  // moderator and a synthetic reason so /my/submissions surfaces it on
  // the author's next visit.
  await db.update(schema.levels)
    .set({
      status: 'rejected',
      rejectedBy: moderator,
      rejectedReason: 'Unpublished by moderator after going public.',
      updatedAt: Date.now(),
    })
    .where(eq(schema.levels.id, levelId));

  // If the level is currently in today's featured row or the queue, clear
  // those too — keeping a featured-but-unpublished level around would
  // cause /featured/today to return null without explaining why.
  await dequeue(levelId);

  return c.json(ephemeralText(
    `Unpublished **${row.name}** by ${row.author}. The author will see the rejection on their next community-scene entry.`,
  ));
}

// ---- /featured-list -------------------------------------------------------

export async function handleFeaturedListCommand(c: any, _interaction: DiscordInteractionLite) {
  const rows = await getAllHistoryAsc();
  if (rows.length === 0) {
    return c.json(ephemeralText('No featured levels yet.'));
  }
  const base = env.SHARE_BASE_URL.replace(/\/+$/, '');
  // Hydrate each historical row with the level's name + share code so we
  // can produce a short link. Levels that have since been deleted are
  // shown as `(deleted)` to preserve the date-by-date audit trail.
  const ids = Array.from(new Set(rows.map((r) => r.levelId)));
  const levels = ids.length === 0 ? [] : await db.select({
    id: schema.levels.id,
    name: schema.levels.name,
    author: schema.levels.author,
    shareCode: schema.levels.shareCode,
    status: schema.levels.status,
  }).from(schema.levels).where(inArray(schema.levels.id, ids));
  const byId = new Map(levels.map((l) => [l.id, l]));

  const built: string[] = [];
  for (const r of rows) {
    const lvl = byId.get(r.levelId);
    if (!lvl) {
      built.push(`• \`${r.utcDate}\` — *(deleted)* — added by ${r.addedBy}`);
      continue;
    }
    let link: string;
    try {
      const code = await getOrCreateShortCode(lvl.shareCode);
      link = `${base}/?s=${code}`;
    } catch (e) {
      // Shorten failed — fall back to the long URL so the mod still has
      // a working link to verify with.
      console.error('[featured-list] short link failed', e);
      link = `${base}/?play=${encodeURIComponent(lvl.shareCode)}`;
    }
    const tag = lvl.status === 'public' ? '' : ` _(${lvl.status})_`;
    built.push(`• \`${r.utcDate}\` — **${lvl.name}** by ${lvl.author}${tag}\n  ${link}`);
  }

  // Discord caps message content at 2000 chars. Trim OLDEST entries first
  // so the moderator always sees the most recent picks in chronological
  // order, with a note when we had to drop older rows.
  const HEADER = '**Featured levels (oldest → newest):**';
  const FOOTER_NOTE = '_(older entries trimmed to fit Discord\u2019s 2000-char limit)_';
  const MAX = 1900;
  let total = HEADER.length + 1;
  for (const line of built) total += line.length + 1;
  let trimmed = false;
  while (total > MAX && built.length > 0) {
    const removed = built.shift();
    if (removed) { total -= removed.length + 1; trimmed = true; }
  }
  const lines = [HEADER];
  if (trimmed) lines.push(FOOTER_NOTE);
  lines.push(...built);
  return c.json(ephemeralText(lines.join('\n')));
}

// ---- /feature-remove ------------------------------------------------------

export async function handleFeatureRemoveCommand(c: any, interaction: DiscordInteractionLite) {
  const raw = String(((interaction.data?.options ?? []) as DiscordCommandOption[])
    .find((o) => o.name === 'share')?.value ?? '').trim();
  if (!raw) return c.json(ephemeralText('missing `share` option'));

  const levelId = await resolveLevelIdFromInput(raw);
  if (!levelId) return c.json(ephemeralText(`Could not resolve a level from \`${truncate(raw, 80)}\`.`));

  const result = await dequeue(levelId);
  if (!result.fromQueue && !result.fromToday) {
    return c.json(ephemeralText(`Level \`${levelId}\` wasn't queued or featured today — nothing to remove.`));
  }
  const parts: string[] = [];
  if (result.fromQueue) parts.push('queue');
  if (result.fromToday) parts.push("today's featured row");
  return c.json(ephemeralText(`Removed level \`${levelId}\` from ${parts.join(' + ')}.`));
}

// ---- helpers --------------------------------------------------------------

function ephemeralText(content: string) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64, content },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
