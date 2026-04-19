# Blockyard community server

Local Bun server + Discord moderation bot for Milestone H. JSON-on-disk storage under `./data/`; no database. Fronted by a Cloudflare Tunnel so the game can reach it from any browser while it runs on your laptop.

## Install

```bash
cd server
bun install
cp .env.example .env
```

Fill in `.env` — see the Discord and tunnel sections below.

## Run

```bash
bun run start     # one-shot
bun run dev       # auto-restart on source changes
```

On boot you should see:

```
[store] ready at …/server/data
[bot] ready as blockyard-mod#1234
[http] listening on :8787
```

## Data layout

```
data/
  index.json                    # summary of every level (for listing)
  likes.json                    # { "<token>": { "<levelId>": 1 } }
  tokens.json                   # { "<token>": { createdAt, ip, ua, banned? } }
  levels/<uuid>.json            # full level record + meta
```

`data/` is gitignored. If `index.json` drifts out of sync (manual edit, crash), the server rebuilds it from the `levels/` folder on next startup when the index is empty but level files exist. To force a rebuild, delete `index.json`.

## HTTP routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/token` | none | Issue an anonymous token (client stores it forever). |
| `POST` | `/levels` | `X-Blockyard-Token` | Submit a level. Creates a Discord review message. |
| `GET`  | `/levels?q=&sort=recent\|likesDesc\|likesAsc&page=&pageSize=` | none | List public levels. |
| `GET`  | `/levels/:id` | none | Fetch a public level's full body. |
| `POST` | `/levels/:id/like` | `X-Blockyard-Token` | Body `{liked: boolean}`. Toggles the like. |
| `GET`  | `/my/likes` | `X-Blockyard-Token` | Returns ids this token has liked. |
| `GET`  | `/health` | none | 200 OK — useful for tunnel probes. |

Rate limits: 10 publishes / 24h per token+IP; 60 likes / minute per token. In-memory only — resets on restart.

## Discord setup (one-time)

1. Go to <https://discord.com/developers/applications> → **New Application** → give it a name (e.g. `Blockyard Mod`).
2. In the **Bot** tab, click **Reset Token** and copy the value into `DISCORD_BOT_TOKEN`.
3. Under **Privileged Gateway Intents**, leave everything OFF (we only need `Guilds`).
4. In the **OAuth2 → URL Generator**, check the `bot` scope. Under Bot Permissions, check `Send Messages`, `Embed Links`, `Read Message History`. Open the generated URL and invite the bot to a private server that only you are in.
5. In Discord, right-click the channel you want reviews in → **Copy Channel ID** (requires Developer Mode — in User Settings → Advanced). Paste it into `DISCORD_REVIEW_CHANNEL_ID`.
6. (Optional) paste your app id into `DISCORD_APP_ID` and guild id into `DISCORD_GUILD_ID` — unused today, reserved for future slash-command registration.

Each submission posts one embed with three buttons:

- **Approve** — flips status to `public`, disables buttons, edit embed to green.
- **Deny…** — opens a modal, reason becomes `rejectedReason` on the record.
- **Copy Code** — replies ephemerally with the share-string (same base64 format as `ImportModal` in the game).

## Tunnel setup (Cloudflare Tunnel, free)

One-time cost: a domain you control (Cloudflare will host the DNS for free). If you don't own one, [register a cheap one on Cloudflare Registrar](https://www.cloudflare.com/products/registrar/) (~$10/yr for `.com`), or repurpose any domain you already own by moving its nameservers to Cloudflare.

```bash
# Windows
winget install --id Cloudflare.cloudflared

cloudflared tunnel login                                      # opens browser; pick your domain
cloudflared tunnel create blockyard                           # writes creds to %USERPROFILE%\.cloudflared\<id>.json
cloudflared tunnel route dns blockyard api.<yourdomain>.com   # auto-creates the CNAME
```

Then create `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <tunnel-id-from-create-output>
credentials-file: C:\Users\andre\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: api.<yourdomain>.com
    service: http://localhost:8787
  - service: http_status:404
```

Run it:

```bash
cloudflared tunnel run blockyard
```

Point the game at it by setting `VITE_BLOCKYARD_API=https://api.<yourdomain>.com` in the repo root's `.env` before `npm run build:web`.

To survive reboot:

```powershell
cloudflared service install   # runs as a Windows service
```

## Admin notes

- **Ban a token**: edit `data/tokens.json`, set `"banned": true` on that token's entry. Next request with the token gets 403.
- **Force-approve a level**: flip `status` in `data/levels/<id>.json` and `data/index.json`. Easier: use the Discord button.
- **Roll back an approval**: same — edit both files, or add a `/revoke` slash command later.

## What this does NOT do (yet)

- Auto-register slash commands — the button flow covers everything you need.
- Persist rate-limit buckets across restarts — only matters if the server bounces during an abuse spike, which is unlikely for a single-user laptop.
- Send approval/rejection notifications back to the player — they just see the status flip when they refresh the Community tab.
