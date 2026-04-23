import { Hono } from 'hono';
import { issueToken } from '../auth/token.js';

export const authRoutes = new Hono();

authRoutes.post('/auth/token', async (c) => {
  const ip = clientIp(c.req.header('cf-connecting-ip'), c.req.header('x-forwarded-for'));
  const ua = c.req.header('user-agent') ?? null;
  const token = await issueToken(ip, ua);
  return c.json({ token });
});

function clientIp(cfIp: string | undefined, xff: string | undefined): string | null {
  const raw = cfIp ?? xff;
  if (!raw) return null;
  return raw.split(',')[0]!.trim() || null;
}
