// Shared response/record types. Drizzle's inferred row types stay in db/
// modules; this file is the shape we expose over the wire.

export type LevelStatus = 'pending' | 'public' | 'rejected';
export type SortOption = 'recent' | 'likesDesc' | 'likesAsc' | 'ratingDesc';

export interface IndexEntry {
  id: string;
  name: string;
  author: string;
  hint: string | null;
  cols: number;
  rows: number;
  status: LevelStatus;
  likes: number;
  ratingAvg: number | null;
  ratingCount: number;
  completions: number;
  createdAt: number;
  updatedAt: number;
}

export interface SearchResult {
  levels: IndexEntry[];
  hasMore: boolean;
  total: number;
}

export interface LevelDetail {
  id: string;
  name: string;
  author: string;
  hint: string | null;
  cols: number;
  rows: number;
  status: LevelStatus;
  likes: number;
  ratingAvg: number | null;
  ratingCount: number;
  completions: number;
  createdAt: number;
  updatedAt: number;
  level: Record<string, unknown>;   // decoded share-string
}
