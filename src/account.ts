/**
 * One managed account: authoritative vault copy, publication to
 * credentialPath, refresh with pending-response recovery, onRefreshed hook.
 */
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import type { AccountConfig, Config, Level } from './config.ts';
import { paths } from './config.ts';
import { mergeTokenResponse, parseCred, type OauthCred, type TokenResponse } from './cred.ts';
import { release, tryAcquire } from './lock.ts';
import { refreshToken, type Http } from './oauth.ts';
import { runScript, succeeded } from './scripts.ts';
import { ensureDir0700, fingerprint, nowIso, parseJsonObject, readFileNoFollow, writeFileAtomic0600 } from './util.ts';

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
    // absent / unparseable / logged out / older than vault → republish the vault
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
    const pendingPath = this.p.pending(this.cfg.id);
    const text = readFileNoFollow(pendingPath);
    if (text === null) return 'none';
    const pending = parseJsonObject(text) as { base?: string; at?: number; raw?: string } | null;
    const body = pending && typeof pending.raw === 'string' ? (parseJsonObject(pending.raw) as TokenResponse | null) : null;
    const vault = this.vault();
    if (vault && body && ((typeof body.access_token === 'string' && body.access_token === vault.accessToken)
        || (typeof body.refresh_token === 'string' && body.refresh_token === vault.refreshToken))) {
      rmSync(pendingPath, { force: true }); // provably applied: the vault carries this response's token
      return 'none';
    }
    const merged = vault && body && pending!.base === vault.fingerprint && typeof pending!.at === 'number'
      ? mergeTokenResponse(vault, body, pending!.at!) : null;
    if (!merged) {
      this.setStuck('critical', vault?.fingerprint ?? null);
      const key = fingerprint(text);
      if (this.pendingReported !== key) { // once per pending content, not once per tick
        this.pendingReported = key;
        this.emit(this.cfg.id, 'pending_unresolved', 'critical', {
          pendingPath, baseMatches: !!vault && pending?.base === vault.fingerprint, parsed: !!body,
          hint: `inspect and resolve with: cred-keeper pending ${this.cfg.id} apply|discard --confirm ${this.cfg.id}`,
        });
      }
      return 'unresolved';
    }
    await this.apply(merged.text, merged.rotatedRt, 'recovered_pending');
    return 'applied';
  }

  /** Human resolution of an unresolved pending response. Returns what happened. */
  /** Current vault fingerprint and the pending response's base, for the operator to compare. */
  pendingInfo(): { vault: string | null; base: string | null; hasPending: boolean } {
    const text = readFileNoFollow(this.p.pending(this.cfg.id));
    const pending = text ? (parseJsonObject(text) as { base?: string } | null) : null;
    return { vault: this.vault()?.fingerprint ?? null, base: pending?.base ?? null, hasPending: text !== null };
  }

  /**
   * `replaceFingerprint` must name the current vault fingerprint when the pending
   * response was not made from it: the operator acknowledges exactly which
   * credential is being displaced. The displaced vault is always kept aside.
   */
  async resolvePending(action: 'apply' | 'discard', replaceFingerprint?: string): Promise<string> {
    const lockPath = this.p.lock(this.cfg.id);
    if (!tryAcquire(lockPath)) return 'locked';
    try {
      const text = readFileNoFollow(this.p.pending(this.cfg.id));
      if (text === null) return 'no_pending';
      if (action === 'discard') {
        rmSync(this.p.pending(this.cfg.id), { force: true });
        this.emit(this.cfg.id, 'pending_discarded', 'warn', {});
        return 'discarded';
      }
      const pending = parseJsonObject(text) as { at?: number; raw?: string } | null;
      const body = pending && typeof pending.raw === 'string' ? (parseJsonObject(pending.raw) as TokenResponse | null) : null;
      const vault = this.vault() ?? (() => { const r = parseCred(readFileNoFollow(this.cfg.credentialPath)); return r.ok ? r.cred : null; })();
      if (!body || !vault) return 'unparseable';
      const base = (pending as { base?: string }).base;
      if (base !== vault.fingerprint && replaceFingerprint !== vault.fingerprint) return 'base_mismatch';
      // Keep the credential being displaced: it may hold the live RT.
      writeFileAtomic0600(join(dirname(this.p.vault(this.cfg.id)), `${this.cfg.id}.displaced-${this.now()}.json`), JSON.stringify(vault.raw));
      const merged = mergeTokenResponse(vault, body, typeof pending!.at === 'number' ? pending!.at : this.now());
      if (!merged) return 'unusable';
      this.refreshing = true;
      try { await this.apply(merged.text, merged.rotatedRt, 'recovered_pending'); } finally { this.refreshing = false; }
      this.stuckFingerprint = null;
      return 'applied';
    } finally {
      release(lockPath);
    }
  }

  /** Best effort: a leftover pending file is resolved later by recoverPending (it is provably applied). */
  private removePending(): void {
    try { rmSync(this.p.pending(this.cfg.id), { force: true }); } catch { /* resolved on a later tick */ }
  }

  /** Enter dead/critical, remembering which vault fingerprint it applies to. */
  private setStuck(state: 'dead' | 'critical', fp: string | null): void {
    this.state = state;
    this.stuckFingerprint = fp;
  }

  private pendingReported: string | null = null;

  /** A merged credential we could not persist yet (disk error): retried every tick. */
  unsaved: string | null = null;

  /** Retry persisting an in-memory credential; true when nothing is left unsaved. */
  flushUnsaved(): boolean {
    if (!this.unsaved) return true;
    try {
      this.writeVault(this.unsaved);
      this.publish(this.unsaved);
      this.removePending();
      this.unsaved = null;
      this.state = 'ok';
      this.emit(this.cfg.id, 'recovered', 'info', { from: 'persist_failed' });
      return true;
    } catch (e) {
      return false;
    }
  }

  private async apply(text: string, rotatedRt: boolean, how: 'refreshed' | 'recovered_pending'): Promise<void> {
    this.writeVault(text);
    this.publish(text);
    this.removePending();
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
    this.refreshing = true;
    try {
      if (!this.flushUnsaved()) return 'persist_failed';
      // Never send a new refresh while a persisted response is unresolved:
      // it may hold the only live RT.
      if ((await this.recoverPending(true)) === 'unresolved') return 'pending_unresolved';
      const cur = this.reconcile();
      if (!cur) return 'breaker';
      if ((this.state === 'dead' || this.state === 'critical') && this.stuckFingerprint === cur.fingerprint && !force) return this.state;
      if (!force && !this.isDue(cur)) return 'not_due';
      const left = this.leftMin(cur) ?? 0;
      this.state = 'refreshing';
      const pendingPath = this.p.pending(this.cfg.id);
      const at = this.now();
      const out = await refreshToken(this.http, this.global.endpoints.token, this.global.clientId, cur.refreshToken);
      if (out.kind === 'ok' || out.kind === 'unparseable_200') {
        // The RT is rotated server-side from here on. Persist the raw response
        // first; if that fails, keep going in memory and retry every tick.
        let pendingSaved = true;
        try {
          ensureDir0700(dirname(pendingPath));
          writeFileAtomic0600(pendingPath, JSON.stringify({ base: cur.fingerprint, at, raw: out.bodyText }));
        } catch (e) {
          pendingSaved = false;
          this.emit(this.cfg.id, 'persist_failed', 'critical', { stage: 'pending', error: (e as Error).message });
        }
        const merged = out.kind === 'ok' ? mergeTokenResponse(cur, out.body, at) : null;
        if (!merged) {
          this.setStuck('critical', cur.fingerprint);
          this.failures++;
          this.emit(this.cfg.id, 'critical_unknown_response', 'critical', {
            keys: out.kind === 'ok' ? Object.keys(out.body ?? {}).sort() : [], pendingPath: pendingSaved ? pendingPath : null,
          });
          return 'critical';
        }
        try {
          await this.apply(merged.text, merged.rotatedRt, 'refreshed');
        } catch (e) {
          this.unsaved = merged.text;
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
        case 'invalid_grant':
          this.setStuck('dead', cur.fingerprint);
          this.failures++;
          this.emit(this.cfg.id, 'rt_dead', 'critical', { status: out.status, leftMin: left });
          return 'dead';
        case 'rejected':
          this.state = 'retrying';
          this.failures++;
          this.failureAlerted = true;
          this.emit(this.cfg.id, 'refresh_failed', 'error', { reason: 'rejected', status: out.status, errorKind: out.errorKind, leftMin: left });
          return 'rejected';
      }
    } finally {
      this.refreshing = false;
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
