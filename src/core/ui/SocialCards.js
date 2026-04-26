// Definitions for the social-cards carousel that sits below the home
// screen's playable area. Each card has an id, title, subtitle, icon
// drawer, and an action: either a `link` (external URL via the platform
// adapter) or a `modal` (shows a SocialInfoModal with the embedded
// title + body).
//
// Icons are drawn directly via Phaser graphics — no asset preload — so
// adding a new card is a one-file change.

export const SOCIAL_CARDS = [
  {
    id: 'thanks',
    title: 'Thank you!',
    subtitle: 'release notes',
    action: {
      type: 'modal',
      title: 'Thank you!',
      body:
        'Hello everyone!\n' +
        'Thank you so much for checking out my game, Block Yard. I hope you ' +
        'have as much fun playing it as I had making it.\n\n' +
        "It's been a wild two weeks, but I'm really proud of what I've been " +
        "able to put together. When I first started this jam, I wasn't even " +
        "sure I was going to stick with it, but looking back, I'm glad I did.\n\n" +
        'Many thanks to my girlfriend, the guest developers, and my Twitch ' +
        'viewers who helped design levels, brought in audio clips for me to ' +
        'use, tested the game, and shared great ideas and feedback. I ' +
        "wouldn't have been able to get through this without your help and " +
        'support.\n\n' +
        'I also had a splendid time in the gamedev.js community, watching ' +
        'the progress everyone made over the course of this jam. I look ' +
        "forward to playing all your games, as well as seeing the wild " +
        "levels you'll build in mine.\n\n" +
        "You're all awesome,\n" +
        'Urbandrei',
    },
    iconKind: 'shapes',
  },
  {
    id: 'discord',
    title: 'Join the Discord',
    subtitle: 'official Blockyard server',
    action: { type: 'link', url: 'https://discord.gg/Rhb3wbZedF' },
    iconKind: 'discord',
  },
  {
    id: 'twitch',
    title: 'Check out my stream',
    subtitle: 'live on Twitch',
    action: { type: 'link', url: 'https://www.twitch.tv/urbandrei' },
    iconKind: 'twitch',
  },
  {
    id: 'kofi',
    title: 'Buy me a coffee',
    subtitle: 'support on Ko-fi',
    action: { type: 'link', url: 'https://ko-fi.com/urbandrei' },
    iconKind: 'kofi',
  },
  {
    id: 'eth',
    title: 'Ethereum challenge',
    subtitle: 'on-chain level ownership',
    action: {
      type: 'modal',
      title: 'Ethereum challenge',
      body:
        'You can mint your published levels on Base Sepolia so authorship ' +
        'lives on-chain.\n\n' +
        'The mint flow is OFF by default. To turn it on:\n' +
        '  1. Open Settings (gear icon).\n' +
        '  2. Toggle "Ethereum mint flow" ON.\n' +
        '  3. Publish a level. Wallet controls appear in the Export panel.\n\n' +
        'You\u2019ll need a Base Sepolia wallet with a small amount of test ' +
        'ETH for gas.',
    },
    iconKind: 'eth',
  },
  {
    id: 'playables',
    title: 'YouTube Playables',
    subtitle: 'built for the platform',
    action: {
      type: 'modal',
      title: 'YouTube Playables',
      body:
        'This game is also a submission to the Youtube Playables challenge. ' +
        'My initial inspiration for Block Yard came from scrolling through ' +
        'the Youtube Playables category, and seeing games like BlockBuster ' +
        'Puzzle and Element Blocks. I liked the idea of a game utilizing ' +
        'Tetris style blocks, and I had the idea of combining it with ' +
        'automation style games like Factorio.\n\n' +
        'When designing this game, I wanted a game with a mobile first ' +
        'focus, that could work on any size screen, and was touch ' +
        'compatible. Levels were designed to be easily shareable, ' +
        'designable, and playable, with a focus on quick, easy to ' +
        'understand puzzles that still allow for difficult challenges.\n\n' +
        'I truly think my game would be great contender for the playables ' +
        'catalogue.',
    },
    iconKind: 'playables',
  },
  {
    id: 'wavedash',
    title: 'Play it on Wavedash',
    subtitle: 'browser game platform',
    action: { type: 'link', url: 'https://wavedash.com/games/block-yard' },
    iconKind: 'wavedash',
  },
  {
    id: 'phaser',
    title: 'Built with Phaser',
    subtitle: 'JS game framework',
    action: { type: 'link', url: 'https://phaser.io' },
    iconKind: 'phaser',
  },
];

// Map of icon kinds to preloaded image keys (loaded in PreloadScene).
// When the kind has a logo file, we render it via Phaser.Image; the
// hand-drawn `shapes` + `phaser` glyphs stay as Graphics fallbacks
// since no brand logo applies.
const LOGO_KEYS = {
  kofi:      'logo_kofi',
  eth:       'logo_eth',
  discord:   'logo_discord',
  twitch:    'logo_twitch',
  playables: 'logo_playables',
  wavedash:  'logo_wavedash',
  phaser:    'logo_phaser',
};

/**
 * Render the icon for `kind` into `container` (a Phaser.Container).
 * Clears any existing children first. Returns the display object that
 * was added (an Image for branded cards, a Graphics for hand-drawn
 * fallbacks). The icon is centered at (0, 0) inside the container,
 * scaled to fit a `size`-px bounding box.
 */
export function renderSocialIcon(scene, container, kind, size) {
  container.removeAll(true);
  const logoKey = LOGO_KEYS[kind];
  if (logoKey && scene.textures.exists(logoKey)) {
    const img = scene.add.image(0, 0, logoKey);
    const iw = img.width || 1;
    const ih = img.height || 1;
    const scale = size / Math.max(iw, ih);
    img.setScale(scale);
    img.setOrigin(0.5);
    container.add(img);
    return img;
  }
  const g = scene.add.graphics();
  switch (kind) {
    case 'shapes':    drawShapes(g, size);   break;
    case 'phaser':    drawPhaser(g, size);   break;
    case 'kofi':      drawKofi(g, size);     break;
    case 'eth':       drawEthereum(g, size); break;
    case 'playables': drawPlayables(g, size); break;
    case 'twitch':    drawTwitch(g, size);   break;
    case 'discord':   drawDiscord(g, size);  break;
    case 'wavedash':  drawWavedash(g, size); break;
    default:          drawDefault(g, size);  break;
  }
  container.add(g);
  return g;
}

function drawKofi(g, size) {
  // Stylized coffee mug + steam. Body is a rounded rect with a handle
  // arc on the right; two wavy steam lines curl above the rim.
  const w = size * 0.62;
  const h = size * 0.50;
  const cx = -size * 0.05;
  const cy = size * 0.10;
  // Steam (top) — two short wavy strokes.
  g.lineStyle(Math.max(2, Math.floor(size * 0.05)), 0xffffff, 1);
  for (const offX of [-w * 0.18, w * 0.18]) {
    g.beginPath();
    g.moveTo(cx + offX, cy - h * 0.55);
    g.lineTo(cx + offX + size * 0.05, cy - h * 0.75);
    g.lineTo(cx + offX - size * 0.04, cy - h * 0.95);
    g.lineTo(cx + offX + size * 0.03, cy - h * 1.18);
    g.strokePath();
  }
  // Mug body.
  g.fillStyle(0xff5f5f, 1);
  g.lineStyle(Math.max(2, Math.floor(size * 0.05)), 0x6a1a1a, 1);
  g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, h * 0.18);
  g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, h * 0.18);
  // Handle on the right.
  g.lineStyle(Math.max(3, Math.floor(size * 0.07)), 0x6a1a1a, 1);
  g.beginPath();
  g.arc(cx + w / 2, cy, h * 0.30, -Math.PI * 0.6, Math.PI * 0.6, false);
  g.strokePath();
  // White rim line on the mug to suggest the coffee level.
  g.lineStyle(Math.max(2, Math.floor(size * 0.04)), 0xffffff, 0.85);
  g.lineBetween(cx - w / 2 + 4, cy - h * 0.18, cx + w / 2 - 4, cy - h * 0.18);
}

function drawEthereum(g, size) {
  // Diamond logo: top half + bottom half as two stacked triangles, then
  // a smaller centered rhombus on the seam.
  const halfW = size * 0.30;
  const topY  = -size * 0.42;
  const midY  = size * 0.04;
  const botY  = size * 0.46;
  // Top half (lighter).
  g.fillStyle(0xb6c6ff, 1);
  g.beginPath();
  g.moveTo(0, topY);
  g.lineTo(-halfW, midY);
  g.lineTo(0, midY * 0.55);
  g.lineTo(halfW, midY);
  g.closePath();
  g.fillPath();
  // Top half darker right cheek (depth).
  g.fillStyle(0x6f86d8, 1);
  g.beginPath();
  g.moveTo(0, topY);
  g.lineTo(halfW, midY);
  g.lineTo(0, midY * 0.55);
  g.closePath();
  g.fillPath();
  // Bottom half — single triangle pointing down.
  g.fillStyle(0x4661c2, 1);
  g.beginPath();
  g.moveTo(-halfW, midY + 4);
  g.lineTo(halfW, midY + 4);
  g.lineTo(0, botY);
  g.closePath();
  g.fillPath();
  // Outline tying it together.
  g.lineStyle(Math.max(2, Math.floor(size * 0.03)), 0x1a2332, 1);
  g.beginPath();
  g.moveTo(0, topY);
  g.lineTo(-halfW, midY + 2);
  g.lineTo(0, botY);
  g.lineTo(halfW, midY + 2);
  g.closePath();
  g.strokePath();
}

function drawPlayables(g, size) {
  // YouTube Playables: red rounded rect "tile" with a white play
  // triangle, and a small game-controller dot pair below to signal
  // "playable" rather than "video".
  const w = size * 0.78;
  const h = size * 0.56;
  const r = size * 0.14;
  const cy = -size * 0.05;
  g.fillStyle(0xff2424, 1);
  g.lineStyle(Math.max(2, Math.floor(size * 0.04)), 0x7a0a0a, 1);
  g.fillRoundedRect(-w / 2, cy - h / 2, w, h, r);
  g.strokeRoundedRect(-w / 2, cy - h / 2, w, h, r);
  // Play triangle.
  const triH = h * 0.55;
  const triW = triH * 0.78;
  g.fillStyle(0xffffff, 1);
  g.beginPath();
  g.moveTo(-triW * 0.45, cy - triH / 2);
  g.lineTo(-triW * 0.45, cy + triH / 2);
  g.lineTo( triW * 0.55, cy);
  g.closePath();
  g.fillPath();
  // Small "controller dots" below the tile.
  g.fillStyle(0x1a2332, 1);
  const dotR = size * 0.045;
  g.fillCircle(-size * 0.18, cy + h / 2 + dotR + 6, dotR);
  g.fillCircle( size * 0.18, cy + h / 2 + dotR + 6, dotR);
}

function drawShapes(g, size) {
  // Three game shapes clustered tightly into a triangular arrangement —
  // circle at the top, triangle bottom-left, square bottom-right. Each
  // sized + offset so they overlap slightly into a single "team" silhouette.
  const r = size * 0.20;
  const stroke = Math.max(2, Math.floor(size * 0.04));
  const yTop  = -r * 0.65;
  const yBot  =  r * 0.55;
  const xSpread = r * 0.85;
  // Bottom-left: triangle (green) — drawn first so it sits behind the
  // others where they overlap.
  g.fillStyle(0x4caf50, 1);
  g.lineStyle(stroke, 0x000000, 1);
  const tCx = -xSpread;
  const tCy =  yBot;
  const tH  = r * 1.8;
  g.beginPath();
  g.moveTo(tCx,                tCy - tH * 0.55);
  g.lineTo(tCx - r * 0.95,     tCy + tH * 0.40);
  g.lineTo(tCx + r * 0.95,     tCy + tH * 0.40);
  g.closePath();
  g.fillPath();
  g.strokePath();
  // Bottom-right: square (red).
  g.fillStyle(0xd94c4c, 1);
  g.lineStyle(stroke, 0x000000, 1);
  const sSide = r * 1.5;
  const sCx = xSpread - sSide / 2;
  const sCy =  yBot   - sSide / 2;
  g.fillRect(sCx, sCy, sSide, sSide);
  g.strokeRect(sCx, sCy, sSide, sSide);
  // Top: circle (blue) — drawn last so it sits on top of the overlap
  // points with both other shapes.
  g.fillStyle(0x3e8ed0, 1);
  g.lineStyle(stroke, 0x000000, 1);
  g.fillCircle(0, yTop, r);
  g.strokeCircle(0, yTop, r);
}

function drawTwitch(g, size) {
  // Twitch glyph silhouette: tall purple shape with an angled top-left
  // corner cut and a downward "foot" that extends from the bottom edge
  // toward the lower-left. Two short white bars in the upper half read
  // as eyes. Approximates the brand mark without trying to be a pixel-
  // perfect SVG copy.
  const w = size * 0.66;
  const h = size * 0.82;
  const left   = -w / 2;
  const right  =  w / 2;
  const top    = -h / 2;
  const bottom =  h / 2;
  const cut    = size * 0.18;            // top-left diagonal cut
  const baseY  = bottom - h * 0.18;       // where the bottom edge sits before the foot
  const footStartX = left + w * 0.42;     // bottom edge ends here, foot begins
  const footTipX   = footStartX - size * 0.12; // foot tip slightly to the left

  g.fillStyle(0x9146ff, 1);
  g.lineStyle(Math.max(2, Math.floor(size * 0.05)), 0x3d1976, 1);
  g.beginPath();
  g.moveTo(left + cut, top);             // top edge starts after the cut
  g.lineTo(right,      top);             // top-right corner
  g.lineTo(right,      baseY);           // straight down the right side
  g.lineTo(footStartX, baseY);           // bottom edge runs left
  g.lineTo(footTipX,   bottom);          // diagonal down to the foot tip
  g.lineTo(left,       baseY);           // bottom-left corner
  g.lineTo(left,       top + cut);       // up the left edge to the cut
  g.closePath();                          // diagonal cut closes back to top
  g.fillPath();
  g.strokePath();

  // Two short vertical white bars positioned above center for the eyes.
  g.fillStyle(0xffffff, 1);
  const barW = size * 0.06;
  const barH = size * 0.22;
  const barY = -size * 0.10;
  g.fillRect(-size * 0.15 - barW / 2, barY, barW, barH);
  g.fillRect( size * 0.10 - barW / 2, barY, barW, barH);
}

function drawDiscord(g, size) {
  // Discord glyph: rounded "blurple" shield with two big white oval
  // eyes. Approximates the controller-shaped brand mark with a simpler
  // silhouette that still reads at small sizes.
  const w = size * 0.78;
  const h = size * 0.62;
  const cx = 0;
  const cy = 0;
  const r = size * 0.18;
  g.fillStyle(0x5865f2, 1);
  g.lineStyle(Math.max(2, Math.floor(size * 0.04)), 0x2a35a8, 1);
  g.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
  g.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, r);
  // Eyes — wide ovals roughly half the body height tall.
  g.fillStyle(0xffffff, 1);
  const eyeW = w * 0.16;
  const eyeH = h * 0.46;
  const eyeY = cy + h * 0.04;
  g.fillEllipse(cx - w * 0.18, eyeY, eyeW, eyeH);
  g.fillEllipse(cx + w * 0.18, eyeY, eyeW, eyeH);
}

function drawWavedash(g, size) {
  // "Wave + dash" — a horizontal sine wave that ends in a small
  // arrowhead, evoking a fast streak / motion line in Wavedash purple.
  const w = size * 0.86;
  const amp = size * 0.14;
  const stroke = Math.max(3, Math.floor(size * 0.07));
  g.lineStyle(stroke, 0x6c4adb, 1);
  g.beginPath();
  const startX = -w / 2;
  const endX   =  w / 2 - size * 0.10;
  const midY   = 0;
  // Two-period sine: sample N points across the width.
  const N = 32;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = startX + (endX - startX) * t;
    const y = midY + Math.sin(t * Math.PI * 4) * amp;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.strokePath();
  // Arrowhead at the right end pointing the wave forward.
  g.fillStyle(0x6c4adb, 1);
  g.beginPath();
  g.moveTo(endX,            midY - amp * 0.85);
  g.lineTo(endX + size * 0.14, midY);
  g.lineTo(endX,            midY + amp * 0.85);
  g.closePath();
  g.fillPath();
}

function drawPhaser(g, size) {
  // Stylized lightning bolt — evokes Phaser's "energy" naming and the
  // brand's hot magenta color without leaning on letterforms (which
  // don't render cleanly at small sizes via Phaser graphics).
  const w = size * 0.45;
  const h = size * 0.78;
  const stroke = Math.max(2, Math.floor(size * 0.04));
  g.fillStyle(0xed1773, 1);
  g.lineStyle(stroke, 0x6e0a35, 1);
  g.beginPath();
  // Classic 6-vertex bolt outline.
  g.moveTo( w * 0.30, -h / 2);
  g.lineTo(-w * 0.55,  h * 0.10);
  g.lineTo(-w * 0.05,  h * 0.10);
  g.lineTo(-w * 0.30,  h / 2);
  g.lineTo( w * 0.55, -h * 0.05);
  g.lineTo( w * 0.10, -h * 0.05);
  g.closePath();
  g.fillPath();
  g.strokePath();
}

function drawDefault(g, size) {
  g.fillStyle(0x9aa6b2, 1);
  g.lineStyle(2, 0x1a2332, 1);
  g.fillCircle(0, 0, size * 0.35);
  g.strokeCircle(0, 0, size * 0.35);
}
