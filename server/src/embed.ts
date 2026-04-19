import { EmbedBuilder, Colors } from 'discord.js';
import type { LevelRecord } from './types.ts';

const PENDING = Colors.Yellow;
const APPROVED = Colors.Green;
const REJECTED = Colors.Red;

export function buildSubmissionEmbed(rec: LevelRecord): EmbedBuilder {
  const color = rec.status === 'public' ? APPROVED : rec.status === 'rejected' ? REJECTED : PENDING;
  const factories = Array.isArray((rec.level as any)?.factories) ? (rec.level as any).factories.length : 0;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${rec.name}`)
    .addFields(
      { name: 'Author', value: rec.author || '(anon)', inline: true },
      { name: 'Size', value: `${rec.cols} × ${rec.rows}`, inline: true },
      { name: 'Factories', value: String(factories), inline: true },
      { name: 'Hint', value: rec.hint?.trim() || '_(none)_' },
      { name: 'Submitted', value: `<t:${Math.floor(rec.createdAt / 1000)}:R>`, inline: true },
      { name: 'Token', value: `\`${rec.submittedByToken.slice(0, 6)}…\``, inline: true },
      { name: 'Status', value: statusLabel(rec), inline: true },
    );
  return embed;
}

function statusLabel(rec: LevelRecord): string {
  if (rec.status === 'public') return `✅ approved${rec.approvedBy ? ` by ${rec.approvedBy}` : ''}`;
  if (rec.status === 'rejected') {
    const who = rec.rejectedBy ? ` by ${rec.rejectedBy}` : '';
    const why = rec.rejectedReason ? ` — ${rec.rejectedReason}` : '';
    return `❌ denied${who}${why}`;
  }
  return '⏳ pending';
}

// Chunk a long share-string across messages with each chunk in a code block.
// Discord max message length is 2000; leave headroom for the fence.
export function chunkShareString(s: string, max = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

// Build the share-string the game's ImportModal already understands:
// base64 of minified level JSON (runtime-only fields stripped).
export function encodeShareString(level: Record<string, unknown>): string {
  const { likes, updatedAt, importedAt, discordMessageId, submittedByToken, submittedFromIp, ...clean } = level as any;
  const json = JSON.stringify(clean);
  return Buffer.from(json, 'utf8').toString('base64');
}
