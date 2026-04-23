// Share-string codec. Matches the game's ImportModal format (base64 of the
// minified level JSON with runtime-only fields stripped). The Discord Copy
// Code button returns exactly this string; GET /levels/:id decodes it on
// the way out so the client receives the expanded level object.

const STRIP = new Set([
  'likes', 'updatedAt', 'importedAt',
  'discordMessageId', 'submittedByToken', 'submittedFromIp',
]);

export function encodeShareString(level: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(level)) {
    if (!STRIP.has(k)) clean[k] = v;
  }
  return Buffer.from(JSON.stringify(clean), 'utf8').toString('base64');
}

export function decodeShareString(s: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(s, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null;
  } catch { return null; }
}

// Discord messages cap at 2000 chars; leave headroom for the code fence.
export function chunkShareString(s: string, max = 1900): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}
