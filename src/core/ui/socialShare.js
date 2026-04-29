// Native "Share" flow shared between ExportPanel, LevelCard dropdown,
// and PlayerScene. Wraps:
//   1. Build the share URL (short-code preferred, `?play=<base64>` fallback).
//   2. Render a 1080x1920 preview PNG of the level.
//   3. Hand the bundle to navigator.share (with files when the browser
//      supports it; url/text-only when not).
//   4. Clipboard-copy the URL as a last-resort fallback.
//
// Caller passes a `level` object (the same shape `_encodeShareString`
// accepts) and optional hooks for surfacing progress/errors. Return is a
// Promise that resolves when the share sheet closes (user confirmed or
// cancelled) — rejects only on truly unexpected errors; cancellation is
// just a successful no-op.

import { platform } from '../../platform/index.js';
import { generateShareImage } from './sharePreview.js';
import { copyText } from './clipboard.js';
import { utcToday } from '../progress.js';

const BLOCK_YARD_SHARE_URL = 'https://www.block-yard.com';
const ITCH_SHARE_URL       = 'https://urbandrei.itch.io/block-yard';

export function canNativeShare() {
  return typeof navigator !== 'undefined' && navigator && typeof navigator.share === 'function';
}

export function shareBaseForCurrentOrigin() {
  try {
    const host = (window.location && window.location.hostname) || '';
    if (/\.itch\.(zone|io)$/i.test(host)) return ITCH_SHARE_URL;
  } catch (e) {}
  return BLOCK_YARD_SHARE_URL;
}

function withShareParam(base, name, value) {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${name}=${encodeURIComponent(value)}`;
}

// Strip the display-only line-breaks ExportPanel injects into the share
// string so the URL-param form is a single contiguous base64 blob.
function unchunk(shareString) {
  return String(shareString || '').replace(/\s+/g, '');
}

/**
 * @param {object} opts
 * @param {Phaser.Scene} opts.scene  active scene used to create the off-screen RenderTexture
 * @param {object} opts.level        the level JSON — must have board / factories / etc.
 * @param {string} opts.shareString  the base64 share-string (ExportPanel._encodeShareString output)
 * @param {(msg:string)=>void} [opts.onStatus]  optional status-text sink for the caller's UI
 * @param {string} [opts.featuredUtcDate]  YYYY-MM-DD UTC date if this level was launched as a daily featured; switches the share text to the featured-style line when it matches today.
 */
export async function shareLevel(opts) {
  const { scene, level, shareString, featuredUtcDate } = opts;
  const status = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  if (!level || !shareString) { status('Nothing to share.'); return; }
  if (!scene) { status('Cannot render preview — no scene.'); return; }

  status('Preparing preview\u2026');
  const raw = unchunk(shareString);
  const base = shareBaseForCurrentOrigin();

  // Render the per-level preview FIRST so we can hand it to the shortener
  // alongside the share-code. Failures here are non-fatal; we just lose
  // the per-level OG card and fall back to the global og-image.png.
  let blob = null;
  try {
    blob = await generateShareImage(scene, level, { url: base.replace(/^https?:\/\//, '') });
  } catch (e) {
    console.warn('[share] preview generation failed', e);
  }

  // Backend shortener is best-effort; fall back to the in-app `?play=` URL
  // whenever it can't respond. When the preview upload succeeds, prefer
  // the OG-tagged `ogUrl` (api host) so Discord/Twitter/Slack unfurl the
  // per-level card; otherwise stay on the canonical origin with `?s=`.
  let previewBase64 = null;
  if (blob) {
    try { previewBase64 = await blobToBase64(blob); } catch (e) {}
  }
  let shortenResult = null;
  try {
    shortenResult = await platform.shortenShareCode(raw, previewBase64 ? { previewImage: previewBase64 } : undefined);
  } catch (e) {}
  const url = shortenResult && shortenResult.ogUrl
    ? shortenResult.ogUrl
    : shortenResult && shortenResult.code
      ? withShareParam(base, 's', shortenResult.code)
      : withShareParam(base, 'play', raw);

  const name = level.name || 'Blockyard level';
  const isFeaturedToday = !!featuredUtcDate && featuredUtcDate === utcToday();
  const text = isFeaturedToday
    ? `Check out today's featured Block Yard puzzle: "${name}". Can you solve it? #blockyard #puzzle`
    : `Check out "${name}" on Block Yard. Can you solve it? #blockyard #puzzle`;
  const filename = safeFilename(name) + '.png';

  try {
    if (blob && navigator.canShare) {
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'Blockyard', text, url, files: [file] });
        status('Shared.');
        return;
      }
    }
    if (navigator.share) {
      await navigator.share({ title: 'Blockyard', text, url });
      status('Shared.');
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') { status(''); return; }   // user cancelled
    console.warn('[share] navigator.share failed', e);
  }

  try {
    await copyText(url);
    status('Sharing not available \u2014 URL copied instead.');
  } catch (e) {
    status('Could not share or copy — ' + (e && e.message || 'unknown error'));
  }
}

function safeFilename(name) {
  return String(name || 'level').toLowerCase().replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
}

// FileReader → data URL → base64 body. Returns the BARE base64 (no
// `data:image/png;base64,` prefix) so the backend doesn't have to strip it.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const out = String(reader.result || '');
      const i = out.indexOf(',');
      resolve(i >= 0 ? out.slice(i + 1) : out);
    };
    reader.onerror = () => reject(reader.error || new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}

// Base64 of a minified level JSON with runtime-only fields stripped.
// Matches ExportPanel._encodeShareString byte-for-byte modulo the
// display-only chunking. Use this when you need the share-string for a
// level that ExportPanel didn't produce (e.g. a remote-fetched body the
// Community scene wants to native-share).
export function encodeShareString(level) {
  const clean = { ...level };
  delete clean.likes;
  delete clean.updatedAt;
  delete clean.importedAt;
  const json = JSON.stringify(clean);
  try {
    const utf8 = unescape(encodeURIComponent(json));
    return btoa(utf8);
  } catch (e) {
    return json;
  }
}
