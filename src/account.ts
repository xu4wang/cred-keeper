/**
 * One managed account: authoritative vault copy, publication to
 * credentialPath, refresh with pending-response recovery, onRefreshed hook.
 */
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import type { AccountConfig, Config, Level } from './config.ts';
import { paths } from './config.ts';
import { mergeTokenResponse, parseCred, type OauthCred, type TokenResponse } from './cred.ts';
import { release, tryAcquire } from './lock.ts';
import { refreshToken, type Http } from './oauth.ts';
import { runScript, succeeded } from './scripts.ts';
import { ensureDir0700, nowIso, parseJsonObject, readFileNoFollow, writeFileAtomic0600 } from './util.ts';

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
  /** Fingerprint of the vault copy we last saw dead (invalid_grant); cleared when it changes. */
  deadFingerprint: string | null = null;
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
    if (pub.ok && pub.cred.fingerprint === vault.fingerprint) return vault;
    if (pub.ok && pub.cred.expiresAt > vault.expiresAt) {
      this.writeVault(pubText!);
      this.emit(this.cfg.id, 'adopted', 'warn', { from: vault.fingerprint, to: pub.cred.fingerprint });
      if (this.state === 'dead' || this.state === 'critical') {
        this.emit(this.cfg.id, 'recovered', 'info', { from: this.state });
        this.state = 'ok';
        this.failures = 0;
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

  /** Complete a refresh whose response was persisted but not applied (crash between request and rename). */
  async recoverPending(): Promise<boolean> {
    const pendingPath = this.p.pending(this.cfg.id);
    const text = readFileNoFollow(pendingPath);
    if (text === null) return false;
    const pending = parseJsonObject(text) as { base?: string; body?: TokenResponse; at?: number } | null;
    const vault = this.vault();
    const baseOk = pending && vault && pending.base === vault.fingerprint && pending.body && typeof pending.at === 'number';
    const merged = baseOk ? mergeTokenResponse(vault!, pending!.body!, pending!.at!) : null;
    if (!merged) {
      // Not applicable to the current vault (already applied, or garbage). Keep it only if it could matter.
      if (pending && vault && pending.base !== vault.fingerprint) {
        rmSync(pendingPath, { force: true }); // vault moved on: it was applied or superseded
        return false;
      }
      this.state = 'critical';
      this.emit(this.cfg.id, 'critical_unknown_response', 'critical', { stage: 'recovery', pendingPath });
      return false;
    }
    await this.apply(merged.text, merged.rotatedRt, 'recovered_pending');
    return true;
  }

  private async apply(text: string, rotatedRt: boolean, how: 'refreshed' | 'recovered_pending'): Promise<void> {
    this.writeVault(text);
    this.publish(text);
    rmSync(this.p.pending(this.cfg.id), { force: true });
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
    let r = await runScript({ script: this.cfg.onRefreshed, env, timeoutMs: this.cfg.hookTimeoutSec * 1000,
      logDir: this.p.logDir, label: `onRefreshed:${this.cfg.id}` });
    let attempts = 1;
    const remaining = deadline - this.now();
    if (!succeeded(r) && !r.timedOut && remaining > 1000) {
      attempts = 2;
      r = await runScript({ script: this.cfg.onRefreshed, env, timeoutMs: remaining,
        logDir: this.p.logDir, label: `onRefreshed:${this.cfg.id}#2` });
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
      const cur = this.reconcile();
      if (!cur) return 'breaker';
      if (this.state === 'dead' && this.deadFingerprint === cur.fingerprint && !force) return 'dead';
      if (!force && !this.isDue(cur)) return 'not_due';
      const left = this.leftMin(cur) ?? 0;
      this.state = 'refreshing';
      const pendingPath = this.p.pending(this.cfg.id);
      ensureDir0700(dirname(pendingPath));
      const at = this.now();
      const out = await refreshToken(this.http, this.global.endpoints.token, this.global.clientId, cur.refreshToken,
        (text) => {
          const body = parseJsonObject(text);
          writeFileAtomic0600(pendingPath, JSON.stringify({ base: cur.fingerprint, at, body }));
        });
      switch (out.kind) {
        case 'ok': {
          const merged = mergeTokenResponse(cur, out.body, at);
          if (!merged) {
            this.state = 'critical';
            this.failures++;
            this.emit(this.cfg.id, 'critical_unknown_response', 'critical', {
              keys: Object.keys(out.body ?? {}).sort(), pendingPath,
            });
            return 'critical';
          }
          await this.apply(merged.text, merged.rotatedRt, 'refreshed');
          return 'refreshed';
        }
        case 'unparseable_200':
          this.state = 'critical';
          this.failures++;
          this.emit(this.cfg.id, 'critical_unknown_response', 'critical', { pendingPath });
          return 'critical';
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
          this.state = 'dead';
          this.deadFingerprint = cur.fingerprint;
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
