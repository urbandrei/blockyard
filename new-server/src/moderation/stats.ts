// /stats Discord slash-command handlers. Three subcommands:
//
//   /stats level    id:<community-uuid | campaign-id>
//     Single-level rollup: opens, completions, completion rate, avg time
//     spent, total hints used.
//
//   /stats top      kind:<campaign|community> [metric:<plays|completions>]
//     Top 10 by chosen metric (default: completions).
//
//   /stats campaign
//     Per-section campaign rollup — opens + completions + completion rate
//     for each authored level. Truncated to fit Discord's 2000-char limit.
//
// All responses are ephemeral (flags=64) so they don't pollute the channel
// for the moderator group. None of these commands write — they're purely
// aggregate reads against the plays table + denormalized levels.completions.

import { and, desc, eq, sql } from 'drizzle-orm';
import { InteractionResponseType } from 'discord-interactions';
import { db, schema } from '../db/client.js';
import type { DiscordCommandOption, DiscordInteractionLite } from './interactions.js';

const TOP_N = 10;

export async function handleStatsCommand(c: any, interaction: DiscordInteractionLite) {
  const sub = (interaction.data?.options ?? [])[0];
  if (!sub || sub.type !== 1) return ephemeral('expected a /stats subcommand');
  if (sub.name === 'level')    return statsLevel(c, sub.options ?? []);
  if (sub.name === 'top')      return statsTop(c, sub.options ?? []);
  if (sub.name === 'campaign') return statsCampaign(c);
  return ephemeral(`unknown subcommand: ${sub.name}`);

  function ephemeral(content: string) {
    return c.json(ephemeralText(content));
  }
}

// /stats level id:<level_id>
async function statsLevel(c: any, options: DiscordCommandOption[]) {
  const id = String(options.find((o) => o.name === 'id')?.value ?? '').trim();
  if (!id) return c.json(ephemeralText('missing `id` option'));

  // Try community first (level_id matches a UUID in `levels`); fall through
  // to campaign rollup otherwise. We don't bind on `kind` here because the
  // caller may not know — the id space is disjoint (campaign uses 'level-N',
  // community uses uuids), so any single hit is unambiguous.
  const [agg] = await db.select({
    opens: sql<number>`COUNT(*)::int`,
    completions: sql<number>`SUM(CASE WHEN ${schema.plays.completedAt} IS NOT NULL THEN 1 ELSE 0 END)::int`,
    avgTimeMs: sql<number>`COALESCE(AVG(${schema.plays.timeSpentMs}), 0)::int`,
    totalHints: sql<number>`COALESCE(SUM(${schema.plays.hintCount}), 0)::int`,
  }).from(schema.plays).where(eq(schema.plays.levelId, id));

  if (!agg || agg.opens === 0) {
    return c.json(ephemeralText(`no plays recorded for \`${id}\``));
  }

  const [community] = await db.select({
    name: schema.levels.name,
    author: schema.levels.author,
    completions: schema.levels.completions,
  }).from(schema.levels).where(eq(schema.levels.id, id)).limit(1);

  const header = community
    ? `**${community.name}** by *${community.author}* (community \`${id}\`)`
    : `Campaign level \`${id}\``;
  const rate = agg.opens > 0 ? Math.round((agg.completions / agg.opens) * 100) : 0;
  const avgSec = Math.round(agg.avgTimeMs / 1000);

  const lines = [
    header,
    `• Opens: **${agg.opens}**`,
    `• Completions: **${agg.completions}**  (rate ${rate}%)`,
    `• Avg time per session: **${formatDuration(avgSec)}**`,
    `• Total hints used: **${agg.totalHints}**`,
  ];
  if (community) {
    lines.push(`• Denormalized counter: **${community.completions}**` +
      (community.completions !== agg.completions ? '  (drift — see below)' : ''));
  }
  return c.json(ephemeralText(lines.join('\n')));
}

// /stats top kind:<campaign|community> [metric:<plays|completions>]
async function statsTop(c: any, options: DiscordCommandOption[]) {
  const kindRaw = String(options.find((o) => o.name === 'kind')?.value ?? '');
  const kind = kindRaw === 'campaign' || kindRaw === 'community' ? kindRaw : null;
  if (!kind) return c.json(ephemeralText('`kind` must be `campaign` or `community`'));

  const metric = String(options.find((o) => o.name === 'metric')?.value ?? 'completions');
  const orderCol = metric === 'plays'
    ? sql<number>`COUNT(*)::int`
    : sql<number>`SUM(CASE WHEN ${schema.plays.completedAt} IS NOT NULL THEN 1 ELSE 0 END)::int`;

  const rows = await db.select({
    levelId: schema.plays.levelId,
    opens: sql<number>`COUNT(*)::int`,
    completions: sql<number>`SUM(CASE WHEN ${schema.plays.completedAt} IS NOT NULL THEN 1 ELSE 0 END)::int`,
  }).from(schema.plays)
    .where(eq(schema.plays.kind, kind))
    .groupBy(schema.plays.levelId)
    .orderBy(desc(orderCol))
    .limit(TOP_N);

  if (rows.length === 0) return c.json(ephemeralText(`no ${kind} plays recorded yet`));

  // For community, look up names to make the embed readable. Single batch
  // query — campaign ids are skipped here because they're already
  // human-readable ('level-7') and not in the levels table.
  const nameMap = new Map<string, string>();
  if (kind === 'community') {
    const ids = rows.map((r) => r.levelId);
    const lookup = await db.select({ id: schema.levels.id, name: schema.levels.name, author: schema.levels.author })
      .from(schema.levels);
    for (const l of lookup) {
      if (ids.includes(l.id)) nameMap.set(l.id, `${l.name} — ${l.author}`);
    }
  }

  const lines = [`**Top ${rows.length} ${kind} levels by ${metric}:**`];
  rows.forEach((r, i) => {
    const label = kind === 'community' ? (nameMap.get(r.levelId) ?? '(deleted)') : r.levelId;
    lines.push(`${i + 1}. \`${r.levelId}\` ${label} — ${r.opens} opens, ${r.completions} completions`);
  });
  return c.json(ephemeralText(truncate(lines.join('\n'), 1900)));
}

// /stats campaign — per-level campaign rollup
async function statsCampaign(c: any) {
  const rows = await db.select({
    levelId: schema.plays.levelId,
    opens: sql<number>`COUNT(*)::int`,
    completions: sql<number>`SUM(CASE WHEN ${schema.plays.completedAt} IS NOT NULL THEN 1 ELSE 0 END)::int`,
    totalHints: sql<number>`COALESCE(SUM(${schema.plays.hintCount}), 0)::int`,
  }).from(schema.plays)
    .where(eq(schema.plays.kind, 'campaign'))
    .groupBy(schema.plays.levelId);

  if (rows.length === 0) return c.json(ephemeralText('no campaign plays recorded yet'));

  // Sort using the embedded numeric suffix (level-7 → 7), bosses last.
  rows.sort((a, b) => sortKey(a.levelId) - sortKey(b.levelId));

  const lines = ['**Campaign rollup:**', '`level    | opens | done | rate | hints`'];
  for (const r of rows) {
    const rate = r.opens > 0 ? Math.round((r.completions / r.opens) * 100) : 0;
    const id = r.levelId.padEnd(8);
    const opens = String(r.opens).padStart(5);
    const done  = String(r.completions).padStart(4);
    const ratePad = String(rate + '%').padStart(4);
    const hints = String(r.totalHints).padStart(5);
    lines.push(`\`${id} | ${opens} | ${done} | ${ratePad} | ${hints}\``);
  }
  return c.json(ephemeralText(truncate(lines.join('\n'), 1900)));
}

// "level-7" → 7, "level-12" → 12, "boss-1" → 10001 (sort bosses to the end).
function sortKey(id: string): number {
  const m = id.match(/^level-(\d+)$/);
  if (m) return parseInt(m[1]!, 10);
  const b = id.match(/^boss-(\d+)$/);
  if (b) return 10000 + parseInt(b[1]!, 10);
  return 100000;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function ephemeralText(content: string) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64, content },
  };
}

// Suppress unused-import diagnostic for `and` if not all branches use it.
void and;
