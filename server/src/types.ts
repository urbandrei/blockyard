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

  // ---- Milestone I: Ethereum / level-ownership ----
  // All optional — populated only when the publishing client is web with
  // VITE_BLOCKYARD_ETH_ENABLED=true. The server validates the signature
  // before creating the record; tokenId/txHash arrive in a separate
  // POST /levels/:id/mint call after the on-chain tx confirms.
  authorWallet?: string;          // EIP-55 checksummed address
  authorSignature?: string;       // 0x-prefixed personal_sign over canonical body
  chainId?: number;               // 84532 for Base Sepolia
  tokenId?: string;               // decimal string (BigInt-safe)
  txHash?: string;
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
