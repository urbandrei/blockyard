// Single pg Pool + a drizzle(db) instance shared across routes. Callers do
// not touch `pool` directly — they use `db` and the helpers in ./schema.ts.

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { env } from '../env.js';

// Render Postgres requires TLS in production. Local dev usually doesn't.
// Detect by DATABASE_URL host: managed hosts tend to end in render.com.
function needsSSL(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.get('sslmode') === 'disable') return false;
    return /\.(render\.com|neon\.tech|aws\.com|azure\.com|gcp\.com)$/i.test(u.hostname)
        || u.searchParams.get('sslmode') === 'require';
  } catch { return false; }
}

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: needsSSL(env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 10,
});

export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });
export { schema };
