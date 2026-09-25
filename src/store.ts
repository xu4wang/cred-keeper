import { DatabaseSync } from 'node:sqlite';
import type { Level } from './config.ts';

export interface EventRow {
  id: number;
  at: string;
  account: string | null;
  type: string;
  level: Level;
  /** Structured, secret-free details. Script output is never stored here. */
  data: Record<string, unknown>;
}

export interface UsageRow {
  account: string;
  at: string;
  payload: Record<string, unknown>;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, account TEXT, type TEXT NOT NULL, level TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS usage(account TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_acct_at ON usage(account, at);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  addEvent(account: string | null, type: string, level: Level, data: Record<string, unknown> = {}, at = new Date().toISOString()): number {
    const r = this.db.prepare('INSERT INTO events(at, account, type, level, data) VALUES (?,?,?,?,?)')
      .run(at, account, type, level, JSON.stringify(data));
    return Number(r.lastInsertRowid);
  }

  events(q: { account?: string; type?: string; since?: string; limit?: number }): EventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.account) { where.push('account = ?'); args.push(q.account); }
    if (q.type) { where.push('type = ?'); args.push(q.type); }
    if (q.since) { where.push('at >= ?'); args.push(q.since); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(Math.min(Math.max(q.limit ?? 200, 1), 1000));
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  addUsage(account: string, payload: Record<string, unknown>, at = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO usage(account, at, payload) VALUES (?,?,?)').run(account, at, JSON.stringify(payload));
  }

  usageHistory(account: string, since: string): UsageRow[] {
    return (this.db.prepare('SELECT * FROM usage WHERE account = ? AND at >= ? ORDER BY at').all(account, since) as any[])
      .map((r) => ({ account: r.account, at: r.at, payload: JSON.parse(r.payload) }));
  }

  get(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
    return r?.v;
  }

  set(k: string, v: string): void {
    this.db.prepare('INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  close(): void {
    this.db.close();
  }
}
