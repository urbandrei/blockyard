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
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const allowedOrigins = new Set(
  env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
);
