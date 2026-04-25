// JSON-on-disk store. All mutations serialize through a per-path mutex
// (atomic writes to .tmp then rename) so concurrent bot buttons + HTTP
// requests can't interleave-corrupt a file.

import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  LevelRecord, IndexEntry, TokenRecord, LikesByToken, TokensMap,
  SearchQuery, SearchResult, LevelStatus
} from './types.ts';

export class Store {
  readonly root: string;
  private locks = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
  }

  async init() {
    await mkdir(path.join(this.root, 'levels'), { recursive: true });
    for (const [file, fallback] of [
      ['index.json', '[]'],
      ['likes.json', '{}'],
      ['tokens.json', '{}'],
    ] as const) {
      const p = path.join(this.root, file);
      if (!existsSync(p)) await writeFile(p, fallback, 'utf8');
    }
    // One-time recovery: if index.json is empty but levels/ has files, rebuild.
    const idx = await this.readIndex();
    if (idx.length === 0) {
      const files = await readdir(path.join(this.root, 'levels')).catch(() => []);
      if (files.length > 0) await this.rebuildIndex();
    }
  }

  // ---- primitive atomic IO ----

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tracked = next.catch(() => undefined);
    this.locks.set(key, tracked);
    try { return await next; } finally {
      if (this.locks.get(key) === tracked) this.locks.delete(key);
    }
  }

  private async readJson<T>(rel: string, fallback: T): Promise<T> {
    try {
      const txt = await readFile(path.join(this.root, rel), 'utf8');
      return JSON.parse(txt) as T;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  private async writeJson(rel: string, value: unknown): Promise<void> {
    const abs = path.join(this.root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp';
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, abs);
  }

  // ---- levels ----

  private levelPath(id: string) { return path.join('levels', `${id}.json`); }

  async readLevel(id: string): Promise<LevelRecord | null> {
    return this.readJson<LevelRecord | null>(this.levelPath(id), null);
  }

  async writeLevel(rec: LevelRecord): Promise<void> {
    await this.withLock(`level:${rec.id}`, async () => {
      await this.writeJson(this.levelPath(rec.id), rec);
    });
    await this.updateIndexEntry(rec);
  }

  // Honours a client-provided id when supplied (keeps local + server records
  // aligned so the game doesn't need id reconciliation). If that id already
  // exists on disk we fall back to a fresh UUID so two players can't clobber
  // each other via id collision.
  async createLevel(args: {
    level: Record<string, unknown>;
    name: string;
    author: string;
    hint: string | null;
    cols: number;
    rows: number;
    token: string;
    ip: string | null;
    clientId?: string | null;
    // Optional eth metadata. When present, the http layer has already
    // verified the signature against authorWallet, so we can trust it here.
    authorWallet?: string;
    authorSignature?: string;
    chainId?: number;
  }): Promise<LevelRecord> {
    const now = Date.now();
    const requested = (args.clientId ?? '').trim();
    const safe = /^[A-Za-z0-9_-]{1,64}$/.test(requested) ? requested : '';
    let id = safe;
    if (!id || (await this.readLevel(id))) id = randomUUID();
    const rec: LevelRecord = {
      id,
      status: 'pending',
      author: args.author,
      name: args.name,
      hint: args.hint,
      cols: args.cols,
      rows: args.rows,
      likes: 0,
      createdAt: now,
      updatedAt: now,
      submittedByToken: args.token,
      submittedFromIp: args.ip,
      level: { ...args.level, id, status: 'pending' },
    };
    if (args.authorWallet)    rec.authorWallet    = args.authorWallet;
    if (args.authorSignature) rec.authorSignature = args.authorSignature;
    if (args.chainId)         rec.chainId         = args.chainId;
    await this.writeLevel(rec);
    return rec;
  }

  // Records the on-chain mint for a previously-created level. Gated by
  // submittedByToken match in http.ts so a different client can't claim
  // someone else's level. Idempotent: re-recording with the same tokenId
  // is a no-op; recording a new tokenId overwrites (the contract is
  // append-only on its end so a second mint yields a different id, and
  // the latest record reflects the canonical owner per our own server).
  async recordMint(id: string, args: {
    tokenId: string;
    txHash: string;
    token: string;
  }): Promise<LevelRecord | null> {
    return this.withLock(`level:${id}`, async () => {
      const rec = await this.readJson<LevelRecord | null>(this.levelPath(id), null);
      if (!rec) return null;
      if (rec.submittedByToken !== args.token) return null;
      rec.tokenId = args.tokenId;
      rec.txHash  = args.txHash;
      rec.updatedAt = Date.now();
      await this.writeJson(this.levelPath(id), rec);
      await this.updateIndexEntry(rec);
      return rec;
    });
  }

  async setStatus(id: string, status: LevelStatus, meta: {
    approvedBy?: string; rejectedBy?: string; rejectedReason?: string; discordMessageId?: string;
  } = {}): Promise<LevelRecord | null> {
    return this.withLock(`level:${id}`, async () => {
      const rec = await this.readJson<LevelRecord | null>(this.levelPath(id), null);
      if (!rec) return null;
      rec.status = status;
      rec.updatedAt = Date.now();
      if (meta.approvedBy) rec.approvedBy = meta.approvedBy;
      if (meta.rejectedBy) rec.rejectedBy = meta.rejectedBy;
      if (meta.rejectedReason) rec.rejectedReason = meta.rejectedReason;
      if (meta.discordMessageId) rec.discordMessageId = meta.discordMessageId;
      rec.level = { ...rec.level, status };
      await this.writeJson(this.levelPath(id), rec);
      await this.updateIndexEntry(rec);
      return rec;
    });
  }

  async setDiscordMessageId(id: string, messageId: string): Promise<void> {
    await this.withLock(`level:${id}`, async () => {
      const rec = await this.readJson<LevelRecord | null>(this.levelPath(id), null);
      if (!rec) return;
      rec.discordMessageId = messageId;
      await this.writeJson(this.levelPath(id), rec);
    });
  }

  // ---- index ----

  async readIndex(): Promise<IndexEntry[]> {
    return this.readJson<IndexEntry[]>('index.json', []);
  }

  private indexEntryOf(rec: LevelRecord): IndexEntry {
    return {
      id: rec.id, name: rec.name, author: rec.author, hint: rec.hint,
      cols: rec.cols, rows: rec.rows, status: rec.status, likes: rec.likes,
      createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    };
  }

  private async updateIndexEntry(rec: LevelRecord): Promise<void> {
    await this.withLock('index', async () => {
      const idx = await this.readIndex();
      const entry = this.indexEntryOf(rec);
      const at = idx.findIndex(e => e.id === rec.id);
      if (at === -1) idx.push(entry); else idx[at] = entry;
      await this.writeJson('index.json', idx);
    });
  }

  async rebuildIndex(): Promise<number> {
    return this.withLock('index', async () => {
      const files = await readdir(path.join(this.root, 'levels'));
      const entries: IndexEntry[] = [];
      for (const f of files) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
        const rec = await this.readJson<LevelRecord | null>(path.join('levels', f), null);
        if (rec) entries.push(this.indexEntryOf(rec));
      }
      await this.writeJson('index.json', entries);
      return entries.length;
    });
  }

  // ---- search ----

  async search(query: SearchQuery): Promise<SearchResult> {
    const idx = await this.readIndex();
    const q = (query.q ?? '').trim().toLowerCase();
    const sort = query.sort ?? 'recent';
    const page = Math.max(0, query.page ?? 0);
    const pageSize = Math.max(1, Math.min(50, query.pageSize ?? 5));

    let filtered = idx.filter(e => e.status === 'public');
    if (q) filtered = filtered.filter(e =>
      e.name.toLowerCase().includes(q) || e.author.toLowerCase().includes(q));

    filtered.sort((a, b) => {
      if (sort === 'likesDesc') return b.likes - a.likes || b.createdAt - a.createdAt;
      if (sort === 'likesAsc') return a.likes - b.likes || b.createdAt - a.createdAt;
      return b.createdAt - a.createdAt;
    });

    const start = page * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    return { levels: slice, hasMore: start + slice.length < filtered.length, total: filtered.length };
  }

  async listPending(): Promise<IndexEntry[]> {
    const idx = await this.readIndex();
    return idx.filter(e => e.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---- likes ----

  async toggleLike(token: string, levelId: string, liked: boolean): Promise<{ likes: number } | null> {
    return this.withLock(`level:${levelId}`, async () => {
      const rec = await this.readJson<LevelRecord | null>(this.levelPath(levelId), null);
      if (!rec || rec.status !== 'public') return null;

      const likes = await this.readJson<LikesByToken>('likes.json', {});
      const byUser = likes[token] ?? (likes[token] = {});
      const was = byUser[levelId] === 1;
      if (liked && !was) { byUser[levelId] = 1; rec.likes++; }
      else if (!liked && was) { delete byUser[levelId]; rec.likes = Math.max(0, rec.likes - 1); }
      else return { likes: rec.likes };

      rec.updatedAt = Date.now();
      await this.writeJson('likes.json', likes);
      await this.writeJson(this.levelPath(levelId), rec);
      await this.updateIndexEntry(rec);
      return { likes: rec.likes };
    });
  }

  async getLikesForToken(token: string): Promise<string[]> {
    const likes = await this.readJson<LikesByToken>('likes.json', {});
    return Object.keys(likes[token] ?? {});
  }

  // ---- tokens ----

  async saveToken(token: string, rec: TokenRecord): Promise<void> {
    await this.withLock('tokens', async () => {
      const all = await this.readJson<TokensMap>('tokens.json', {});
      all[token] = rec;
      await this.writeJson('tokens.json', all);
    });
  }

  async getToken(token: string): Promise<TokenRecord | null> {
    const all = await this.readJson<TokensMap>('tokens.json', {});
    return all[token] ?? null;
  }
}
