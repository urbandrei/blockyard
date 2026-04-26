// Local community-level store. Wraps the platform adapter to persist:
//
//   community.index.local     → string[] of local-level ids
//   community.index.imported  → string[] of imported-level ids
//   community.level.<id>      → the full level JSON (schema as level.js)
//   community.likes           → string[] of liked ids (set semantics)
//   community.authorHandle    → display handle the user picked once
//
// Until Milestone H ships the real backend, "search" reads from this local
// pool. `publishLevel` flips a saved level's status to `pending` so the UI
// can show "submitted" without a server. Imported levels are tagged
// origin='imported' on save; locally-authored ones are origin='local'.

import { platform } from '../platform/index.js';
import { genId } from './model/level.js';

const KEY_INDEX_LOCAL    = 'community.index.local';
const KEY_INDEX_IMPORTED = 'community.index.imported';
const KEY_LIKES          = 'community.likes';
const KEY_HIDDEN         = 'community.hidden';
const KEY_AUTHOR         = 'community.authorHandle';
const LEVEL_KEY = (id) => `community.level.${id}`;

let cache = null;

async function loadIndex() {
  if (cache) return cache;
  const [local, imported, likes, hidden, author] = await Promise.all([
    platform.loadData(KEY_INDEX_LOCAL),
    platform.loadData(KEY_INDEX_IMPORTED),
    platform.loadData(KEY_LIKES),
    platform.loadData(KEY_HIDDEN),
    platform.loadData(KEY_AUTHOR),
  ]);
  cache = {
    local:    Array.isArray(local) ? local.slice() : [],
    imported: Array.isArray(imported) ? imported.slice() : [],
    likes:    new Set(Array.isArray(likes) ? likes : []),
    hidden:   new Set(Array.isArray(hidden) ? hidden : []),
    author:   typeof author === 'string' ? author : null,
  };
  return cache;
}

async function persistIndex() {
  if (!cache) return;
  await Promise.all([
    platform.saveData(KEY_INDEX_LOCAL,    cache.local),
    platform.saveData(KEY_INDEX_IMPORTED, cache.imported),
    platform.saveData(KEY_LIKES,          [...cache.likes]),
    platform.saveData(KEY_HIDDEN,         [...cache.hidden]),
  ]);
}

export async function getAuthorHandle() {
  const idx = await loadIndex();
  return idx.author;
}

export async function setAuthorHandle(handle) {
  const idx = await loadIndex();
  const trimmed = (handle || '').trim();
  idx.author = trimmed || null;
  await platform.saveData(KEY_AUTHOR, idx.author);
  return idx.author;
}

// Save a level the user authored. Reuses the level's existing id if it has
// one; otherwise mints a fresh one. Status becomes 'private' on a vanilla
// save (publishLocal flips it to 'pending').
export async function saveLocal(level, { author = null } = {}) {
  const idx = await loadIndex();
  const id = level.id || genId();
  const now = Date.now();
  const stamped = {
    ...level,
    id,
    origin: 'local',
    status: level.status || 'private',
    author: author || level.author || idx.author || null,
    createdAt: level.createdAt || now,
    updatedAt: now,
  };
  if (!idx.local.includes(id)) idx.local.push(id);
  await Promise.all([
    platform.saveData(LEVEL_KEY(id), stamped),
    persistIndex(),
  ]);
  return stamped;
}

// Save an imported level (from JSON). Always assigns a fresh id so two
// imports of the same file don't clobber each other.
export async function saveImported(rawLevel) {
  const idx = await loadIndex();
  const id = genId();
  const now = Date.now();
  const stamped = {
    ...rawLevel,
    id,
    origin: 'imported',
    status: 'imported',
    importedAt: now,
  };
  if (!idx.imported.includes(id)) idx.imported.push(id);
  await Promise.all([
    platform.saveData(LEVEL_KEY(id), stamped),
    persistIndex(),
  ]);
  return stamped;
}

// Mark a saved local level as `pending` (Milestone H will turn this into
// 'public' when the server confirms). No-op when the id isn't local.
export async function setStatus(id, status) {
  const idx = await loadIndex();
  if (!idx.local.includes(id)) return null;
  const level = await platform.loadData(LEVEL_KEY(id));
  if (!level) return null;
  level.status = status;
  level.updatedAt = Date.now();
  await platform.saveData(LEVEL_KEY(id), level);
  return level;
}

// Sync moderation outcomes for every level this device has submitted.
// Pulls /my/submissions, walks each row against the locally-cached level,
// and rewrites the local copy when the server status differs. Returns the
// list of MEANINGFUL transitions (out of 'pending') so CommunityScene can
// surface a toast / reason modal — that loop runs once on scene entry.
//
// Sandboxed adapters (YouTube Playables, mobile, …) return an empty list
// from fetchMySubmissions, so this is a no-op there.
export async function checkSubmissionStatuses() {
  const remote = await platform.fetchMySubmissions();
  if (!Array.isArray(remote) || remote.length === 0) return [];
  const idx = await loadIndex();
  const transitions = [];
  for (const s of remote) {
    if (!s || !s.id) continue;
    if (!idx.local.includes(s.id)) continue;
    const level = await platform.loadData(LEVEL_KEY(s.id));
    if (!level) continue;
    if (level.status === s.status) continue;
    const wasPending = level.status === 'pending';
    level.status = s.status;
    if (s.status === 'rejected') {
      level.rejectedReason = s.rejectedReason || null;
    } else if (level.rejectedReason && s.status !== 'rejected') {
      // Recovered after a denial (mod approved on appeal): clear stale reason.
      level.rejectedReason = null;
    }
    level.updatedAt = Date.now();
    await platform.saveData(LEVEL_KEY(s.id), level);
    if (wasPending) {
      transitions.push({
        id: s.id,
        name: level.name || s.name || 'untitled',
        status: s.status,
        rejectedReason: s.rejectedReason || null,
      });
    }
  }
  return transitions;
}

export async function deleteLevel(id) {
  const idx = await loadIndex();
  idx.local    = idx.local.filter((x) => x !== id);
  idx.imported = idx.imported.filter((x) => x !== id);
  idx.likes.delete(id);
  await Promise.all([
    platform.saveData(LEVEL_KEY(id), null),
    persistIndex(),
  ]);
}

export async function listAll() {
  const idx = await loadIndex();
  const ids = [...idx.local, ...idx.imported];
  const levels = await Promise.all(ids.map((id) => platform.loadData(LEVEL_KEY(id))));
  return levels.filter(Boolean);
}

export async function getCommunityLevelById(id) {
  return platform.loadData(LEVEL_KEY(id));
}

export async function isLiked(id) {
  const idx = await loadIndex();
  return idx.likes.has(id);
}

export async function toggleLike(id) {
  const idx = await loadIndex();
  if (idx.likes.has(id)) idx.likes.delete(id); else idx.likes.add(id);
  await persistIndex();
  return idx.likes.has(id);
}

// ---- hide / unhide (local-only, per-device) ----
// Hidden levels are excluded from every feed except the "Hidden only"
// filter. Purely a client-side preference — the server doesn't know.
export async function isHidden(id) {
  const idx = await loadIndex();
  return idx.hidden.has(id);
}

export async function toggleHide(id) {
  const idx = await loadIndex();
  if (idx.hidden.has(id)) idx.hidden.delete(id); else idx.hidden.add(id);
  await persistIndex();
  return idx.hidden.has(id);
}

export async function getHidden() {
  const idx = await loadIndex();
  return idx.hidden;
}

// Bare snapshot of the set of level ids this device has published locally
// — used by applyFilter to distinguish "mine" vs "others" on the remote
// feed, since remote entries carry only a display author string (not a
// strong identity).
export async function getLocalIds() {
  const idx = await loadIndex();
  return new Set([...idx.local, ...idx.imported]);
}

// Pure list filter / sort used by the search UI.
//   filter: 'all' | 'liked' | 'hidden' | 'mine' | 'others' | 'r1'..'r5'
//     - 'hidden' flips the default "exclude hidden" to "only hidden".
//     - 'mine' / 'others' split the feed on ownership (remote entries in
//       localIds = mine; everything else = others).
//     - 'rN' keeps levels with ratingAvg rounded up >= N. Levels with no
//       rating yet are excluded from rN filters so they don't dominate
//       the list when nobody has rated them.
//   sort: 'recent' | 'likesDesc' | 'likesAsc' | 'ratingDesc'
export function applyFilter(levels, {
  query = '', filter = 'all', sort = 'recent',
  likes, hidden, localIds,
}) {
  const hiddenSet  = hidden   instanceof Set ? hidden   : new Set();
  const localSet   = localIds instanceof Set ? localIds : new Set();
  let out = levels.slice();

  // Hide-aware prefilter: hidden items drop out of every feed except the
  // explicit "Hidden only" view.
  if (filter === 'hidden') out = out.filter((l) => hiddenSet.has(l.id));
  else                     out = out.filter((l) => !hiddenSet.has(l.id));

  const q = (query || '').trim().toLowerCase();
  if (q) out = out.filter((l) => (l.name || '').toLowerCase().includes(q));

  if (filter === 'liked') out = out.filter((l) => likes.has(l.id));

  if (filter === 'mine') {
    out = out.filter((l) =>
      l.origin === 'local' || l.origin === 'imported' || localSet.has(l.id));
  } else if (filter === 'others') {
    out = out.filter((l) => l.origin === 'remote' && !localSet.has(l.id));
  } else if (filter === 'unfinished') {
    out = out.filter((l) => l.status === 'unfinished');
  } else if (filter === 'private') {
    out = out.filter((l) => l.status === 'private');
  }

  const ratingMatch = /^r([1-5])$/.exec(filter);
  if (ratingMatch) {
    const threshold = parseInt(ratingMatch[1], 10);
    out = out.filter((l) => {
      const count = Number(l.ratingCount) || 0;
      if (count <= 0) return false;
      const avg = Number(l.ratingAvg) || 0;
      return Math.ceil(avg) >= threshold;
    });
  }

  switch (sort) {
    case 'likesAsc':
      out.sort((a, b) => (likes.has(a.id) ? 1 : 0) - (likes.has(b.id) ? 1 : 0));
      break;
    case 'likesDesc':
      out.sort((a, b) => (likes.has(b.id) ? 1 : 0) - (likes.has(a.id) ? 1 : 0));
      break;
    case 'ratingDesc':
      // Unrated levels slide to the bottom so rated ones get the top slots.
      out.sort((a, b) => {
        const aRated = (Number(a.ratingCount) || 0) > 0 ? 1 : 0;
        const bRated = (Number(b.ratingCount) || 0) > 0 ? 1 : 0;
        if (aRated !== bRated) return bRated - aRated;
        return (Number(b.ratingAvg) || 0) - (Number(a.ratingAvg) || 0);
      });
      break;
    case 'recent':
    default:
      out.sort((a, b) => (b.updatedAt || b.importedAt || b.createdAt || 0)
                       - (a.updatedAt || a.importedAt || a.createdAt || 0));
  }
  return out;
}

// Bare snapshot of the current likes set — pass into applyFilter without
// awaiting it again on every render.
export async function getLikes() {
  const idx = await loadIndex();
  return idx.likes;
}
