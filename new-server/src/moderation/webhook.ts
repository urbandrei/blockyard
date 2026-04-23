// Post a new submission to the moderators' review channel.
//
// We POST to `/channels/{id}/messages` using the bot token — NOT a
// manually-created channel webhook. This matters because Discord silently
// drops interactive components (buttons, modals) from messages sent via
// channel webhooks; only application-owned sources can attach them. The
// bot user IS application-owned, so the approve/deny/link buttons render
// and route back to /discord/interactions on click.

import { env } from '../env.js';
import { buildSubmissionEmbed, buildReviewButtons } from './embed.js';
import { levels } from '../db/schema.js';

type LevelRow = typeof levels.$inferSelect;

const DISCORD_API = 'https://discord.com/api/v10';

export async function postSubmission(rec: LevelRow): Promise<string | null> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CHANNEL_ID) {
    console.warn('[discord] DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID not set — skipping post');
    return null;
  }

  const res = await fetch(`${DISCORD_API}/channels/${env.DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      embeds: [buildSubmissionEmbed(rec)],
      components: [buildReviewButtons(rec.id)],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`discord channel POST ${res.status}: ${txt}`);
  }
  const msg = await res.json().catch(() => null) as { id?: string } | null;
  return msg?.id ?? null;
}
