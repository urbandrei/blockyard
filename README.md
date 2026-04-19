# Blockyard v2

Puzzle editor + circle-flow simulator, rebuilt on **Phaser 3** with a platform-adapter architecture. See `../GAME_PROJECT_REFERENCE.md` for the end-to-end distribution strategy.

v1 (DOM/SVG vanilla JS) is archived at `../blockyard/` for reference.

## Quick start

```bash
npm install
npm run dev
```

## Per-platform builds

Each script selects a platform adapter at bundle time via the `PLATFORM` env var:

```bash
npm run build:web         # own site / generic web
npm run build:itch        # itch.io (uses the web adapter)
npm run build:newgrounds  # + ngio medals / scoreboards
npm run build:youtube     # Playables SDK — injects ytgame script tag
npm run build:wavedash    # stub
npm run build:crazygames  # stub
npm run build:steam       # stub (Electron/Tauri wrapper later)
npm run build:mobile      # stub (Capacitor wrapper later)
```

Output goes to `dist/<platform>/`.

## Architecture

```
src/
  main.js                 # boot: await platform.init() → new Phaser.Game
  core/
    config.js             # Phaser game config
    constants.js          # CYCLE_MS, SHAPE_SCALE, colors
    scenes/               # Boot, Preload, Home, Editor, Player
    model/                # shape.js, level.js (pure logic from v1)
    render/               # Phaser Graphics renderers
    sim/                  # circle simulation
    input/                # DragController
  platform/
    index.js              # picks adapter based on __PLATFORM__
    base.js               # PlatformAdapter interface
    web.js                # localStorage + stubs
    youtube.js            # ytgame SDK wrapper
    newgrounds.js         # extends web + ngio
    stubs/                # wavedash, crazygames, steam, mobile
```

## Critical rules (from the reference doc)

1. **All saves go through `platform.saveData`/`loadData`.** Never touch `localStorage` from core code.
2. **No Page Visibility API.** Pause/resume flows through `platform.onPause`/`onResume` only — YouTube Playables forbids visibility hooks.
3. **Instantiate Phaser only after `platform.init()` resolves.** `DOMContentLoaded` alone races the ytgame SDK.
4. **Blockchain and Ko-fi unlocks are web-only.** Stubs on every other adapter.
