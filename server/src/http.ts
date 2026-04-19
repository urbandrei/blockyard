// HTTP surface for the Blockyard community server. Bun.serve-based.
// All routes JSON. Writes require a token header; CORS locked to an allow-list.

import type { Store } from './store.ts';
import type { RateLimiter } from './rateLimit.ts';
import { issueToken, assertToken } from './auth.ts';
import type { LevelRecord } from './types.ts';

export interface HttpDeps {
  store: Store;
  limiter: RateLimiter;
  allowedOrigins: Set<string>;
  onLevelSubmitted(rec: LevelRecord): Promise<void>;
}

export function makeFetch(deps: HttpDeps) {
  const { store, limiter, allowedOrigins } = deps;

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    const corsOk = !origin || allowedOrigins.has('*') || allowedOrigins.has(origin);
    const cors = corsHeaders(origin, corsOk);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: corsOk ? 204 : 403, headers: cors });
    }
    if (origin && !corsOk) return json({ error: 'origin not allowed' }, 403, cors);

    try {
      // --- auth ---
      if (url.pathname === '/auth/token' && req.method === 'POST') {
        const ip = clientIp(req);
        const ua = req.headers.get('user-agent');
        const token = await issueToken(store, ip, ua);
        return json({ token }, 200, cors);
      }

      // --- health ---
      if (url.pathname === '/health' && req.method === 'GET') {
        return json({ ok: true }, 200, cors);
      }

      // --- levels ---
      if (url.pathname === '/levels' && req.method === 'GET') {
        const q = url.searchParams.get('q') ?? undefined;
        const sortParam = url.searchParams.get('sort');
        const sort = sortParam === 'likesDesc' || sortParam === 'likesAsc' ? sortParam : 'recent';
        const page = Number.parseInt(url.searchParams.get('page') ?? '0', 10) || 0;
        const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '5', 10) || 5;
        const result = await store.search({ q, sort, page, pageSize });
        return json(result, 200, cors);
      }

      if (url.pathname === '/levels' && req.method === 'POST') {
        const auth = await assertToken(store, req.headers.get('x-blockyard-token'));
        if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
        const ip = clientIp(req);
        const gate = limiter.checkPublish(auth.token, ip);
        if (!gate.ok) return json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429, cors);

        const body = await safeJson(req);
        if (!body || typeof body !== 'object') return json({ error: 'invalid body' }, 400, cors);

        const meta = extractMeta(body);
        if (!meta) return json({ error: 'level missing name/author/board' }, 400, cors);

        const rec = await store.createLevel({
          level: body as Record<string, unknown>,
          token: auth.token,
          ip,
          clientId: typeof (body as any).id === 'string' ? (body as any).id : null,
          ...meta,
        });
        // Fire-and-await: we want the Discord message id back in the record
        // before responding, so a moderator refresh finds the message id.
        try { await deps.onLevelSubmitted(rec); }
        catch (e) { console.error('onLevelSubmitted failed', e); }
        return json({ id: rec.id, status: rec.status }, 201, cors);
      }

      const levelMatch = url.pathname.match(/^\/levels\/([A-Za-z0-9_-]+)$/);
      if (levelMatch && req.method === 'GET') {
        const rec = await store.readLevel(levelMatch[1]!);
        if (!rec || rec.status !== 'public') return json({ error: 'not found' }, 404, cors);
        return json({ id: rec.id, level: rec.level, likes: rec.likes, author: rec.author, name: rec.name }, 200, cors);
      }

      const likeMatch = url.pathname.match(/^\/levels\/([A-Za-z0-9_-]+)\/like$/);
      if (likeMatch && req.method === 'POST') {
        const auth = await assertToken(store, req.headers.get('x-blockyard-token'));
        if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
        const gate = limiter.checkLike(auth.token);
        if (!gate.ok) return json({ error: 'rate limited', retryAfterMs: gate.retryAfterMs }, 429, cors);
        const body = await safeJson(req) as { liked?: boolean } | null;
        const liked = body?.liked !== false;
        const result = await store.toggleLike(auth.token, likeMatch[1]!, liked);
        if (!result) return json({ error: 'not found' }, 404, cors);
        return json({ liked, likes: result.likes }, 200, cors);
      }

      // Let a caller with the admin token pre-fetch the levels they've liked,
      // so the game can restore heart state across sessions.
      if (url.pathname === '/my/likes' && req.method === 'GET') {
        const auth = await assertToken(store, req.headers.get('x-blockyard-token'));
        if (!auth.ok) return json({ error: auth.error }, auth.status, cors);
        const ids = await store.getLikesForToken(auth.token);
        return json({ ids }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      console.error('http error', err);
      return json({ error: 'internal error' }, 500, cors);
    }
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors },
  });
}

function corsHeaders(origin: string | null, allowed: boolean): Record<string, string> {
  if (!origin) return {};
  const h: Record<string, string> = {
    'vary': 'origin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-blockyard-token',
    'access-control-max-age': '600',
  };
  if (allowed) h['access-control-allow-origin'] = origin;
  return h;
}

async function safeJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for');
  if (!fwd) return null;
  return fwd.split(',')[0]!.trim() || null;
}

function extractMeta(body: any): { name: string; author: string; hint: string | null; cols: number; rows: number } | null {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const author = typeof body.author === 'string' ? body.author.trim() : '';
  const hintRaw = typeof body.instructionalText === 'string' ? body.instructionalText.trim() : '';
  const cols = Number(body?.board?.cols);
  const rows = Number(body?.board?.rows);
  if (!name || !author || !Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return {
    name: name.slice(0, 80),
    author: author.slice(0, 40),
    hint: hintRaw ? hintRaw.slice(0, 200) : null,
    cols, rows,
  };
}
