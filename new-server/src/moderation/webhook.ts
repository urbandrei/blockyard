// Outbound moderation post via the channel's incoming webhook. We use
// ?wait=true to get the message id back (so later admin tooling could edit
// the message), but normal approve/deny flows update the message inline
// via Discord's UPDATE_MESSAGE interaction response — no webhook PATCH
// needed for the happy path.

import { env } from '../env.js';
import { buildSubmissionEmbed, buildReviewButtons } from './embed.js';
import { levels } from '../db/schema.js';

type LevelRow = typeof levels.$inferSelect;

export async function postSubmission(rec: LevelRow): Promise<string | null> {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.warn('[discord] DISCORD_WEBHOOK_URL not set — skipping post');
    return null;
  }
  const url = new URL(env.DISCORD_WEBHOOK_URL);
  url.searchParams.set('wait', 'true');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [buildSubmissionEmbed(rec)],
      components: [buildReviewButtons(rec.id)],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`discord webhook ${res.status}: ${txt}`);
  }
  const msg = await res.json().catch(() => null) as { id?: string } | null;
  return msg?.id ?? null;
}
