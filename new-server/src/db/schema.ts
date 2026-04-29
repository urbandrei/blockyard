// Drizzle schema for the Blockyard community API.
// Aggregates (likes count, rating_sum/rating_count) live on `levels` so the
// listing query stays a single index scan. Every mutating write updates the
// primary row and its aggregate inside one transaction.

import {
  pgTable, pgEnum, text, boolean, integer, smallint, bigint, uuid, serial, date, timestamp, index, primaryKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const levelStatus = pgEnum('level_status', ['pending', 'public', 'rejected']);
export const playKind   = pgEnum('play_kind',    ['campaign', 'community']);

export const tokens = pgTable('tokens', {
  token:     text('token').primaryKey(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  ip:        text('ip'),
  ua:        text('ua'),
  banned:    boolean('banned').notNull().default(false),
});

export const levels = pgTable('levels', {
  id:                uuid('id').primaryKey().defaultRandom(),
  status:            levelStatus('status').notNull().default('pending'),
  author:            text('author').notNull(),
  name:              text('name').notNull(),
  hint:              text('hint'),
  cols:              integer('cols').notNull(),
  rows:              integer('rows').notNull(),
  likes:             integer('likes').notNull().default(0),
  ratingSum:         integer('rating_sum').notNull().default(0),
  ratingCount:       integer('rating_count').notNull().default(0),
  // Denormalized completion count — bumped in the same tx as the play
  // session's first transition to completed=true. Listing queries serve
  // this directly instead of count(*)'ing the plays table.
  completions:       integer('completions').notNull().default(0),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
  submittedByToken:  text('submitted_by_token').notNull(),
  submittedFromIp:   text('submitted_from_ip'),
  rejectedReason:    text('rejected_reason'),
  rejectedBy:        text('rejected_by'),
  approvedBy:        text('approved_by'),
  discordMessageId:  text('discord_message_id'),
  shareCode:         text('share_code').notNull(),
}, (t) => ({
  byStatusCreated: index('levels_status_created_at').on(t.status, t.createdAt),
  byStatusLikes:   index('levels_status_likes').on(t.status, t.likes, t.createdAt),
}));

export const likes = pgTable('likes', {
  token:     text('token').notNull(),
  levelId:   uuid('level_id').notNull().references(() => levels.id, { onDelete: 'cascade' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => ({
  pk:       primaryKey({ columns: [t.token, t.levelId] }),
  byLevel:  index('likes_by_level').on(t.levelId),
}));

export const ratings = pgTable('ratings', {
  token:     text('token').notNull(),
  levelId:   uuid('level_id').notNull().references(() => levels.id, { onDelete: 'cascade' }),
  stars:     smallint('stars').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  pk:        primaryKey({ columns: [t.token, t.levelId] }),
  byLevel:   index('ratings_by_level').on(t.levelId),
  starsRange: check('stars_1_to_5', sql`${t.stars} BETWEEN 1 AND 5`),
}));

// Anonymous play telemetry. One row per session — created on level open,
// patched on exit with the final hint count, completion flag, and total
// time spent (ms). Multiple sessions per token are intentional: a player
// who replays a level should produce multiple rows. `kind` distinguishes
// authored campaign levels (level_id = 'level-7' / 'boss-2') from
// community levels (level_id = the levels.id uuid serialized as text).
// No FK to `levels` because level_id covers both kinds.
export const plays = pgTable('plays', {
  id:           uuid('id').primaryKey().defaultRandom(),
  kind:         playKind('kind').notNull(),
  levelId:      text('level_id').notNull(),
  anonToken:    text('anon_token').notNull().references(() => tokens.token, { onDelete: 'cascade' }),
  openedAt:     bigint('opened_at',     { mode: 'number' }).notNull(),
  completedAt:  bigint('completed_at',  { mode: 'number' }),
  hintCount:    integer('hint_count').notNull().default(0),
  timeSpentMs:  integer('time_spent_ms').notNull().default(0),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  byKindLevel:     index('plays_kind_level_id').on(t.kind, t.levelId),
  byKindCompleted: index('plays_kind_completed_at').on(t.kind, t.completedAt),
  byToken:         index('plays_anon_token').on(t.anonToken),
}));

// Daily-featured-level history. One row per UTC date (the date is the PK
// so a date can have at most one featured level). `addedBy` is the Discord
// username of the moderator who queued it via /feature.
export const featuredLevels = pgTable('featured_levels', {
  utcDate:    date('utc_date').primaryKey(),
  levelId:    uuid('level_id').notNull(),
  addedBy:    text('added_by').notNull(),
  promotedAt: timestamp('promoted_at', { withTimezone: true }).notNull().defaultNow(),
});

// FIFO queue of upcoming featured picks. Lazy rotation pops the head into
// `featured_levels` the first time a request lands on a UTC date that
// doesn't yet have a row. UNIQUE on level_id keeps a level from being
// queued twice — re-running /feature on the same id is a no-op.
export const featuredQueue = pgTable('featured_queue', {
  id:        serial('id').primaryKey(),
  levelId:   uuid('level_id').notNull().unique(),
  addedBy:   text('added_by').notNull(),
  queuedAt:  timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
});

// URL shortener. Maps an 8-char base64url id (first 8 chars of sha256 of
// the share code) to the full share_code. Deterministic, so re-shortening
// the same level is a no-op insert. Not tied to `levels` — arbitrary
// share-strings (including unpublished / local-only levels) can be
// shortened.
//
// share_code intentionally has NO unique constraint. Postgres' btree caps
// per-tuple index entries at 2704 bytes (v4), and large levels can serialize
// to >3KB share strings — a unique index on share_code blew up at insert
// time. The `id` PK is itself a deterministic sha256 prefix of share_code,
// so duplicate share_codes always collide on the PK; getOrCreateShortCode
// dedupes by id instead.
export const shortLinks = pgTable('short_links', {
  id:         text('id').primaryKey(),
  shareCode:  text('share_code').notNull(),
  createdAt:  bigint('created_at', { mode: 'number' }).notNull(),
  // True iff a per-level preview PNG was uploaded and persisted to the
  // PREVIEW_DIR mount. /p/:code uses this to decide whether to point
  // og:image at the per-level PNG or fall back to the global og-image.png.
  hasPreview: boolean('has_preview').notNull().default(false),
});
