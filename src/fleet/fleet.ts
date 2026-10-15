/**
 * Fleet mode: share credentials across machines through a central Redis.
 *
 * Each machine still refreshes only its own accounts (unchanged single-machine
 * path). On top of that:
 *  - publish: after every refresh, and every `republishMin`, each account listed
 *    in `fleet.publish` is sealed and written to `ck:cred:<name>`; an event goes
 *    to the `ck:events` stream so other machines pull at once.
 *  - mirror:  each `fleet.mirrors[]` entry is a local copy of an account some
 *    other machine refreshes. It is updated (verbatim credential file + the
 *    login's `oauthAccount`) when the published one is newer, then `onUpdated`
 *    runs. A copy that is not kept fresh raises warn/error before it expires.
 *  - busy:    machines report "a bot using <name> is mid-turn" (`busyCheck`,
 *    exit 75) as short-lived keys; the owner's refresh gate reads them.
 *
 * Redis is a cache, never the source of truth: values are AES-GCM envelopes
 * (see envelope.ts), producers rewrite them periodically, and every failure
 * here is reported but never stops the local refresh path.
 */
import { dirname } from 'node:path';
import type { FleetConfig, Level, MirrorConfig } from '../config.ts';
import { parseCred } from '../cred.ts';
import { claudeConfigFor } from '../label.ts';
import { runScript, succeeded } from '../scripts.ts';
import { ensureDir0700, nowIso, parseJsonObject, readFileNoFollow, writeFileAtomic0600 } from '../util.ts';
import { loadFleetKey, open, seal } from './envelope.ts';
import { parseRedisUrl, RedisConn, withRedis, type RedisTarget, type Reply } from './resp.ts';

const EVENTS = 'ck:events';
const credKey = (name: string) => `ck:cred:${name}`;
const busyKey = (name: string, machine: string) => `ck:busy:${name}:${machine}`;

export type Emit = (account: string | null, type: string, level: Level, data?: Record<string, unknown>) => void;

/** What a producer publishes. `credentials` is the credential file's text, byte for byte. */
export interface Published {
  name: string;
  from: string;
  credentials: string;
  oauthAccount: Record<string, unknown> | null;
  fingerprint: string;
  expiresAt: number;
  publishedAt: number;
}

/** A local account as the fleet sees it: its vault text and credential path. */
export interface LocalSource { vaultText(): string | null; credentialPath: string }

export interface MirrorStatus {
  name: string;
  credentialPath: string;
  fingerprint: string | null;
  accessToken: { expiresAt: string | null; leftMin: number | null };
  from: string | null;
  lastSyncAt: string | null;
  lastUpdateAt: string | null;
  lastError: string | null;
  freshness: 'ok' | 'warn' | 'error' | 'missing';
}

interface MirrorState {
  cfg: MirrorConfig;
  syncing: Promise<void> | null;
  from: string | null;
  lastSyncAt: number | null;
  lastUpdateAt: number | null;
  lastError: string | null;
  /** Fingerprint a warn / error was already raised for (once per credential). */
  warned: string | null;
  errored: string | null;
}

export class Fleet {
  readonly cfg: FleetConfig;
  private readonly target: RedisTarget;
  private readonly key: Buffer;
  private readonly emit: Emit;
  private readonly now: () => number;
  private readonly logDir: string;
  private readonly sources: () => Map<string, LocalSource>;
  private mirrors = new Map<string, MirrorState>();
  private lastPublished = new Map<string, { fp: string; at: number }>();
  private stopped = false;
  private listener: RedisConn | null = null;
  private listening: Promise<void> | null = null;
  /** Hourly dedup of "Redis unreachable" so an outage is one alert, not one per tick. */
  private unreachableHour: string | null = null;

  constructor(cfg: FleetConfig, deps: { emit: Emit; now: () => number; logDir: string; sources: () => Map<string, LocalSource> }) {
    this.cfg = cfg;
    const pw = cfg.redisPasswordFile ? readFileNoFollow(cfg.redisPasswordFile)?.trim() : undefined;
    if (cfg.redisPasswordFile && !pw) throw new Error(`fleet.redisPasswordFile ${cfg.redisPasswordFile} is missing or empty`);
    this.target = parseRedisUrl(cfg.redis, pw);
    this.key = loadFleetKey(cfg.keyFile);
    this.emit = deps.emit;
    this.now = deps.now;
    this.logDir = deps.logDir;
    this.sources = deps.sources;
    for (const m of cfg.mirrors) {
      this.mirrors.set(m.name, { cfg: m, syncing: null, from: null, lastSyncAt: null, lastUpdateAt: null, lastError: null, warned: null, errored: null });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Start the event listener (mirrors only). The periodic tick works without it. */
  start(): void {
    if (this.mirrors.size === 0 || this.listening) return;
    this.listening = this.listen();
  }

  stop(): void {
    this.stopped = true;
    this.listener?.close();
  }

  private async listen(): Promise<void> {
    let last = '$';
    let backoff = 5000;
    while (!this.stopped) {
      try {
        this.listener = await RedisConn.open(this.target);
        backoff = 5000;
        for (;;) {
          if (this.stopped) return;
          const r = await this.listener.cmd(['XREAD', 'BLOCK', 25000, 'COUNT', 100, 'STREAMS', EVENTS, last], 40_000);
          if (r === null) continue; // block timed out
          for (const [, entries] of r as [string, [string, string[]][]][]) {
            for (const [id, fields] of entries) {
              last = id;
              const name = fieldOf(fields, 'name');
              if (name && this.mirrors.has(name)) void this.syncMirror(name);
            }
          }
        }
      } catch {
        this.listener?.close();
        this.listener = null;
        if (this.stopped) return;
        // A reconnect may have missed events: the next tick syncs every mirror anyway.
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  // --------------------------------------------------------------------- tick

  /** Called every service tick: republish, sync and check mirrors, report busy. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.publishDue();
      await Promise.all([...this.mirrors.keys()].map((n) => this.syncMirror(n)));
      this.checkFreshness();
      await this.reportBusy();
    } catch (e) {
      this.unreachable('tick', e as Error);
    }
  }

  /** Pull every mirror now (POST /v1/fleet/sync). */
  async syncAll(): Promise<void> {
    await Promise.all([...this.mirrors.keys()].map((n) => this.syncMirror(n)));
  }

  // ------------------------------------------------------------------ publish

  private async publishDue(): Promise<void> {
    const due: string[] = [];
    for (const id of Object.keys(this.cfg.publish)) {
      const src = this.sources().get(id);
      const parsed = parseCred(src?.vaultText() ?? null);
      if (!parsed.ok) continue;
      const last = this.lastPublished.get(id);
      if (!last || last.fp !== parsed.cred.fingerprint || this.now() - last.at >= this.cfg.republishMin * 60_000) due.push(id);
    }
    for (const id of due) await this.publish(id);
  }

  private inflight = new Map<string, Promise<boolean>>();

  /** Publish one local account now (after a refresh). Failures are reported, never thrown. */
  publish(id: string): Promise<boolean> {
    const cur = this.inflight.get(id);
    if (cur) return cur.then(() => this.publish(id)); // one at a time; the follow-up sees the latest vault
    const p = this.publishInner(id).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return p;
  }

  private async publishInner(id: string): Promise<boolean> {
    const name = this.cfg.publish[id];
    const src = this.sources().get(id);
    if (!name || !src) return false;
    const text = src.vaultText();
    const parsed = parseCred(text);
    if (!parsed.ok || text === null) return false;
    const payload: Published = {
      name,
      from: this.cfg.machine,
      credentials: text,
      oauthAccount: readOauthAccount(src.credentialPath),
      fingerprint: parsed.cred.fingerprint,
      expiresAt: parsed.cred.expiresAt,
      publishedAt: this.now(),
    };
    try {
      await withRedis(this.target, async (c) => {
        await c.cmd(['SET', credKey(name), seal(this.key, credKey(name), payload)]);
        await c.cmd(['XADD', EVENTS, 'MAXLEN', '~', 1000, '*', 'name', name, 'fp', parsed.cred.fingerprint, 'from', this.cfg.machine]);
      });
    } catch (e) {
      this.unreachable(`publish ${name}`, e as Error);
      return false;
    }
    const prev = this.lastPublished.get(id);
    this.lastPublished.set(id, { fp: parsed.cred.fingerprint, at: this.now() });
    if (prev?.fp !== parsed.cred.fingerprint) {
      this.emit(id, 'fleet_published', 'info', { name, fingerprint: parsed.cred.fingerprint });
    }
    return true;
  }

  // ------------------------------------------------------------------- mirror

  /** Pull one mirror from Redis; concurrent calls for the same mirror share one run. */
  syncMirror(name: string): Promise<void> {
    const m = this.mirrors.get(name);
    if (!m) return Promise.resolve();
    if (m.syncing) return m.syncing;
    m.syncing = this.syncMirrorInner(m).finally(() => { m.syncing = null; });
    return m.syncing;
  }

  private async syncMirrorInner(m: MirrorState): Promise<void> {
    const k = credKey(m.cfg.name);
    let sealed: Reply;
    try {
      sealed = await withRedis(this.target, (c) => c.cmd(['GET', k]));
    } catch (e) {
      m.lastError = `redis: ${(e as Error).message}`;
      this.unreachable(`sync ${m.cfg.name}`, e as Error);
      return;
    }
    m.lastSyncAt = this.now();
    if (typeof sealed !== 'string') { m.lastError = 'not published'; return; }
    let p: Published;
    try {
      p = open(this.key, k, sealed) as Published;
      if (p.name !== m.cfg.name || typeof p.credentials !== 'string') throw new Error('payload does not match its key');
    } catch (e) {
      m.lastError = `unreadable: ${(e as Error).message}`;
      this.emit(m.cfg.name, 'mirror_unreadable', 'error', { error: (e as Error).message });
      return;
    }
    const remote = parseCred(p.credentials);
    if (!remote.ok) { m.lastError = `published credential: ${remote.reason}`; return; }
    m.from = p.from;
    m.lastError = null;
    let localText: string | null;
    try { localText = readFileNoFollow(m.cfg.credentialPath); } catch { localText = null; }
    const local = parseCred(localText);
    if (local.ok && local.cred.fingerprint === remote.cred.fingerprint) {
      this.ensureOauthAccount(m.cfg, p.oauthAccount); // e.g. the login file was deleted by hand
      return;
    }
    // Never step back: a replayed or stale publication must not replace a newer copy.
    if (local.ok && remote.cred.expiresAt < local.cred.expiresAt) return;
    try {
      ensureDir0700(dirname(m.cfg.credentialPath));
      writeFileAtomic0600(m.cfg.credentialPath, p.credentials);
      this.ensureOauthAccount(m.cfg, p.oauthAccount);
    } catch (e) {
      m.lastError = `write: ${(e as Error).message}`;
      this.emit(m.cfg.name, 'mirror_write_failed', 'error', { error: (e as Error).message });
      return;
    }
    m.lastUpdateAt = this.now();
    m.warned = null;
    m.errored = null;
    this.emit(m.cfg.name, 'mirror_updated', 'info', {
      from: p.from, fingerprint: remote.cred.fingerprint, previous: local.ok ? local.cred.fingerprint : null,
    });
    await this.runMirrorScript(m.cfg, m.cfg.onUpdated, 'mirror_updated', remote.cred);
  }

  /** Put the login's `oauthAccount` next to the copy; every other field of that file is kept. */
  private ensureOauthAccount(cfg: MirrorConfig, account: Record<string, unknown> | null): void {
    if (!account) return;
    const path = claudeConfigFor(cfg.credentialPath);
    let text: string | null;
    try { text = readFileNoFollow(path); } catch { text = null; }
    const obj = (text !== null ? parseJsonObject(text) : null) ?? {};
    if (JSON.stringify(obj.oauthAccount) === JSON.stringify(account)) return;
    writeFileAtomic0600(path, JSON.stringify({ ...obj, oauthAccount: account }, null, 2));
  }

  private checkFreshness(): void {
    for (const m of this.mirrors.values()) {
      let text: string | null;
      try { text = readFileNoFollow(m.cfg.credentialPath); } catch { text = null; }
      const c = parseCred(text);
      if (!c.ok) continue; // never synced yet: reported through status / lastError
      const left = Math.round((c.cred.expiresAt - this.now()) / 60_000);
      const fp = c.cred.fingerprint;
      if (left < m.cfg.errorMin) {
        if (m.errored !== fp) {
          m.errored = fp;
          this.emit(m.cfg.name, 'mirror_expiring', 'error', { leftMin: left, fingerprint: fp, from: m.from, lastError: m.lastError });
          void this.runMirrorScript(m.cfg, m.cfg.onStale, 'mirror_stale', c.cred);
        }
      } else if (left < m.cfg.warnMin && m.warned !== fp) {
        m.warned = fp;
        this.emit(m.cfg.name, 'mirror_stale', 'warn', { leftMin: left, fingerprint: fp, from: m.from, lastError: m.lastError });
      }
    }
  }

  private async runMirrorScript(cfg: MirrorConfig, script: string | undefined, event: string,
    cred: { fingerprint: string; expiresAt: number; refreshTokenExpiresAt?: number; accessToken: string; refreshToken: string }): Promise<void> {
    if (!script) return;
    const env = {
      CK_ACCOUNT: cfg.name, CK_EVENT: event, CK_CREDENTIAL_PATH: cfg.credentialPath, CK_FINGERPRINT: cred.fingerprint,
      CK_AT_EXPIRES_AT: nowIso(cred.expiresAt), CK_RT_EXPIRES_AT: cred.refreshTokenExpiresAt ? nowIso(cred.refreshTokenExpiresAt) : '',
    };
    const known = [cred.accessToken, cred.refreshToken];
    const opts = { script, env, logDir: this.logDir, redactKnown: known };
    let r = await runScript({ ...opts, timeoutMs: cfg.hookTimeoutSec * 1000, label: `${event}:${cfg.name}` });
    if (!succeeded(r) && !r.timedOut) r = await runScript({ ...opts, timeoutMs: cfg.hookTimeoutSec * 1000, label: `${event}:${cfg.name}#2` });
    const data = { script: event, code: r.code, signal: r.signal, timedOut: r.timedOut, ms: r.ms, error: r.error };
    if (succeeded(r)) this.emit(cfg.name, 'mirror_hook_ok', 'info', data);
    else this.emit(cfg.name, 'mirror_hook_failed', 'critical', data);
  }

  // --------------------------------------------------------------------- busy

  /**
   * Report which mirrored accounts have a bot mid-turn on this machine. Only when
   * the copy is within its owner's refresh window: outside it no refresh can be
   * waiting on the answer, so the check would only cost a process spawn.
   */
  private async reportBusy(): Promise<void> {
    const sets: (string | number)[][] = [];
    for (const m of this.mirrors.values()) {
      if (!m.cfg.busyCheck) continue;
      let text: string | null;
      try { text = readFileNoFollow(m.cfg.credentialPath); } catch { text = null; }
      const c = parseCred(text);
      const k = busyKey(m.cfg.name, this.cfg.machine);
      // 180 min: refresh windows are marginMin (default 120) plus deferral; a margin to spare.
      if (c.ok && c.cred.expiresAt - this.now() > 180 * 60_000) { sets.push(['DEL', k]); continue; }
      const r = await runScript({
        script: m.cfg.busyCheck,
        env: { CK_ACCOUNT: m.cfg.name, CK_EVENT: 'busy_check', CK_CREDENTIAL_PATH: m.cfg.credentialPath },
        timeoutMs: 20_000, logDir: this.logDir, label: `busyCheck:${m.cfg.name}`,
      });
      if (r.code === 75 && !r.timedOut && !r.error) {
        sets.push(['SET', k, seal(this.key, k, { machine: this.cfg.machine, at: this.now() }), 'EX', this.cfg.busyTtlSec]);
      } else {
        sets.push(['DEL', k]); // idle, or a failed check: a failure must not block the owner forever
      }
    }
    if (sets.length === 0) return;
    try {
      await withRedis(this.target, async (c) => { for (const s of sets) await c.cmd(s); });
    } catch (e) {
      this.unreachable('busy report', e as Error);
    }
  }

  /**
   * For the owner's refresh gate: is a bot on another machine mid-turn on this
   * local account? null = could not tell (Redis down) — the caller does not defer.
   */
  async remoteBusy(id: string): Promise<{ busy: boolean; machines: string[] } | null> {
    const name = this.cfg.publish[id];
    if (!name) return { busy: false, machines: [] };
    try {
      return await withRedis(this.target, async (c) => {
        const keys = (await c.cmd(['KEYS', `ck:busy:${name}:*`])) as string[];
        const machines: string[] = [];
        for (const k of keys) {
          const v = await c.cmd(['GET', k]);
          if (typeof v !== 'string') continue;
          try {
            const b = open(this.key, k, v) as { machine?: unknown; at?: unknown };
            if (typeof b.machine === 'string' && b.machine !== this.cfg.machine && typeof b.at === 'number'
                && this.now() - b.at < this.cfg.busyTtlSec * 1000) machines.push(b.machine);
          } catch { /* forged or foreign: ignored */ }
        }
        return { busy: machines.length > 0, machines };
      });
    } catch (e) {
      this.unreachable('busy query', e as Error);
      return null;
    }
  }

  // ------------------------------------------------------------------- status

  status(): { machine: string; publish: Record<string, string>; mirrors: MirrorStatus[] } {
    return {
      machine: this.cfg.machine,
      publish: { ...this.cfg.publish },
      mirrors: [...this.mirrors.values()].map((m) => {
        let text: string | null;
        try { text = readFileNoFollow(m.cfg.credentialPath); } catch { text = null; }
        const c = parseCred(text);
        const left = c.ok ? Math.round((c.cred.expiresAt - this.now()) / 60_000) : null;
        return {
          name: m.cfg.name,
          credentialPath: m.cfg.credentialPath,
          fingerprint: c.ok ? c.cred.fingerprint : null,
          accessToken: { expiresAt: c.ok ? nowIso(c.cred.expiresAt) : null, leftMin: left },
          from: m.from,
          lastSyncAt: m.lastSyncAt === null ? null : nowIso(m.lastSyncAt),
          lastUpdateAt: m.lastUpdateAt === null ? null : nowIso(m.lastUpdateAt),
          lastError: m.lastError,
          freshness: left === null ? 'missing' : left < m.cfg.errorMin ? 'error' : left < m.cfg.warnMin ? 'warn' : 'ok',
        };
      }),
    };
  }

  private unreachable(stage: string, e: Error): void {
    const hour = nowIso(this.now()).slice(0, 13);
    if (this.unreachableHour === hour) return;
    this.unreachableHour = hour;
    this.emit(null, 'fleet_unreachable', 'warn', { stage, error: e.message });
  }
}

function fieldOf(fields: string[], name: string): string | null {
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return null;
}

/** The logged-in account record next to a credential file (who the login is), or null. */
function readOauthAccount(credentialPath: string): Record<string, unknown> | null {
  let text: string | null;
  try { text = readFileNoFollow(claudeConfigFor(credentialPath)); } catch { return null; }
  const o = text !== null ? parseJsonObject(text)?.oauthAccount : null;
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
}
