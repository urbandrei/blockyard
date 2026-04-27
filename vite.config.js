import { defineConfig } from 'vite';

const PLATFORM = process.env.PLATFORM || 'web';
// vibej.am 2026 jam mode. Off by default so itch / wavedash / youtube
// builds don't ship the tracking widget or the portal UI; flipped on by
// `build:render` (and `VIBEJAM=1 npm run dev` for local mirroring).
const VIBEJAM = process.env.VIBEJAM === '1';

// For the YouTube Playables build we inject the ytgame SDK script tag BEFORE
// the bundle script so window.ytgame is resolvable by the time platform.init()
// polls for it. Every other build leaves index.html untouched.
function injectYtgameSdkPlugin() {
  return {
    name: 'blockyard-inject-ytgame',
    transformIndexHtml(html) {
      if (PLATFORM !== 'youtube') return html;
      const sdk = '<script src="https://www.youtube.com/game_api/v1"></script>';
      return html.replace('</head>', `  ${sdk}\n</head>`);
    },
  };
}

// vibej.am 2026 widget — mandatory tracking for jam participation, but
// only the render-deployed page should ship it. Other web exports
// (itch / wavedash) leave the bundle widget-free.
function injectVibejWidgetPlugin() {
  return {
    name: 'blockyard-inject-vibej',
    transformIndexHtml(html) {
      if (!VIBEJAM) return html;
      const widget = '<script async src="https://vibej.am/2026/widget.js"></script>';
      return html.replace('</head>', `  ${widget}\n</head>`);
    },
  };
}

export default defineConfig({
  // Relative asset paths so `assets/index-xxx.js` resolves next to
  // index.html rather than at the origin root. Required by itch.io
  // (game served from a hashed subpath) and harmless everywhere else.
  base: './',
  define: {
    __PLATFORM__: JSON.stringify(PLATFORM),
    __VIBEJAM__: JSON.stringify(VIBEJAM),
  },
  plugins: [injectYtgameSdkPlugin(), injectVibejWidgetPlugin()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
