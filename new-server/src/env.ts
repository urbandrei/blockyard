// Typed env loader. Throws at import time if required vars are missing so
// routes never have to null-check `process.env.*`. Render injects
// DATABASE_URL from the linked Postgres resource; everything else comes
// from the dashboard or .env in local dev.

import 'dotenv/config';
import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),

  DISCORD_APP_ID: z.string().optional(),
  DISCORD_PUBLIC_KEY: z.string().optional(),
  // Bot-authenticated channel POST (needed because manually-created
  // channel webhooks can't attach interactive components to messages —
  // only application-owned bots can).
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CHANNEL_ID: z.string().optional(),
  // Base URL for shareable deep-links. Used by the "Social Link" button in
  // the review embed. Must match the hardcoded SHARE_BASE_URL on the client.
  SHARE_BASE_URL: z.string().url().default('https://www.block-yard.com'),

  ADMIN_TOKEN: z.string().optional(),

  RATE_PUBLISH_PER_DAY:   z.coerce.number().int().positive().default(10),
  RATE_LIKE_PER_MINUTE:   z.coerce.number().int().positive().default(60),
  RATE_RATING_PER_MINUTE: z.coerce.number().int().positive().default(30),
  // 1 POST + 1 PATCH per play, but a single fast-replaying user can churn
  // through many sessions in a minute, so leave headroom.
  RATE_PLAY_PER_MINUTE:   z.coerce.number().int().positive().default(120),

  // Phase 2 share-card storage. PREVIEW_DIR is a writable path on the
  // Render persistent disk; OG_REDIRECT_BASE is where /p/:code bounces
  // human visitors after the OG-scraping bots have read the head;
  // API_PUBLIC_BASE is this server's own public-facing origin (Render
  // terminates TLS so c.req.url would otherwise be http://, which OG
  // scrapers reject for og:image).
  PREVIEW_DIR:      z.string().default('/var/data/previews'),
  OG_REDIRECT_BASE: z.string().url().default('https://www.block-yard.com'),
  API_PUBLIC_BASE:  z.string().url().default('https://blockyard-api.onrender.com'),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// CORS allowlist supporting BOTH exact origins and host wildcards. Exact
// entries like `https://www.block-yard.com` go in the Set for O(1) lookup;
// wildcard entries like `https://*.builds.wavedash.com` get compiled to a
// regex (anchored, escaped, with `*` substituted for a single host label
// that excludes dots so `evil.builds.wavedash.com.attacker.io` can't match).
//
// Why wildcards: Wavedash serves each game build on a fresh subdomain
// `https://<hash>.builds.wavedash.com` — the hash rotates on every upload,
// so a literal allowlist entry would break after the next deploy.
const exactOrigins = new Set<string>();
const wildcardPatterns: RegExp[] = [];
for (const raw of env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)) {
  if (raw.includes('*')) {
    // Escape regex meta-chars, then replace the literal `*` with a host-
    // label match that does NOT cross dots. Anchor both ends.
    const escaped = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
    wildcardPatterns.push(new RegExp(`^${escaped}$`));
  } else {
    exactOrigins.add(raw);
  }
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  if (exactOrigins.has(origin)) return true;
  for (const re of wildcardPatterns) if (re.test(origin)) return true;
  return false;
}

// Kept for back-compat with any callers importing the Set directly. New
// code should use isOriginAllowed() so wildcards are honored.
export const allowedOrigins = exactOrigins;
