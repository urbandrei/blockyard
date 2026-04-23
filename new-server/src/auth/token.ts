// Anonymous per-client tokens. Issued on first Community-scene entry and
// persisted client-side via platform.saveData. No PII — just a random id
// that lets us attribute submissions, likes, and ratings to the same
// browser across sessions.

import { randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function issueToken(ip: string | null, ua: string | null): Promise<string> {
  const token = newToken();
  await db.insert(schema.tokens).values({
    token,
    createdAt: Date.now(),
    ip, ua,
    banned: false,
  });
  return token;
}

export interface AuthedContext {
  token: string;
}

// Hono middleware: asserts the X-Blockyard-Token header and attaches the
// token to c.var. Handlers read `c.get('auth').token`.
export function requireToken() {
  return async (c: Context, next: Next) => {
    const token = c.req.header('x-blockyard-token');
    if (!token) return c.json({ error: 'missing token' }, 401);
    const [row] = await db.select().from(schema.tokens).where(eq(schema.tokens.token, token)).limit(1);
    if (!row) return c.json({ error: 'unknown token' }, 401);
    if (row.banned) return c.json({ error: 'banned' }, 403);
    c.set('auth', { token } satisfies AuthedContext);
    await next();
  };
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthedContext;
  }
}
