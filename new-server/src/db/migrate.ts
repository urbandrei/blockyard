// Applies any drizzle-kit-generated SQL files under src/db/migrations.
// Runs as part of the Render build step (see render.yaml buildCommand) and
// can be invoked locally via `npm run db:migrate`.

import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

async function main() {
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('[db] migrations applied');
  await pool.end();
}

main().catch((err) => {
  console.error('[db] migration failed', err);
  process.exit(1);
});
