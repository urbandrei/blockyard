// Drizzle schema for the Blockyard community API.
// Aggregates (likes count, rating_sum/rating_count) live on `levels` so the
// listing query stays a single index scan. Every mutating write updates the
// primary row and its aggregate inside one transaction.

import {
  pgTable, pgEnum, text, boolean, integer, smallint, bigint, uuid, index, primaryKey, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const levelStatus = pgEnum('level_status', ['pending', 'public', 'rejected']);

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
