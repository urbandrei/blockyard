// Anonymous per-browser tokens. Issued on first Community-scene entry and
// stored via the game's platform.saveData. No PII — just a random id that
// lets the server attribute submissions + likes to the same client.

import { randomBytes } from 'node:crypto';
import type { Store } from './store.ts';

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function issueToken(store: Store, ip: string | null, ua: string | null): Promise<string> {
  const token = newToken();
  await store.saveToken(token, { createdAt: Date.now(), ip, ua });
  return token;
}

export async function assertToken(store: Store, token: string | null): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
  if (!token) return { ok: false, status: 401, error: 'missing token' };
  const rec = await store.getToken(token);
  if (!rec) return { ok: false, status: 401, error: 'unknown token' };
  if (rec.banned) return { ok: false, status: 403, error: 'banned' };
  return { ok: true, token };
}
