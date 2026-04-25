// Server-side mirror of src/eth/canonical.js. Both implementations MUST
// produce byte-for-byte identical output for any given level — if they
// drift, signature verification breaks for every existing level.
//
// When updating either file, update the other in the same commit.

const STRIP_TOP = new Set([
  'id', 'likes', 'updatedAt', 'importedAt', 'status',
  'origin', 'createdAt',
  'authorWallet', 'authorSignature', 'chainId', 'tokenId', 'txHash',
  'discordMessageId', 'submittedByToken', 'submittedFromIp',
  'rejectedReason', 'rejectedBy', 'approvedBy',
  'ratingAvg', 'ratingCount',
]);

export function canonicalize(level: Record<string, unknown>): string {
  const cleaned = stripTop(level);
  return stableStringify(cleaned);
}

function stripTop(level: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(level)) {
    if (STRIP_TOP.has(k)) continue;
    out[k] = level[k];
  }
  return out;
}

function stableStringify(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'null';
    return JSON.stringify(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(stableStringify).join(',') + ']';
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const val = obj[k];
      if (val === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + stableStringify(val));
    }
    return '{' + parts.join(',') + '}';
  }
  return 'null';
}

export function signingMessage(level: Record<string, unknown>, chainId: number): string {
  const body = canonicalize(level);
  const name = typeof level.name === 'string' ? level.name : '';
  return [
    'Blockyard level publish',
    `chainId: ${chainId}`,
    `name: ${name}`,
    `body: ${body}`,
  ].join('\n');
}
