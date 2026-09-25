/**
 * One managed account: authoritative vault copy, publication to
 * credentialPath, refresh with pending-response recovery, onRefreshed hook.
 */
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { AccountConfig, Config, Level } from './config.ts';
import { paths } from './config.ts';
import { mergeTokenResponse, parseCred, type OauthCred, type TokenResponse } from './cred.ts';
import { acquireLegacy, release, releaseLegacy, tryAcquire } from './lock.ts';
import { keychainItemExists, keychainServiceFor } from './keychain.ts';
import { refreshToken, type Http } from './oauth.ts';
import { runScript, succeeded } from './scripts.ts';
import { ensureDir0700, fingerprint, nowIso, parseJsonObject, readFileNoFollow, writeFileAtomic0600 } from './util.ts';

/** Marker for a pending record that exists only in memory. */
const MEMORY = '(memory)';

export type State = 'ok' | 'due' | 'refreshing' | 'retrying' | 'dead' | 'critical' | 'breaker';

export type Emit = (account: string | null, type: string, level: Level, data?: Record<string, unknown>) => void;

export interface AccountStatus {
  id: string;
  provider: string;
  credentialPath: string;
  state: State;
  fingerprint: string | null;
  accessToken: { expiresAt: string | null; leftMin: number | null };
  refreshToken: { expiresAt: string | null; leftDays: number | null };
  nextRefreshAt: string | null;
  lastRefresh: { at: string; result: string; rotatedRt?: boolean } | null;
  consecutiveFailures: number;
}

export class Account {
  state: State = 'ok';
  failures = 0;
  /** A refresh_failed (error-level) was emitted in the current failure episode. */
  failureAlerted = false;
  lastRefresh: AccountStatus['lastRefresh'] = null;
  /** Vault fingerprint the current dead/critical state applies to; a different vault clears it. */
  stuckFingerprint: string | null = null;
  jitterMs: number;
  private refreshing = false;

  cfg: AccountConfig;
  global: Config;
  http: Http;
  readonly emit: Emit;
  readonly now: () => number;

  constructor(cfg: AccountConfig, global: Config, http: Http, emit: Emit, now: () => number = Date.now) {
    this.cfg = cfg;
    this.global = global;
    this.http = http;
    this.emit = emit;
    this.now = now;
    this.jitterMs = Math.floor(Math.random() * 5 * 60_000);
  }

  get p() { return paths(this.global); }
  get busy(): boolean { return this.refreshing; }

  vault(): OauthCred | null {
    const r = parseCred(readFileNoFollow(this.p.vault(this.cfg.id)));
    return r.ok ? r.cred : null;
  }

  private writeVault(text: string): void {
    ensureDir0700(dirname(this.p.vault(this.cfg.id)));
    writeFileAtomic0600(this.p.vault(this.cfg.id), text);
  }

  private publish(text: string): void {
    const path = this.cfg.credentialPath;
    const prev = readFileNoFollow(path);
    if (prev !== null && parseCred(prev).ok) writeFileAtomic0600(`${path}.prev`, prev);
    writeFileAtomic0600(path, text);
  }

  /**
   * Vault vs published file (design §4.3). Returns the authoritative cred, or
   * null when neither side is usable (breaker).
   */
  /** reconcile() under the account lock; 'locked' when another holder is busy. */
  reconcileLocked(): OauthCred | null | 'locked' {
    const lockPath = this.p.lock(this.cfg.id);
    if (!tryAcquire(lockPath)) return 'locked';
    try { return this.reconcile(); } finally { release(lockPath); }
  }

  /** Callers must hold the account lock (see reconcileLocked). */
  reconcile(): OauthCred | null {
    const pubText = readFileNoFollow(this.cfg.credentialPath);
    const pub = parseCred(pubText);
    const vault = this.vault();
    if (!vault) {
      if (pub.ok) {
        this.writeVault(pubText!);
        this.emit(this.cfg.id, 'vault_initialized', 'info', { fingerprint: pub.cred.fingerprint });
        return pub.cred;
      }
      if (this.state !== 'breaker') {
        this.state = 'breaker';
        this.emit(this.cfg.id, 'breaker', 'critical', { published: pub.ok ? 'ok' : pub.reason });
      }
      return null;
    }
    if (this.state === 'breaker') {
      this.state = 'ok';
      this.emit(this.cfg.id, 'recovered', 'info', { from: 'breaker' });
    }
    if ((this.state === 'dead' || this.state === 'critical') && this.stuckFingerprint !== null
        && vault.fingerprint !== this.stuckFingerprint && !this.unsaved) {
      // The vault moved on (another process refreshed, or a login was adopted).
      this.emit(this.cfg.id, 'recovered', 'info', { from: this.state });
      this.state = 'ok';
      this.failures = 0;
      this.stuckFingerprint = null;
    }
    if (pub.ok && pub.cred.fingerprint === vault.fingerprint) return vault;
    // A different, valid file that is at least as fresh wins (a human login or a
    // consumer's own successful refresh). Ties go to the file: a tie with a
    // different token can only come from a fresh login, not from our history.
    if (pub.ok && pub.cred.expiresAt >= vault.expiresAt) {
      // Keep the vault being replaced: if the file came from a different account
      // (someone logged another account into this path), its RT is the only copy.
      this.keepAside('displaced', JSON.stringify(vault.raw));
      this.writeVault(pubText!);
      this.emit(this.cfg.id, 'adopted', 'warn', { from: vault.fingerprint, to: pub.cred.fingerprint });
      if (this.state === 'dead' || this.state === 'critical') {
        this.emit(this.cfg.id, 'recovered', 'info', { from: this.state });
        this.state = 'ok';
        this.failures = 0;
        this.stuckFingerprint = null;
      }
      return pub.cred;
    }
    // absent / unparseable / logged out / older than vault → republish the vault.
    // Keep the bad file for forensics (publish() only keeps valid files as .prev).
    if (pubText !== null && pubText.trim() !== '') this.keepAside('quarantine', pubText);
    this.publish(JSON.stringify(vault.raw));
    this.emit(this.cfg.id, 'republished', 'error', {
      reason: pub.ok ? 'older_than_vault' : pub.reason, fingerprint: vault.fingerprint,
    });
    return vault;
  }

  /**
   * Resolve a persisted-but-unapplied refresh response (crash between the
   * request and the vault write). Never deleted unless provably applied:
   * it may hold the only copy of a rotated RT.
   *  - vault already carries the response's access or refresh token → applied, delete
   *  - response was made from the current vault → apply it now
   *  - otherwise → keep it, go critical, a human decides
   * Returns 'none' | 'applied' | 'unresolved'.
   */
  async recoverPending(holdingLock = false): Promise<'none' | 'applied' | 'unresolved' | 'locked'> {
    if (!holdingLock) {
      // Every consumer of the pending file runs under the account lock, so a
      // manual `pending apply|discard` in another process cannot interleave.
      const lockPath = this.p.lock(this.cfg.id);
      if (!tryAcquire(lockPath)) return 'locked';
      try { return await this.recoverPending(true); } finally { release(lockPath); }
    }
    if (this.unsavedPending) {
      const path = this.persistPending(this.unsavedPending);
      if (path) this.unsavedPending = null;
    }
    // Every record is judged on its own: resolving one never deletes another.
    const records = this.pendingRecords();
    if (records.length === 0) return 'none';
    let applied = false;
    let unresolved = false;
    for (const rec of records) {
      const pending = parseJsonObject(rec.text) as { base?: string; at?: number; raw?: string } | null;
      const body = pending && typeof pending.raw === 'string' ? (parseJsonObject(pending.raw) as TokenResponse | null) : null;
      const vault = this.vault();
      // Applied iff the vault carries this response's RT (when it has one), else its AT.
      const hasRt = !!body && typeof body.refresh_token === 'string' && body.refresh_token.length > 0;
      if (vault && body && (hasRt ? body.refresh_token === vault.refreshToken
          : typeof body.access_token === 'string' && body.access_token === vault.accessToken)) {
        this.removeRecord(rec.where); // provably applied: the vault carries this response's token
        continue;
      }
      const merged = vault && body && pending!.base === vault.fingerprint && typeof pending!.at === 'number'
        ? mergeTokenResponse(vault, body, pending!.at!) : null;
      if (merged) {
        await this.apply(merged.text, merged.rotatedRt, 'recovered_pending', rec.where);
        applied = true;
        continue;
      }
      unresolved = true;
      this.setStuck('critical', vault?.fingerprint ?? null);
      const key = fingerprint(rec.text);
      if (!this.pendingReported.has(key)) { // once per pending content, not once per tick
        this.pendingReported.add(key);
        this.emit(this.cfg.id, 'pending_unresolved', 'critical', {
          pendingPath: rec.where, baseMatches: !!vault && pending?.base === vault.fingerprint, parsed: !!body,
          hint: `inspect and resolve with: cred-keeper pending ${this.cfg.id} apply|discard --confirm ${this.cfg.id}`,
        });
      }
    }
    return unresolved ? 'unresolved' : applied ? 'applied' : 'none';
  }

  /** Human resolution of an unresolved pending response. Returns what happened. */
  /**
   * `replaceFingerprint` must name the current vault fingerprint when the pending
   * response was not made from it: the operator acknowledges exactly which
   * credential is being displaced. The displaced vault is always kept aside.
   */
  async resolvePending(action: 'apply' | 'discard', replaceFingerprint?: string): Promise<string> {
    const lockPath = this.p.lock(this.cfg.id);
    if (!tryAcquire(lockPath)) return 'locked';
    try {
      const rec = this.pendingRecords()[0]; // one record at a time, oldest first
      if (!rec) return 'no_pending';
      const text = rec.text;
      if (action === 'discard') {
        this.removeRecord(rec.where);
        this.emit(this.cfg.id, 'pending_discarded', 'warn', {});
        return 'discarded';
      }
      const pending = parseJsonObject(text) as { at?: number; raw?: string } | null;
      const body = pending && typeof pending.raw === 'string' ? (parseJsonObject(pending.raw) as TokenResponse | null) : null;
      const vault = this.vault() ?? (() => { const r = parseCred(readFileNoFollow(this.cfg.credentialPath)); return r.ok ? r.cred : null; })();
      if (!body || !vault) return 'unparseable';
      const base = (pending as { base?: string }).base;
      if (base !== vault.fingerprint && replaceFingerprint !== vault.fingerprint) {
        this.lastMismatch = { base: base ?? null, vault: vault.fingerprint }; // read under the lock
        return 'base_mismatch';
      }
      // Keep the credential being displaced: it may hold the live RT.
      writeFileAtomic0600(join(dirname(this.p.vault(this.cfg.id)),
        `${this.cfg.id}.displaced-${this.now()}-${randomBytes(4).toString('hex')}.json`), JSON.stringify(vault.raw));
      const merged = mergeTokenResponse(vault, body, typeof pending!.at === 'number' ? pending!.at : this.now());
      if (!merged) return 'unusable';
      this.refreshing = true;
      try { await this.apply(merged.text, merged.rotatedRt, 'recovered_pending', rec.where); } finally { this.refreshing = false; }
      this.stuckFingerprint = null;
      return 'applied';
    } finally {
      release(lockPath);
    }
  }

  /** Save a copy under the vault dir (0600, unique name). Best effort: never blocks the main path. */
  private keepAside(kind: 'displaced' | 'quarantine', text: string): void {
    try {
      writeFileAtomic0600(join(dirname(this.p.vault(this.cfg.id)),
        `${this.cfg.id}.${kind}-${this.now()}-${randomBytes(4).toString('hex')}.json`), text);
    } catch { /* forensics only */ }
  }

  /** Primary pending location, then an emergency one in a different directory. */
  private pendingPaths(): string[] {
    return [this.p.pending(this.cfg.id), join(this.global.dataDir, `pending-emergency-${this.cfg.id}.json`)];
  }

  /** All pending records (each location, plus a memory-only one), oldest response first. */
  private pendingRecords(): { where: string; text: string }[] {
    const out: { where: string; text: string; at: number }[] = [];
    for (const path of this.pendingPaths()) {
      let text: string | null;
      try { text = readFileNoFollow(path); } catch { text = null; } // not a regular file → no pending there
      if (text !== null) out.push({ where: path, text, at: Number((parseJsonObject(text) as { at?: unknown } | null)?.at) || 0 });
    }
    if (this.unsavedPending) {
      out.push({ where: MEMORY, text: this.unsavedPending, at: Number((parseJsonObject(this.unsavedPending) as { at?: unknown } | null)?.at) || 0 });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** A pending record we could not write anywhere yet: retried every tick. Lost only if the process dies too. */
  unsavedPending: string | null = null;

  /** Persist a refresh response; primary location, else emergency location. Returns the path or null. */
  private persistPending(record: string): string | null {
    for (const path of this.pendingPaths()) {
      try {
        ensureDir0700(dirname(path));
        writeFileAtomic0600(path, record);
        return path;
      } catch { /* try the next location */ }
    }
    return null;
  }

  /** Remove one pending record. Best effort: a leftover is provably applied and removed on a later tick. */
  private removeRecord(where: string | null): void {
    if (!where) return;
    if (where === MEMORY) { this.unsavedPending = null; return; }
    try { rmSync(where, { force: true }); } catch { /* resolved on a later tick */ }
  }

  /** Enter dead/critical, remembering which vault fingerprint it applies to. */
  private setStuck(state: 'dead' | 'critical', fp: string | null): void {
    this.state = state;
    this.stuckFingerprint = fp;
  }

  private pendingReported = new Set<string>();
  /** Set by the service after its startup probe; only 'active' makes the split check meaningful. */
  keychainGate: import('./keychain.ts').GateState = 'unavailable';
  /** Injectable for tests; production uses the real `security` lookup. */
  keychainProbe: (service: string) => boolean | null = keychainItemExists;
  /** Outcome of the previous refresh request (to annotate an invalid_grant that follows a network failure). */
  private lastOutcome: string | null = null;
  /** base/vault pair observed under the lock by the last `base_mismatch`. */
  lastMismatch: { base: string | null; vault: string } | null = null;

  /** A merged credential we could not persist yet (disk error): retried every tick. */
  unsaved: string | null = null;
  /** The pending record `unsaved` came from. */
  private unsavedRecord: string | null = null;

  /** True while this object holds state that exists nowhere on disk. */
  get hasMemoryOnlyState(): boolean { return this.unsaved !== null || this.unsavedPending !== null; }

  /** Retry persisting an in-memory credential; true when nothing is left unsaved. Runs under the account lock. */
  flushUnsaved(holdingLock = false): boolean {
    if (!this.unsaved) return true;
    if (!holdingLock) {
      const lockPath = this.p.lock(this.cfg.id);
      if (!tryAcquire(lockPath)) return false;
      try { return this.flushUnsaved(true); } finally { release(lockPath); }
    }
    try {
      this.writeVault(this.unsaved);
      this.publish(this.unsaved);
      this.removeRecord(this.unsavedRecord);
      this.unsaved = null;
      this.unsavedRecord = null;
      this.state = 'ok';
      this.emit(this.cfg.id, 'recovered', 'info', { from: 'persist_failed' });
      return true;
    } catch (e) {
      return false;
    }
  }

  private async apply(text: string, rotatedRt: boolean, how: 'refreshed' | 'recovered_pending', record: string | null): Promise<void> {
    this.writeVault(text);
    this.publish(text);
    this.removeRecord(record);
    const cred = parseCred(text);
    const fp = cred.ok ? cred.cred.fingerprint : null;
    this.state = 'ok';
    const hadFailures = this.failureAlerted;
    this.failures = 0;
    this.failureAlerted = false;
    this.lastRefresh = { at: nowIso(this.now()), result: 'ok', rotatedRt };
    this.emit(this.cfg.id, how, how === 'refreshed' ? 'info' : 'warn', { fingerprint: fp, rotatedRt });
    if (hadFailures) this.emit(this.cfg.id, 'recovered', 'info', { from: 'refresh_failed' });
    await this.runHook(cred.ok ? cred.cred : null);
  }

  private async runHook(cred: OauthCred | null): Promise<void> {
    if (!this.cfg.onRefreshed) return;
    const env: Record<string, string> = {
      CK_ACCOUNT: this.cfg.id,
      CK_EVENT: 'refreshed',
      CK_CREDENTIAL_PATH: this.cfg.credentialPath,
      CK_FINGERPRINT: cred?.fingerprint ?? '',
      CK_AT_EXPIRES_AT: cred ? nowIso(cred.expiresAt) : '',
      CK_RT_EXPIRES_AT: cred?.refreshTokenExpiresAt ? nowIso(cred.refreshTokenExpiresAt) : '',
    };
    const deadline = this.now() + this.cfg.hookTimeoutSec * 1000;
    const known = cred ? [cred.accessToken, cred.refreshToken] : [];
    let r = await runScript({ script: this.cfg.onRefreshed, env, timeoutMs: this.cfg.hookTimeoutSec * 1000,
      logDir: this.p.logDir, label: `onRefreshed:${this.cfg.id}`, redactKnown: known });
    let attempts = 1;
    const remaining = deadline - this.now();
    if (!succeeded(r) && !r.timedOut && remaining > 1000) {
      attempts = 2;
      r = await runScript({ script: this.cfg.onRefreshed, env, timeoutMs: remaining,
        logDir: this.p.logDir, label: `onRefreshed:${this.cfg.id}#2`, redactKnown: known });
    }
    const data = { code: r.code, signal: r.signal, timedOut: r.timedOut, ms: r.ms, attempts, error: r.error };
    if (succeeded(r)) this.emit(this.cfg.id, 'hook_ok', 'info', data);
    else this.emit(this.cfg.id, 'hook_failed', 'critical', data);
  }

  /** Minutes of AT left per the vault; null if unknown. */
  leftMin(cred: OauthCred | null): number | null {
    return cred ? Math.round((cred.expiresAt - this.now()) / 60_000) : null;
  }

  isDue(cred: OauthCred): boolean {
    const left = cred.expiresAt - this.now();
    return left <= this.cfg.marginMin * 60_000 - this.jitterMs;
  }

  /** One refresh attempt. `force` skips the due check (manual CLI). */
  async refresh(force = false): Promise<string> {
    if (this.refreshing) return 'busy';
    const lockPath = this.p.lock(this.cfg.id);
    if (!tryAcquire(lockPath)) return 'locked';
    const legacy = this.cfg.legacyLockDir;
    if (legacy && !acquireLegacy(legacy)) { release(lockPath); return 'locked'; }
    this.refreshing = true;
    try {
      if (!this.flushUnsaved(true)) return 'persist_failed';
      // Never send a new refresh while a persisted response is unresolved:
      // it may hold the only live RT.
      if ((await this.recoverPending(true)) === 'unresolved') return 'pending_unresolved';
      const cur = this.reconcile();
      if (!cur) return 'breaker';
      if ((this.state === 'dead' || this.state === 'critical') && this.stuckFingerprint === cur.fingerprint && !force) return this.state;
      if (!force && !this.isDue(cur)) return 'not_due';
      // Keychain split: claude would read the keychain item, not the file we refresh.
      // Refreshing would rotate the RT under claude's feet (the keychain copy dies).
      const svc = keychainServiceFor(this.cfg.credentialPath);
      if (this.keychainGate === 'active') {
        const has = this.keychainProbe(svc);
        if (has === true) {
          this.emit(this.cfg.id, 'keychain_split', 'error', { service: svc, hint: `remove it: security delete-generic-password -s "${svc}"` });
          return 'keychain_split';
        }
        if (has === null) { // an active gate that cannot answer must not wave the refresh through
          this.emit(this.cfg.id, 'keychain_check_failed', 'error', { service: svc });
          return 'keychain_check_failed';
        }
      }
      const left = this.leftMin(cur) ?? 0;
      this.state = 'refreshing';
      const at = this.now();
      const out = await refreshToken(this.http, this.global.endpoints.token, this.global.clientId, cur.refreshToken);
      const prevOutcome = this.lastOutcome;
      this.lastOutcome = out.kind;
      if (out.kind === 'ok' || out.kind === 'unparseable_200') {
        // The RT is rotated server-side from here on. Persist the raw response
        // first; if that fails, keep going in memory and retry every tick.
        const record = JSON.stringify({ base: cur.fingerprint, at, raw: out.bodyText });
        const savedAt = this.persistPending(record);
        const pendingSaved = savedAt !== null;
        if (!pendingSaved) {
          this.unsavedPending = record; // retried every tick until it lands on disk
          this.emit(this.cfg.id, 'persist_failed', 'critical', { stage: 'pending' });
        }
        const merged = out.kind === 'ok' ? mergeTokenResponse(cur, out.body, at) : null;
        if (!merged) {
          this.setStuck('critical', cur.fingerprint);
          this.failures++;
          this.emit(this.cfg.id, 'critical_unknown_response', 'critical', {
            keys: out.kind === 'ok' ? Object.keys(out.body ?? {}).sort() : [], pendingPath: savedAt,
          });
          return 'critical';
        }
        try {
          await this.apply(merged.text, merged.rotatedRt, 'refreshed', savedAt ?? MEMORY);
        } catch (e) {
          this.unsaved = merged.text;
          this.unsavedRecord = savedAt ?? MEMORY;
          this.setStuck('critical', cur.fingerprint);
          this.emit(this.cfg.id, 'persist_failed', 'critical', { stage: 'vault', error: (e as Error).message, pendingSaved });
          return 'persist_failed';
        }
        return 'refreshed';
      }
      switch (out.kind) {
        case 'network': {
          this.state = 'retrying';
          this.failures++;
          const level: Level = this.failures >= 2 || left < this.cfg.redMin ? 'error' : 'warn';
          if (level === 'error') this.failureAlerted = true;
          this.emit(this.cfg.id, level === 'error' ? 'refresh_failed' : 'refresh_retry', level,
            { reason: 'network', error: out.error, failures: this.failures, leftMin: left });
          return 'network';
        }
        case 'invalid_grant': {
          const afterNetwork = prevOutcome === 'network';
          this.setStuck('dead', cur.fingerprint);
          this.failures++;
          this.emit(this.cfg.id, 'rt_dead', 'critical', {
            status: out.status, leftMin: left,
            ...(afterNetwork ? { likelyCause: 'the previous attempt failed at the network layer after the server may already have rotated the RT: the new RT was probably lost in transit' } : {}),
          });
          return 'dead';
        }
        case 'rejected':
          this.state = 'retrying';
          this.failures++;
          this.failureAlerted = true;
          this.emit(this.cfg.id, 'refresh_failed', 'error', { reason: 'rejected', status: out.status, errorKind: out.errorKind, leftMin: left });
          return 'rejected';
      }
      return 'unknown';
    } finally {
      this.refreshing = false;
      if (legacy) releaseLegacy(legacy);
      release(lockPath);
    }
  }

  status(): AccountStatus {
    const v = this.vault() ?? (() => { const r = parseCred(readFileNoFollow(this.cfg.credentialPath)); return r.ok ? r.cred : null; })();
    const now = this.now();
    let next: string | null = null;
    if (v) next = nowIso(Math.max(now, v.expiresAt - this.cfg.marginMin * 60_000 + this.jitterMs));
    return {
      id: this.cfg.id,
      provider: this.cfg.provider,
      credentialPath: this.cfg.credentialPath,
      state: this.state,
      fingerprint: v?.fingerprint ?? null,
      accessToken: { expiresAt: v ? nowIso(v.expiresAt) : null, leftMin: this.leftMin(v) },
      refreshToken: {
        expiresAt: v?.refreshTokenExpiresAt ? nowIso(v.refreshTokenExpiresAt) : null,
        leftDays: v?.refreshTokenExpiresAt ? Math.floor((v.refreshTokenExpiresAt - now) / 86_400_000) : null,
      },
      nextRefreshAt: next,
      lastRefresh: this.lastRefresh,
      consecutiveFailures: this.failures,
    };
  }
}
