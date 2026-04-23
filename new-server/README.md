# Blockyard API (`new-server/`)

Render-hosted Node/Hono API backing the Community tab. Replaces the old laptop-based `server/` that used a Cloudflare Tunnel + JSON-on-disk + a persistent `discord.js` bot. Single service, Postgres storage, Discord moderation via HTTPS Interactions (no websocket).

## Architecture

```
Phaser client
    │   HTTPS   (X-Blockyard-Token header on writes)
    ▼
Hono app on Render Web Service
    │  pg
    ▼  Render Postgres
          ↑  channel webhook (outbound)
          │
      Discord channel ◀── buttons ──▶ POST /discord/interactions
```

- Levels stored as the game's existing base64 **share-string** (`levels.share_code`). `GET /levels/:id` decodes it on the way out so the Player scene keeps receiving a full level JSON.
- Ratings live in a denormalized `rating_sum` / `rating_count` on `levels` so sort-by-average is a single index scan.
- No persistent Discord bot. Submissions are announced via a **channel webhook**; button clicks come back as signed HTTPS interactions.

## Install

```bash
cd new-server
npm install
cp .env.example .env
```

Fill in `.env` — see the Discord + database sections below.

## Local run

You need a Postgres instance reachable from `DATABASE_URL`. Quickest path is a local container:

```bash
docker run -d --name bypg -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16
# then in .env:
# DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres
```

Apply the schema and start the server:

```bash
npm run db:generate   # emits src/db/migrations/*.sql from schema.ts (first run only, or after schema edits)
npm run db:migrate    # applies migrations
npm run dev           # tsx watch — reloads on save
```

On a clean boot you'll see:

```
[http] listening on :8787
```

Hit `curl -sf localhost:8787/health` → `{"ok":true}`.

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/token` | none | Issue anon token (stored client-side forever) |
| `GET`  | `/health` | none | Liveness |
| `GET`  | `/levels?q=&sort=recent\|likesDesc\|likesAsc\|ratingDesc&page=&pageSize=` | none | Public search |
| `POST` | `/levels` | `X-Blockyard-Token` | Submit; status=pending; fires Discord webhook |
| `GET`  | `/levels/:id` | none | Public fetch; body contains decoded `level` JSON |
| `POST` | `/levels/:id/like` | token | `{ liked: boolean }` — toggles |
| `GET`  | `/my/likes` | token | `{ ids: [...] }` |
| `POST` | `/levels/:id/rating` | token | `{ stars: 1..5 }` — upsert |
| `GET`  | `/my/ratings` | token | `{ ratings: [{ levelId, stars }] }` |
| `POST` | `/discord/interactions` | Discord signature | Button + modal dispatch |

Rate limits (per-process, reset on restart): 10 publishes / 24h per token+IP, 60 likes / min per token, 30 ratings / min per token. Tunable via `RATE_*` env vars.

## Discord setup (one-time)

The server posts submission embeds **via a bot user**, not a channel webhook. Manually-created channel webhooks can't attach interactive components to messages — Discord silently drops buttons on those. Only application-owned bots can, so the bot route is the only one that makes Approve / Deny / Social Link render.

1. **Create the application.** Go to <https://discord.com/developers/applications> → **New Application**. From the General Information page, copy **Application ID** → `DISCORD_APP_ID` and **Public Key** → `DISCORD_PUBLIC_KEY`.
2. **Create the bot user.** In the app's **Bot** tab, click **Reset Token** and copy the token → `DISCORD_BOT_TOKEN`. Leave privileged intents off; we don't use any.
3. **Invite the bot to your review server.** In **OAuth2 → URL Generator**, check scopes `bot` and `applications.commands`. Under Bot Permissions, check `Send Messages` and `Embed Links`. Open the generated URL in a browser and pick your private review server.
4. **Copy the review channel id.** In Discord, enable Developer Mode (User Settings → Advanced), then right-click your `#level-reviews` channel → **Copy Channel ID** → `DISCORD_CHANNEL_ID`. Make sure the bot has Send Messages permission in that specific channel (or inherits it from the category).
5. **Point the Interactions Endpoint at the server.** In the app's General Information page, set **Interactions Endpoint URL** to `https://<your-render-host>/discord/interactions`. When you save, Discord immediately sends a signed PING request — your server must be running and verifying correctly or Discord rejects the URL.
6. **Set `SHARE_BASE_URL`** to your game's public domain (e.g. `https://www.block-yard.com`). The Social Link button produces URLs from this base.

Each submission posts an embed + three buttons:

- **Approve** — DB flips to `public`; embed re-rendered in green; buttons collapse to Social-Link-only.
- **Deny…** — opens a modal; the reason is saved to `rejected_reason`; embed re-rendered in red.
- **Social Link** — replies ephemerally with a self-contained deep-link URL (`…/?play=<base64>`). Works pre- and post-approval since the level payload is embedded in the URL, so mods can test-play before approving.

## Render deployment

`render.yaml` provisions both the Web Service and the Postgres instance. Push `new-server/` to a GitHub repo, then in Render choose **Blueprint → pick this repo**. Render reads the YAML, creates both resources, and injects `DATABASE_URL` into the web service automatically.

Secrets you still need to set in the Render dashboard (marked `sync: false` in the YAML):

- `ALLOWED_ORIGINS` — comma-separated list of your game build origins (e.g. `https://my-game.itch.io,https://www.newgrounds.com,https://www.crazygames.com`)
- `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `SHARE_BASE_URL`

`buildCommand` runs `npm run build && npm run db:migrate`, so each deploy re-applies any new migrations before the server boots.

### Free-tier note

Render's free Web Service sleeps after ~15 min of idle. Discord requires a response to interaction pings within 3 seconds, so the first button click on a cold instance may time out. Workarounds: click the button again once the service has woken, or upgrade to the cheapest paid tier for always-on.

## Connecting the game

After deploy:

```bash
# in the game repo root
echo "VITE_BLOCKYARD_API=https://<your-render-host>" >> .env
npm run build:web
```

`src/core/community.js` already scaffolds the remote calls — wiring them to this API is a follow-up task explicitly outside this server's scope.

## Admin notes

- **Ban a token**: `UPDATE tokens SET banned = true WHERE token = '…';`
- **Force-approve a level from SQL**: `UPDATE levels SET status='public', approved_by='manual' WHERE id='…';` — won't update the Discord embed, so only use it if the embed's already been clicked.
- **Roll back an approval**: same, set `status='pending'` and it'll hide from `GET /levels` immediately.
