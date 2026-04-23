// Plain Discord embed + component JSON builders. We deliberately avoid
// `discord.js` here — interactions are handled over HTTPS so there's no
// gateway/websocket client to pull in.

import { levels } from '../db/schema.js';
import { decodeShareString } from '../share.js';

type LevelRow = typeof levels.$inferSelect;

const COLOR_PENDING  = 0xFEE75C;
const COLOR_APPROVED = 0x57F287;
const COLOR_REJECTED = 0xED4245;

// Component types + button styles per Discord API docs.
const ACTION_ROW = 1;
const BUTTON = 2;
const STYLE_PRIMARY   = 1;
const STYLE_SECONDARY = 2;
const STYLE_SUCCESS   = 3;
const STYLE_DANGER    = 4;

export function buildSubmissionEmbed(rec: LevelRow): Record<string, unknown> {
  const color = rec.status === 'public' ? COLOR_APPROVED
              : rec.status === 'rejected' ? COLOR_REJECTED
              : COLOR_PENDING;
  const decoded = decodeShareString(rec.shareCode);
  const factories = Array.isArray(decoded?.factories) ? (decoded!.factories as unknown[]).length : 0;
  return {
    title: rec.name,
    color,
    fields: [
      { name: 'Author', value: rec.author || '(anon)', inline: true },
      { name: 'Size', value: `${rec.cols} × ${rec.rows}`, inline: true },
      { name: 'Factories', value: String(factories), inline: true },
      { name: 'Hint', value: rec.hint?.trim() || '_(none)_' },
      { name: 'Submitted', value: `<t:${Math.floor(Number(rec.createdAt) / 1000)}:R>`, inline: true },
      { name: 'Token', value: `\`${rec.submittedByToken.slice(0, 6)}…\``, inline: true },
      { name: 'Status', value: statusLabel(rec), inline: true },
    ],
  };
}

function statusLabel(rec: LevelRow): string {
  if (rec.status === 'public') return `✅ approved${rec.approvedBy ? ` by ${rec.approvedBy}` : ''}`;
  if (rec.status === 'rejected') {
    const who = rec.rejectedBy ? ` by ${rec.rejectedBy}` : '';
    const why = rec.rejectedReason ? ` — ${rec.rejectedReason}` : '';
    return `❌ denied${who}${why}`;
  }
  return '⏳ pending';
}

export function buildReviewButtons(levelId: string): Record<string, unknown> {
  return {
    type: ACTION_ROW,
    components: [
      { type: BUTTON, style: STYLE_SUCCESS,   label: 'Approve',     custom_id: `by:approve:${levelId}` },
      { type: BUTTON, style: STYLE_DANGER,    label: 'Deny…',       custom_id: `by:deny:${levelId}` },
      { type: BUTTON, style: STYLE_SECONDARY, label: 'Social Link', custom_id: `by:link:${levelId}` },
    ],
  };
}

// After a level is approved or rejected the Approve/Deny buttons disappear
// — only the Social Link option remains so moderators can still share the
// level URL for announcements / previews.
export function buildCopyOnlyRow(levelId: string): Record<string, unknown> {
  return {
    type: ACTION_ROW,
    components: [
      { type: BUTTON, style: STYLE_SECONDARY, label: 'Social Link', custom_id: `by:link:${levelId}` },
    ],
  };
}
