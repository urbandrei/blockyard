// Inbound Discord Interactions handler. Discord calls POST /discord/interactions
// when a moderator clicks a button or submits the deny-reason modal. We
// verify the Ed25519 signature (required by Discord — any unverified
// requests are rejected), then dispatch based on interaction + custom_id.
//
// The three user-visible flows:
//   Approve  → flip status to 'public', respond with UPDATE_MESSAGE
//              replacing the button row with a copy-only row.
//   Deny     → respond with a MODAL asking for a reason; on modal submit,
//              flip to 'rejected', UPDATE_MESSAGE with the reason visible.
//   Copy     → respond with an ephemeral message containing the share-string.
//
// All three run synchronously inside Discord's 3-second response window.

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';
import { env } from '../env.js';
import { db, schema } from '../db/client.js';
import { buildSubmissionEmbed, buildCopyOnlyRow } from './embed.js';

export const discordRoutes = new Hono();

discordRoutes.post('/discord/interactions', async (c) => {
  if (!env.DISCORD_PUBLIC_KEY) return c.text('interactions not configured', 503);

  const signature = c.req.header('x-signature-ed25519');
  const timestamp = c.req.header('x-signature-timestamp');
  if (!signature || !timestamp) return c.text('missing signature headers', 401);

  // verifyKey needs the raw body text — read it before any JSON parsing.
  const raw = await c.req.text();
  const valid = await verifyKey(raw, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!valid) return c.text('invalid request signature', 401);

  const interaction = JSON.parse(raw) as DiscordInteraction;

  if (interaction.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    return handleComponent(c, interaction);
  }

  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    return handleModalSubmit(c, interaction);
  }

  return c.json({ error: 'unsupported interaction type' }, 400);
});

// ---- component (button) dispatch ----

async function handleComponent(c: any, interaction: DiscordInteraction) {
  const customId = interaction.data?.custom_id ?? '';
  const [ns, action, id] = customId.split(':');
  if (ns !== 'by' || !id) return c.json(ephemeralText('unknown component'));

  const moderator = interaction.member?.user?.username ?? interaction.user?.username ?? 'unknown';

  if (action === 'approve') return approve(c, id, moderator);
  if (action === 'deny')    return openDenyModal(c, id);
  if (action === 'link')    return socialLink(c, id);
  return c.json(ephemeralText('unknown action'));
}

async function approve(c: any, levelId: string, moderator: string) {
  const [updated] = await db.update(schema.levels)
    .set({ status: 'public', approvedBy: moderator, updatedAt: Date.now() })
    .where(eq(schema.levels.id, levelId))
    .returning();
  if (!updated) return c.json(ephemeralText('level not found'));
  return c.json({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      embeds: [buildSubmissionEmbed(updated)],
      components: [buildCopyOnlyRow(levelId)],
    },
  });
}

function openDenyModal(c: any, levelId: string) {
  return c.json({
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: `by:denyReason:${levelId}`,
      title: 'Deny level',
      components: [{
        type: 1,
        components: [{
          type: 4,                          // TEXT_INPUT
          custom_id: 'reason',
          label: 'Reason (moderators only)',
          style: 2,                          // PARAGRAPH
          required: true,
          max_length: 300,
        }],
      }],
    },
  });
}

// Build a self-contained deep-link URL — the share_code IS the level
// payload (base64 of the minified JSON), so the recipient's client decodes
// it inline without a server fetch. Works pre- and post-approval.
async function socialLink(c: any, levelId: string) {
  const [row] = await db.select({ shareCode: schema.levels.shareCode, name: schema.levels.name })
    .from(schema.levels).where(eq(schema.levels.id, levelId)).limit(1);
  if (!row) return c.json(ephemeralText('level not found'));

  const url = `${env.SHARE_BASE_URL.replace(/\/+$/, '')}/?play=${encodeURIComponent(row.shareCode)}`;
  return c.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: 64,                             // ephemeral
      content: `**${row.name}** — share link:\n${url}`,
    },
  });
}

// ---- modal submit (deny with reason) ----

async function handleModalSubmit(c: any, interaction: DiscordInteraction) {
  const customId = interaction.data?.custom_id ?? '';
  const [ns, action, id] = customId.split(':');
  if (ns !== 'by' || action !== 'denyReason' || !id) return c.json(ephemeralText('unknown modal'));

  const reason = findTextInput(interaction.data?.components, 'reason') ?? '';
  const moderator = interaction.member?.user?.username ?? interaction.user?.username ?? 'unknown';

  const [updated] = await db.update(schema.levels)
    .set({
      status: 'rejected',
      rejectedBy: moderator,
      rejectedReason: reason.slice(0, 300),
      updatedAt: Date.now(),
    })
    .where(eq(schema.levels.id, id))
    .returning();
  if (!updated) return c.json(ephemeralText('level not found'));

  return c.json({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      embeds: [buildSubmissionEmbed(updated)],
      components: [buildCopyOnlyRow(id)],
    },
  });
}

// ---- helpers ----

function ephemeralText(content: string) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64, content },
  };
}

// Discord sends modal inputs as a nested components array: each row wraps
// one TEXT_INPUT. Flatten to find the field by custom_id.
function findTextInput(components: DiscordComponent[] | undefined, customId: string): string | null {
  if (!components) return null;
  for (const row of components) {
    if (!row.components) continue;
    for (const field of row.components) {
      if (field.custom_id === customId) return field.value ?? null;
    }
  }
  return null;
}

// ---- minimal local types (we only need what we read) ----

interface DiscordInteraction {
  type: number;
  data?: {
    custom_id?: string;
    components?: DiscordComponent[];
  };
  member?: { user?: { username?: string } };
  user?: { username?: string };
}

interface DiscordComponent {
  type: number;
  custom_id?: string;
  value?: string;
  components?: DiscordComponent[];
}
