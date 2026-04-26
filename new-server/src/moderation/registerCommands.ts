// Registers Blockyard's Discord application commands. Run once after
// editing the command schema below — Discord caches global commands for
// up to an hour, so prefer guild-scoped during iteration:
//
//   tsx src/moderation/registerCommands.ts                 # global
//   tsx src/moderation/registerCommands.ts <guildId>       # guild-scoped
//
// Reads DISCORD_APP_ID + DISCORD_BOT_TOKEN from env. The bot account must
// have `applications.commands` scope when invited to the server. If you
// remove a subcommand here, re-running this script overwrites the existing
// definition (PUT replaces).

import 'dotenv/config';
import { env } from '../env.js';

const COMMANDS = [
  {
    name: 'stats',
    description: 'Blockyard play telemetry',
    // Subcommands map to `interaction.data.options[0]` server-side.
    options: [
      {
        type: 1,                        // SUB_COMMAND
        name: 'level',
        description: 'Stats for a single level',
        options: [{
          type: 3,                      // STRING
          name: 'id',
          description: 'Community uuid or campaign id (e.g. level-7)',
          required: true,
        }],
      },
      {
        type: 1,
        name: 'top',
        description: 'Top 10 levels by metric',
        options: [
          {
            type: 3,
            name: 'kind',
            description: 'campaign or community',
            required: true,
            choices: [
              { name: 'campaign',  value: 'campaign'  },
              { name: 'community', value: 'community' },
            ],
          },
          {
            type: 3,
            name: 'metric',
            description: 'plays or completions (default: completions)',
            required: false,
            choices: [
              { name: 'plays',       value: 'plays'       },
              { name: 'completions', value: 'completions' },
            ],
          },
        ],
      },
      {
        type: 1,
        name: 'campaign',
        description: 'Per-level campaign rollup',
      },
    ],
  },
];

async function main() {
  if (!env.DISCORD_APP_ID || !env.DISCORD_BOT_TOKEN) {
    console.error('[register] DISCORD_APP_ID and DISCORD_BOT_TOKEN are required');
    process.exit(1);
  }

  const guildId = process.argv[2];
  const url = guildId
    ? `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error(`[register] failed: ${res.status}`, txt);
    process.exit(1);
  }
  const data = await res.json();
  console.log(`[register] OK — ${guildId ? `guild ${guildId}` : 'global'} (${(data as any[]).length} commands)`);
}

main().catch((err) => {
  console.error('[register] error', err);
  process.exit(1);
});
