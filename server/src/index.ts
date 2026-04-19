// Blockyard community server entrypoint.
// Starts HTTP + Discord bot in the same Bun process.

import 'dotenv/config';
import { Store } from './store.ts';
import { RateLimiter } from './rateLimit.ts';
import { makeFetch } from './http.ts';
import { ReviewBot } from './bot.ts';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const dataDir = env('DATA_DIR', './data');
  const port = envInt('PORT', 8787);
  const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
  const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
  const reviewChannelId = process.env.DISCORD_REVIEW_CHANNEL_ID ?? '';

  const store = new Store(dataDir);
  await store.init();
  console.log(`[store] ready at ${store.root}`);

  const limiter = new RateLimiter({
    publishPerDay: envInt('RATE_PUBLISH_PER_DAY', 10),
    likePerMinute: envInt('RATE_LIKE_PER_MINUTE', 60),
  });

  let bot: ReviewBot | null = null;
  if (botToken && reviewChannelId) {
    bot = new ReviewBot({ token: botToken, reviewChannelId, store });
    await bot.start();
  } else {
    console.warn('[bot] DISCORD_BOT_TOKEN / DISCORD_REVIEW_CHANNEL_ID not set — skipping bot startup');
  }

  const fetch = makeFetch({
    store,
    limiter,
    allowedOrigins,
    onLevelSubmitted: async (rec) => {
      if (!bot) return;
      try { await bot.postSubmission(rec); }
      catch (e) { console.error('[bot] postSubmission failed', e); }
    },
  });

  Bun.serve({ port, fetch });
  console.log(`[http] listening on :${port}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
