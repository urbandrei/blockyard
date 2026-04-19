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
const KEY_AUTHOR         = 'community.authorHandle';
const LEVEL_KEY = (id) => `community.level.${id}`;

let cache = null;

async function loadIndex() {
  if (cache) return cache;
  const [local, imported, likes, author] = await Promise.all([
    platform.loadData(KEY_INDEX_LOCAL),
    platform.loadData(KEY_INDEX_IMPORTED),
    platform.loadData(KEY_LIKES),
    platform.loadData(KEY_AUTHOR),
  ]);
  cache = {
    local:    Array.isArray(local) ? local.slice() : [],
    imported: Array.isArray(imported) ? imported.slice() : [],
    likes:    new Set(Array.isArray(likes) ? likes : []),
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

// Pure list filter / sort used by the search UI. Until backend, "likes" on
// a level = 1 if the local user liked it, else 0 — sort stable enough to
// preview the UX that ships when the real counter goes live.
export function applyFilter(levels, { query = '', filter = 'all', sort = 'recent', likes }) {
  let out = levels.slice();
  const q = (query || '').trim().toLowerCase();
  if (q) out = out.filter((l) => (l.name || '').toLowerCase().includes(q));
  if (filter === 'liked') out = out.filter((l) => likes.has(l.id));
  switch (sort) {
    case 'likesAsc':
      out.sort((a, b) => (likes.has(a.id) ? 1 : 0) - (likes.has(b.id) ? 1 : 0));
      break;
    case 'likesDesc':
      out.sort((a, b) => (likes.has(b.id) ? 1 : 0) - (likes.has(a.id) ? 1 : 0));
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
