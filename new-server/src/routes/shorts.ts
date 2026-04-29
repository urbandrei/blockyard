// URL shortener + per-level OG share cards.
//
//   POST /shorts/:id?  body: { shareCode, previewImage? }
//     201 { code, shareCode, hasPreview }
//     Creates or returns a short code for the given share-string. Same input
//     always produces the same code (idempotent, safe to spam). Optional
//     `previewImage` (base64-encoded PNG) is written to the persistent disk
//     so /p/:code can advertise it as og:image. Re-uploading is allowed —
//     latest write wins.
//
//   GET  /shorts/:code   → 200 { code, shareCode } | 404
//     JSON resolver for the SPA. Unchanged from the original behaviour;
//     existing `?s=<code>` URLs in the wild keep working.
//
//   GET  /p/:code        → 200 text/html | 404
//     OG-tagged HTML page for social-media unfurls. Bots read the head;
//     human visitors are bounced to OG_REDIRECT_BASE/?s=<code> via meta
//     refresh + immediate JS redirect.
//
//   GET  /p/:code/preview.png → 200 image/png | 404
//     Per-level preview PNG. Streamed from the PREVIEW_DIR mount.
//
// Why two share-URL shapes? Old shares (`?s=<code>`) hit the SPA directly
// and resolve via JSON. New shares (`/p/<code>`) go through this server so
// crawlers see proper OG tags. Both resolve to the same level — the FE
// emits the new shape when the preview-upload path succeeds, and falls
// back to the old shape when it doesn't (graceful degradation).

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db, schema } from '../db/client.js';
import { requireToken } from '../auth/token.js';
import { rateLimit } from '../rateLimit.js';
import { env } from '../env.js';

export const shortsRoutes = new Hono();

const MAX_PREVIEW_BYTES = 600 * 1024; // 600 KB ceiling per upload
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function shortCodeFor(shareCode: string, extraChars = 0): string {
  return createHash('sha256').update(shareCode).digest('base64url').slice(0, 8 + extraChars);
}

export async function getOrCreateShortCode(shareCode: string): Promise<string> {
  let extra = 0;
  while (extra < 8) {
    const id = shortCodeFor(shareCode, extra);
    const [existing] = await db.select().from(schema.shortLinks)
      .where(eq(schema.shortLinks.id, id)).limit(1);
    if (existing) {
      if (existing.shareCode === shareCode) return id;
      extra += 2;
      continue;
    }
    try {
      await db.insert(schema.shortLinks).values({
        id, shareCode, createdAt: Date.now(),
      });
      return id;
    } catch (err: any) {
      if (err?.code !== '23505') throw err;
      const [raced] = await db.select().from(schema.shortLinks)
        .where(eq(schema.shortLinks.id, id)).limit(1);
      if (raced?.shareCode === shareCode) return id;
      extra += 2;
    }
  }
  throw new Error('could not allocate short code');
}

// Code is always [A-Za-z0-9_-]+, 8-16 chars (sha256 base64url prefix). Hard
// reject anything else before doing any I/O so callers can't probe paths.
function isValidCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{8,16}$/.test(code);
}

function previewPathFor(code: string): string {
  return path.join(env.PREVIEW_DIR, `${code}.png`);
}

// Decode the base64 share code and pull `name` / `author` for OG tags.
// Defensive: the share code is base64-encoded JSON of the level object,
// but a malformed body should not 500 the OG page — fall back to defaults.
function levelMetaFromShareCode(shareCode: string): { name: string; author: string | null } {
  try {
    const json = Buffer.from(shareCode, 'base64').toString('utf-8');
    const lvl = JSON.parse(json);
    const name = typeof lvl?.name === 'string' && lvl.name.trim() ? lvl.name.trim() : 'Blockyard level';
    const author = typeof lvl?.author === 'string' && lvl.author.trim() ? lvl.author.trim() : null;
    return { name, author };
  } catch {
    return { name: 'Blockyard level', author: null };
  }
}

// Minimal HTML escaper for the four characters that matter inside attribute
// values and text nodes. Sufficient for level names / author handles which
// are already length-capped client-side.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function ensurePreviewDir(): Promise<void> {
  await fs.mkdir(env.PREVIEW_DIR, { recursive: true });
}

// Decode an incoming previewImage field. Accepts either a full data URL
// (`data:image/png;base64,...`) or a bare base64 string. Validates magic
// bytes so a malicious client can't write arbitrary file types.
function decodePreviewPayload(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || !raw) return null;
  const stripped = raw.startsWith('data:') ? raw.replace(/^data:[^,]*,/, '') : raw;
  let buf: Buffer;
  try {
    buf = Buffer.from(stripped, 'base64');
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > MAX_PREVIEW_BYTES) return null;
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return buf;
}

shortsRoutes.post('/shorts', requireToken(), async (c) => {
  const { token } = c.get('auth');
  const gate = rateLimit.checkLike(token);
  if (!gate.ok) return c.json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429);

  const body = await c.req.json().catch(() => null) as
    | { shareCode?: string; previewImage?: string }
    | null;
  const shareCode = typeof body?.shareCode === 'string' ? body.shareCode.trim() : '';
  if (!shareCode) return c.json({ error: 'shareCode required' }, 400);
  if (shareCode.length > 20000) return c.json({ error: 'shareCode too long' }, 413);

  let code: string;
  try {
    code = await getOrCreateShortCode(shareCode);
  } catch (err) {
    console.error('[shorts] allocation failed', err);
    return c.json({ error: 'could not allocate short code' }, 500);
  }

  // Optional preview-image upload. Failure here is non-fatal — the short
  // code is still valid; the FE just falls back to the global og-image.
  let hasPreview = false;
  const previewBuf = decodePreviewPayload(body?.previewImage);
  if (previewBuf) {
    try {
      await ensurePreviewDir();
      await fs.writeFile(previewPathFor(code), previewBuf);
      await db.update(schema.shortLinks)
        .set({ hasPreview: true })
        .where(eq(schema.shortLinks.id, code));
      hasPreview = true;
    } catch (err) {
      console.warn('[shorts] preview write failed', err);
    }
  } else {
    const [row] = await db.select({ hasPreview: schema.shortLinks.hasPreview })
      .from(schema.shortLinks).where(eq(schema.shortLinks.id, code)).limit(1);
    hasPreview = !!row?.hasPreview;
  }

  return c.json({ code, shareCode, hasPreview });
});

shortsRoutes.get('/shorts/:code', async (c) => {
  const code = c.req.param('code')!;
  const [row] = await db.select({ shareCode: schema.shortLinks.shareCode })
    .from(schema.shortLinks).where(eq(schema.shortLinks.id, code)).limit(1);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ code, shareCode: row.shareCode });
});

shortsRoutes.get('/p/:code/preview.png', async (c) => {
  const code = c.req.param('code')!;
  if (!isValidCode(code)) return c.notFound();
  try {
    const buf = await fs.readFile(previewPathFor(code));
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  } catch {
    return c.notFound();
  }
});

shortsRoutes.get('/p/:code', async (c) => {
  const code = c.req.param('code')!;
  if (!isValidCode(code)) return c.notFound();
  const [row] = await db.select({
    shareCode:  schema.shortLinks.shareCode,
    hasPreview: schema.shortLinks.hasPreview,
  }).from(schema.shortLinks).where(eq(schema.shortLinks.id, code)).limit(1);
  if (!row) return c.notFound();

  const meta = levelMetaFromShareCode(row.shareCode);
  const playUrl = `${env.OG_REDIRECT_BASE}/?s=${encodeURIComponent(code)}`;
  const ogImage = row.hasPreview
    ? `${env.API_PUBLIC_BASE}/p/${encodeURIComponent(code)}/preview.png`
    : `${env.OG_REDIRECT_BASE}/og-image.png`;
  const titleRaw = meta.author ? `${meta.name} by ${meta.author}` : meta.name;
  const title = `${titleRaw} | Blockyard`;
  const description = meta.author
    ? `Play "${meta.name}" by ${meta.author} on Blockyard, a puzzle game where you place factories on a grid to manufacture shapes.`
    : `Play "${meta.name}" on Blockyard, a puzzle game where you place factories on a grid to manufacture shapes.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex,follow">
<link rel="canonical" href="${esc(playUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Blockyard">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(playUrl)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<meta http-equiv="refresh" content="0;url=${esc(playUrl)}">
<style>body{margin:0;background:#412722;color:#e6edf5;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px;box-sizing:border-box}a{color:#ffd877}</style>
</head>
<body>
<div>
  <p>Opening Blockyard…</p>
  <p>If nothing happens, <a href="${esc(playUrl)}">click here to play</a>.</p>
</div>
<script>location.replace(${JSON.stringify(playUrl)});</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
});
