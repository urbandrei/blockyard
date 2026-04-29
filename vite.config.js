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

// SEO meta block — only shipped on the canonical web build (block-yard.com).
// Itch / Wavedash / Playables / CrazyGames builds run inside iframes or
// platform-owned listing pages and do NOT want canonical URLs, sitemap
// references, or block-yard.com OG URLs leaking into their host page.
function injectSeoPlugin() {
  return {
    name: 'blockyard-inject-seo',
    transformIndexHtml(html) {
      if (PLATFORM !== 'web') return html;
      const SITE = 'https://www.block-yard.com';
      const DESC = 'A puzzle game where you place factories on a grid to manufacture shapes, then design and share your own levels to stump your friends.';
      const TITLE = 'Blockyard | Build & Share Factory Puzzles';
      const OG_IMAGE = `${SITE}/og-image.png`;
      const ldJson = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'VideoGame',
        name: 'Blockyard',
        description: DESC,
        url: SITE,
        image: OG_IMAGE,
        applicationCategory: 'GameApplication',
        genre: 'Puzzle',
        operatingSystem: 'Web Browser',
        author: { '@type': 'Person', name: 'urbandrei' },
      });
      const seo = [
        `<meta name="description" content="${DESC}">`,
        `<meta name="theme-color" content="#412722">`,
        `<meta name="robots" content="index,follow">`,
        `<link rel="canonical" href="${SITE}/">`,
        `<link rel="manifest" href="/manifest.webmanifest">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="Blockyard">`,
        `<meta property="og:title" content="${TITLE}">`,
        `<meta property="og:description" content="${DESC}">`,
        `<meta property="og:url" content="${SITE}/">`,
        `<meta property="og:image" content="${OG_IMAGE}">`,
        `<meta property="og:image:width" content="630">`,
        `<meta property="og:image:height" content="500">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${TITLE}">`,
        `<meta name="twitter:description" content="${DESC}">`,
        `<meta name="twitter:image" content="${OG_IMAGE}">`,
        `<script type="application/ld+json">${ldJson}</script>`,
      ].map((tag) => `  ${tag}`).join('\n');
      let out = html.replace('<title>Blockyard</title>', `<title>${TITLE}</title>`);
      return out.replace('</head>', `${seo}\n</head>`);
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
  plugins: [injectYtgameSdkPlugin(), injectVibejWidgetPlugin(), injectSeoPlugin()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
