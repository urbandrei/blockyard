// One-shot cleanup for levels/*.json.
//
//   1. Sentence-case every `name` and every `instructionalText` in the tree
//      (top-level + boss.rounds[*].instructionalText): uppercase the first
//      letter, lowercase the rest. Runs on every file in levels/.
//
//   2. For files that were exported from the community designer (carry
//      `origin` / `status`), strip the community metadata so the level reads
//      as a plain campaign file — removes `origin`, `status`, `createdAt`,
//      `updatedAt`, and replaces the random `id` with the filename base
//      (e.g. `level-3`). `author` and `solution` are kept.
//
// Run locally from the repo root: `node scripts/normalize-levels.mjs`.
// Idempotent — re-runs produce the same output.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEVELS = join(__dirname, '..', 'levels');

function sentenceCase(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Walk the JSON tree; rewrite `name` and `instructionalText` string values.
// Uses a whitelist of keys so we don't accidentally lowercase author names,
// status strings, ids, etc.
const TARGET_KEYS = new Set(['name', 'instructionalText']);
function normalizeStrings(node) {
  if (Array.isArray(node)) {
    for (const item of node) normalizeStrings(item);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (TARGET_KEYS.has(k) && typeof v === 'string') {
        node[k] = sentenceCase(v);
      } else {
        normalizeStrings(v);
      }
    }
  }
}

function isCommunityExport(level) {
  return 'origin' in level || 'status' in level || 'createdAt' in level || 'updatedAt' in level;
}

function stripCommunityMetadata(level, filenameBase) {
  delete level.origin;
  delete level.status;
  delete level.createdAt;
  delete level.updatedAt;
  // Replace the random community id with the campaign-style filename id.
  level.id = filenameBase;
}

// Re-serialize with a consistent shape: top-level keys in a known order so
// gen-levels.mjs output and designer-exported files end up byte-identical.
// Unknown keys fall to the end, preserving anything the designer emits that
// we don't explicitly reorder.
const KEY_ORDER = [
  'id', 'name', 'number', 'board',
  'factories', 'initialFactories', 'lockedFactories',
  'border', 'inputs', 'outputs',
  'instructionalText', 'boss',
  'author', 'solution', 'likes',
];
function reorder(level) {
  const out = {};
  for (const k of KEY_ORDER) if (k in level) out[k] = level[k];
  for (const k of Object.keys(level)) if (!(k in out)) out[k] = level[k];
  return out;
}

let touched = 0;
for (const entry of readdirSync(LEVELS)) {
  if (extname(entry) !== '.json') continue;
  const path = join(LEVELS, entry);
  const raw = readFileSync(path, 'utf8');
  const level = JSON.parse(raw);

  normalizeStrings(level);
  if (isCommunityExport(level)) {
    stripCommunityMetadata(level, basename(entry, '.json'));
  }

  const next = JSON.stringify(reorder(level), null, 2) + '\n';
  if (next !== raw) {
    writeFileSync(path, next, 'utf8');
    touched++;
    console.log(`normalized ${entry}`);
  }
}

console.log(`\ndone — ${touched} file(s) updated`);
