import { defineConfig } from 'vite';

const PLATFORM = process.env.PLATFORM || 'web';

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

export default defineConfig({
  // Relative asset paths so `assets/index-xxx.js` resolves next to
  // index.html rather than at the origin root. Required by itch.io
  // (game served from a hashed subpath) and harmless everywhere else.
  base: './',
  define: {
    __PLATFORM__: JSON.stringify(PLATFORM),
  },
  plugins: [injectYtgameSdkPlugin()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
