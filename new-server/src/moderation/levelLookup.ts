// Shared "any-format" level-id resolver used by every mod slash command
// that accepts a `share` argument. Recognized inputs:
//
//   • Bare community uuid                — `cb53a7b9-…`
//   • Bare short code                    — `aB3xY9Qe`
//   • Full URL with `?s=<short>`         — produced by the SOCIAL LINK button
//   • Full URL with `?play=<base64>`     — long-form share link
//   • A raw `?play=<base64>` string      — paste from Copy Code
//
// Returns the level's UUID (a row id in `levels`) or null. The function is
// async because short-code lookups hit the DB.

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { decodeShareString } from '../share.js';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// base64url alphabet, 6–32 chars — covers the 8/10/12 widths the shortener
// emits plus a generous head/tail. Distinct from the UUID pattern by length.
const SHORTCODE_RE = /^[A-Za-z0-9_-]{6,32}$/;

export async function resolveLevelIdFromInput(raw: string): Promise<string | null> {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();

  // Try parsing as URL first — extract `s` (short code) or `play` (raw
  // share string) from the query.
  let shortCode: string | null = null;
  let shareCode: string | null = null;
  try {
    const u = new URL(trimmed);
    shortCode = u.searchParams.get('s');
    shareCode = u.searchParams.get('play');
  } catch (_e) {
    // Not a URL. The bare value might still be a short code or a raw
    // share string — let the regexes below decide.
    if (SHORTCODE_RE.test(trimmed) && !looksLikeShareCode(trimmed)) {
      shortCode = trimmed;
    } else if (looksLikeShareCode(trimmed)) {
      shareCode = trimmed;
    }
  }

  if (shortCode && !shareCode) {
    const [row] = await db.select({ shareCode: schema.shortLinks.shareCode })
      .from(schema.shortLinks)
      .where(eq(schema.shortLinks.id, shortCode))
      .limit(1);
    if (row) shareCode = row.shareCode;
  }

  if (shareCode) {
    const decoded = decodeShareString(shareCode);
    const id = decoded && typeof decoded.id === 'string' ? decoded.id : null;
    if (id && UUID_RE.test(id)) return id.toLowerCase();
  }

  return null;
}

// Heuristic: a base64-encoded level body is much longer than a short code
// (≥ 80 chars in practice) and must decode to JSON containing an id field.
// We use length as a cheap pre-filter; decodeShareString is the source of
// truth and rejects garbage.
function looksLikeShareCode(s: string): boolean {
  if (s.length < 80) return false;
  // base64 / base64url alphabet plus '+' '/' '=' for the standard variant.
  return /^[A-Za-z0-9+/_=-]+$/.test(s);
}
