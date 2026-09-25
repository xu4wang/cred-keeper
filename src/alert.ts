/**
 * Alert dispatch: core decides + dedupes, the configured script delivers.
 * No script configured → no alerts (events are still recorded).
 */
import type { Config, Level } from './config.ts';
import { LEVELS } from './config.ts';
import { paths } from './config.ts';
import { runScript, succeeded } from './scripts.ts';
import type { Store } from './store.ts';

export interface AlertEvent {
  eventId: number;
  type: string;
  level: Level;
  account: string | null;
  title: string;
  message: string;
  dedupKey: string;
  data: Record<string, unknown>;
}

/** Events that always go to the script (subject to dedupe) regardless of minLevel. */
const ALWAYS = new Set(['recovered', 'heartbeat']);
const BACKOFF_MS = [30_000, 120_000, 600_000];

export class Alerter {
  private queue: Promise<void> = Promise.resolve();
  readonly cfg: Config;
  readonly store: Store;
  readonly sleep: (ms: number) => Promise<unknown>;
  constructor(cfg: Config, store: Store, sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.cfg = cfg;
    this.store = store;
    this.sleep = sleep;
  }

  get enabled(): boolean { return !!this.cfg.alert; }

  shouldSend(type: string, level: Level): boolean {
    if (!this.cfg.alert) return false;
    if (ALWAYS.has(type)) return true;
    return LEVELS.indexOf(level) >= LEVELS.indexOf(this.cfg.alert.minLevel);
  }

  /** Returns true when queued. Dedupe: one delivery per (account, type, dedupKey). */
  offer(ev: AlertEvent): boolean {
    if (!this.shouldSend(ev.type, ev.level)) return false;
    const k = `alert:${ev.account ?? '-'}:${ev.type}:${ev.dedupKey}`;
    if (this.store.get(k)) return false;
    this.store.set(k, new Date().toISOString());
    this.queue = this.queue.then(() => this.deliver(ev)).catch(() => {});
    return true;
  }

  /** Allow the same (account, type) to alert again, e.g. after recovery. */
  reset(account: string | null, type: string): void {
    this.store.db.prepare('DELETE FROM kv WHERE k LIKE ?').run(`alert:${account ?? '-'}:${type}:%`);
  }

  drain(): Promise<void> { return this.queue; }

  private async deliver(ev: AlertEvent): Promise<void> {
    const a = this.cfg.alert!;
    const env = {
      CK_EVENT: ev.type, CK_LEVEL: ev.level, CK_ACCOUNT: ev.account ?? '', CK_TITLE: ev.title, CK_DEDUP_KEY: ev.dedupKey,
    };
    const stdin = JSON.stringify(ev);
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const r = await runScript({ script: a.script, env, stdin, timeoutMs: a.timeoutSec * 1000,
        logDir: paths(this.cfg).logDir, label: `alert:${ev.type}` });
      if (succeeded(r)) return;
      if (attempt < BACKOFF_MS.length) await this.sleep(BACKOFF_MS[attempt]);
    }
    this.store.addEvent(ev.account, 'alert_undelivered', 'error', { forEvent: ev.eventId, type: ev.type });
    // Not delivered: release the dedupe key so the next occurrence can try again.
    this.store.db.prepare('DELETE FROM kv WHERE k = ?').run(`alert:${ev.account ?? '-'}:${ev.type}:${ev.dedupKey}`);
  }
}
