// Blockyard API entry point. Single-process Hono app handling:
//   - community level CRUD + search
//   - likes + ratings (token-scoped)
//   - Discord Interactions (approve / deny(modal) / copy)
// Deployed as a single Render Web Service; the Discord bot is NOT a
// separate process — button clicks arrive here as signed HTTPS requests.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { env, isOriginAllowed } from './env.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { levelRoutes } from './routes/levels.js';
import { likeRoutes } from './routes/likes.js';
import { ratingRoutes } from './routes/ratings.js';
import { shortsRoutes } from './routes/shorts.js';
import { playRoutes } from './routes/plays.js';
import { featuredRoutes } from './routes/featured.js';
import { discordRoutes } from './moderation/interactions.js';

const app = new Hono();

// CORS is applied to every route EXCEPT /discord/interactions — Discord
// doesn't send an Origin header, and we don't want CORS to reject those.
app.use('*', async (c, next) => {
  if (c.req.path === '/discord/interactions') return next();
  return cors({
    origin: (origin) => isOriginAllowed(origin) ? origin : '',
    allowHeaders: ['content-type', 'x-blockyard-token'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  })(c, next);
});

app.route('/', healthRoutes);
app.route('/', authRoutes);
app.route('/', levelRoutes);
app.route('/', likeRoutes);
app.route('/', ratingRoutes);
app.route('/', shortsRoutes);
app.route('/', playRoutes);
app.route('/', featuredRoutes);
app.route('/', discordRoutes);

app.onError((err, c) => {
  console.error('[http] unhandled', err);
  return c.json({ error: 'internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'not found' }, 404));

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[http] listening on :${info.port}`);
});
