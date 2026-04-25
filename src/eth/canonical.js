// Canonical-JSON serializer used to derive the message that the author
// signs at publish time. The server mirrors this logic in
// server/src/canonical.ts — the two implementations MUST stay byte-for-byte
// identical or signature verification breaks.
//
// Rules:
//   1. Drop runtime-only fields that the user never intended to authenticate:
//      `id`, `likes`, `updatedAt`, `importedAt`, `status`, plus the wallet
//      fields themselves (`authorWallet`, `authorSignature`, `chainId`,
//      `tokenId`, `txHash`) since those are added AFTER the signature.
//   2. Stable key order: sort object keys lexicographically at every depth.
//   3. Use JSON.stringify with no spacing — the canonical form is one line.

const STRIP_TOP = new Set([
  'id', 'likes', 'updatedAt', 'importedAt', 'status',
  'origin', 'createdAt',
  'authorWallet', 'authorSignature', 'chainId', 'tokenId', 'txHash',
  'discordMessageId', 'submittedByToken', 'submittedFromIp',
  'rejectedReason', 'rejectedBy', 'approvedBy',
  'ratingAvg', 'ratingCount',
]);

export function canonicalize(level) {
  const cleaned = stripTop(level);
  return stableStringify(cleaned);
}

function stripTop(level) {
  const out = {};
  for (const k of Object.keys(level)) {
    if (STRIP_TOP.has(k)) continue;
    out[k] = level[k];
  }
  return out;
}

// Recursive sorted-key stringify — JSON.stringify with a key-sorting
// replacer wouldn't preserve the deterministic order across nested arrays
// of objects, so we walk the value ourselves.
function stableStringify(v) {
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
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      const val = v[k];
      if (val === undefined) continue;
      parts.push(JSON.stringify(k) + ':' + stableStringify(val));
    }
    return '{' + parts.join(',') + '}';
  }
  // undefined / function / symbol → drop
  return 'null';
}

// Human-readable preamble bound into the signed message so a wallet
// confirmation prompt reads as something other than opaque base64.
// Including the chainId means a sig minted on testnet won't validate on
// mainnet even if someone tries to replay the canonical body.
export function signingMessage(level, chainId) {
  const body = canonicalize(level);
  return [
    'Blockyard level publish',
    `chainId: ${chainId}`,
    `name: ${level.name || ''}`,
    `body: ${body}`,
  ].join('\n');
}
