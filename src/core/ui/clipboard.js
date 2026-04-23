// Cross-context clipboard copy. Skips `navigator.clipboard.writeText` when
// running inside an iframe because most embed hosts (itch.io, newgrounds,
// etc.) don't delegate the `clipboard-write` permissions policy — calling
// the Clipboard API there prints a scary "Permissions policy violation"
// in the console and rejects the promise. The legacy execCommand path
// works without any permission delegation, provided we're called inside
// a user-initiated event handler (which every share button is).
//
// Returns a Promise so callers can await for status toasts. Rejects with
// an Error when both paths fail (extremely rare — most commonly when the
// browser has been hardened and the textarea-select hack is blocked).

function inIframe() {
  try { return window.self !== window.top; }
  catch (e) { return true; }   // cross-origin access throws → we're iframed
}

export function copyText(text) {
  // In iframes, go straight to execCommand to avoid the permissions
  // violation. Out-of-iframe, prefer the modern Clipboard API.
  if (!inIframe() && typeof navigator !== 'undefined'
      && navigator.clipboard && navigator.clipboard.writeText
      && window.isSecureContext) {
    return navigator.clipboard.writeText(String(text)).catch((err) => {
      // Fall back once if the API is present but throws (e.g. focus issues).
      return execCopy(text).catch(() => { throw err; });
    });
  }
  return execCopy(text);
}

function execCopy(text) {
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error('execCommand copy returned false'));
    } catch (e) {
      reject(e);
    }
  });
}
