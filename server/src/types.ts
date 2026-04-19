// Shared types for the Blockyard community server.

export type LevelStatus = 'pending' | 'public' | 'rejected';

// The full level JSON as produced by the game's ExportPanel, plus server-side metadata.
// We keep the level body opaque (Record<string, unknown>) — the game owns the schema,
// the server just stores and serves it.
export interface LevelRecord {
  id: string;
  status: LevelStatus;
  author: string;
  name: string;
  hint: string | null;            // mirrors level.instructionalText
  cols: number;
  rows: number;
  likes: number;
  createdAt: number;              // ms since epoch
  updatedAt: number;
  submittedByToken: string;       // author's anon token
  submittedFromIp: string | null; // best-effort, for abuse tracing
  rejectedReason?: string;
  rejectedBy?: string;
  approvedBy?: string;
  discordMessageId?: string;      // review channel message — lets us edit on status change
  level: Record<string, unknown>; // the full level JSON as the game stored it
}

export interface IndexEntry {
  id: string;
  name: string;
  author: string;
  hint: string | null;
  cols: number;
  rows: number;
  status: LevelStatus;
  likes: number;
  createdAt: number;
  updatedAt: number;
}

export interface TokenRecord {
  createdAt: number;
  ip: string | null;
  ua: string | null;
  banned?: boolean;
}

// Map shape on disk: { [token]: { [levelId]: 1 } }
export type LikesByToken = Record<string, Record<string, 1>>;
export type TokensMap = Record<string, TokenRecord>;

export interface SearchQuery {
  q?: string;
  sort?: 'recent' | 'likesDesc' | 'likesAsc';
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  levels: IndexEntry[];
  hasMore: boolean;
  total: number;
}
