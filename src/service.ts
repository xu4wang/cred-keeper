import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Account, type Emit } from './account.ts';
import { Alerter } from './alert.ts';
import { auditBinary } from './audit.ts';
import { loadConfig, paths, type Config, type Level } from './config.ts';
import { legacyLockLive } from './lock.ts';
import { fetchUsage, Http, project, type UsageSnapshot } from './oauth.ts';
import { Store } from './store.ts';
import { ensureDir0700, nowIso } from './util.ts';

const FIVE_H = 5 * 3600_000;
const SEVEN_D = 7 * 86_400_000;

export interface UsageView {
  fiveHour: UsageSnapshot['fiveHour'] & { projected: number | null };
  sevenDay: UsageSnapshot['sevenDay'] & { projected: number | null };
  limits: UsageSnapshot['limits'];
  polledAt: string;
}

/** Human-readable one-liners for alert titles. Never contains secrets. */
function title(type: string, account: string | null, data: Record<string, unknown>): string {
  const a = account ? `[${account}] ` : '';
  switch (type) {
    case 'rt_dead': return `${a}refresh token 已失效（invalid_grant），需要人工重新登录`;
    case 'breaker': return `${a}权威副本和凭证文件都不可用，已熔断`;
    case 'critical_unknown_response': return `${a}刷新响应无法识别，RT 可能已在服务端轮换，需要人工处理`;
    case 'refresh_failed': return `${a}刷新失败（${String(data.reason)}），剩 ${String(data.leftMin)} 分钟`;
    case 'republished': return `${a}凭证文件异常（${String(data.reason)}），已从权威副本重新发布`;
    case 'hook_failed': return `${a}onRefreshed 脚本失败，消费者可能仍持有已吊销的 AT`;
    case 'contract_drift': return `claude 二进制契约漂移：缺少 ${(data.missing as string[] | undefined)?.join(', ')}`;
    case 'rt_expiring': return `${a}refresh token 还剩 ${String(data.leftDays)} 天到期，请安排人工重新登录`;
    case 'usage_high': return `${a}用量偏高：${String(data.window)} ${String(data.value)}%`;
    case 'usage_locked': return `${a}已被限流锁定：${String(data.window)} ${String(data.reason)}`;
    case 'recovered': return `${a}已恢复（${String(data.from)}）`;
    case 'heartbeat': return '凭证心跳';
    default: return `${a}${type}`;
  }
}

export class Service {
  cfg: Config;
  store: Store;
  alerter: Alerter;
  http: Http;
  accounts = new Map<string, Account>();
  usage = new Map<string, UsageView>();
  private timer?: NodeJS.Timeout;
  private cfgMtime = 0;
  private reloadPending = false;
  private lastUsagePoll = new Map<string, number>();

  readonly configPath: string;
  readonly now: () => number;
  private readonly alertSleep?: (ms: number) => Promise<unknown>;

  constructor(configPath: string, opts: { now?: () => number; alertSleep?: (ms: number) => Promise<unknown> } = {}) {
    this.configPath = configPath;
    this.now = opts.now ?? Date.now;
    this.alertSleep = opts.alertSleep;
    this.cfg = loadConfig(configPath);
    ensureDir0700(this.cfg.dataDir);
    ensureDir0700(paths(this.cfg).logDir);
    this.store = new Store(paths(this.cfg).db);
    this.alerter = new Alerter(this.cfg, this.store, this.alertSleep);
    this.http = new Http(this.cfg.proxy);
    this.cfgMtime = statSync(configPath).mtimeMs;
    this.buildAccounts();
  }

  emit: Emit = (account, type, level, data = {}) => {
    const id = this.store.addEvent(account, type, level, data);
    if (type === 'recovered') {
      const from = String(data.from ?? '');
      for (const t of from === 'breaker' ? ['breaker'] : from === 'refresh_failed' ? ['refresh_failed'] : ['rt_dead', 'critical_unknown_response']) {
        this.alerter.reset(account, t);
      }
    }
    const dedupKey = type === 'rt_expiring' ? `${nowIso(this.now()).slice(0, 10)}|${String(data.rtExpiresAt)}`
      : type === 'usage_high' || type === 'usage_locked' ? `${String(data.window)}|${String(data.resetsAt)}`
      : type === 'heartbeat' ? nowIso(this.now()).slice(0, 10)
      : type === 'republished' ? nowIso(this.now()).slice(0, 13) // at most one alert per hour
      : type === 'recovered' || type === 'hook_failed' ? String(id)
      : 'episode';
    this.alerter.offer({ eventId: id, type, level, account, title: title(type, account, data), message: JSON.stringify(data), dedupKey, data });
  };

  private buildAccounts(): void {
    const next = new Map<string, Account>();
    for (const a of this.cfg.accounts) {
      const existing = this.accounts.get(a.id);
      if (existing && existing.cfg.credentialPath === a.credentialPath) {
        existing.cfg = a;
        next.set(a.id, existing);
      } else {
        next.set(a.id, new Account(a, this.cfg, this.http, this.emit, this.now));
      }
    }
    this.accounts = next;
  }

  /** Hot reload; deferred while any account is mid-refresh. */
  reload(): void {
    if ([...this.accounts.values()].some((a) => a.busy)) { this.reloadPending = true; return; }
    this.reloadPending = false;
    const cfg = loadConfig(this.configPath);
    this.cfg = cfg;
    this.alerter = new Alerter(cfg, this.store, this.alertSleep);
    this.http = new Http(cfg.proxy);
    for (const a of this.accounts.values()) {
      a.global = cfg;
      a.http = this.http;
    }
    this.buildAccounts();
    this.store.addEvent(null, 'config_reloaded', 'info', { accounts: cfg.accounts.map((a) => a.id) });
  }

  async start(): Promise<void> {
    if (!this.cfg.alert) this.store.addEvent(null, 'alerts_disabled', 'info', { reason: 'alert.script not configured' });
    const legacy = this.cfg.legacyLockDir;
    while (legacy && legacyLockLive(legacy)) await new Promise((r) => setTimeout(r, 5000));
    for (const a of this.accounts.values()) {
      try { await a.recoverPending(); a.reconcile(); } catch (e) {
        this.emit(a.cfg.id, 'internal_error', 'error', { stage: 'startup', error: (e as Error).message });
      }
    }
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  private ticking = false;

  async tick(): Promise<void> {
    if (this.ticking) return; // previous tick still running (slow refresh / hook / usage call)
    this.ticking = true;
    try {
      await this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner(): Promise<void> {
    try {
      const m = statSync(this.configPath).mtimeMs;
      if (m !== this.cfgMtime || this.reloadPending) { this.cfgMtime = m; this.reload(); }
    } catch (e) {
      this.store.addEvent(null, 'config_error', 'error', { error: (e as Error).message });
    }
    await Promise.all([...this.accounts.values()].map((a) => this.tickAccount(a)));
    this.heartbeatIfDue();
    this.auditIfDue();
  }

  private async tickAccount(a: Account): Promise<void> {
    if (a.busy) return; // a refresh from an earlier tick is still running
    try {
      if (!a.flushUnsaved()) return;
      if ((await a.recoverPending()) === 'unresolved') return;
      const cur = a.reconcile();
      if (!cur) return;
      this.rtWarn(a, cur.refreshTokenExpiresAt);
      if (a.state !== 'critical' && a.isDue(cur)) { await a.refresh(); return; }
      await this.pollUsage(a, cur.accessToken);
    } catch (e) {
      this.emit(a.cfg.id, 'internal_error', 'error', { error: (e as Error).message });
    }
  }

  private rtWarn(a: Account, rtExp?: number): void {
    if (!rtExp) return;
    const days = Math.floor((rtExp - this.now()) / 86_400_000);
    if (days > a.cfg.rtWarnDays) return;
    const k = `rtwarn:${a.cfg.id}:${nowIso(this.now()).slice(0, 10)}|${rtExp}`;
    if (this.store.get(k)) return; // once per day per RT deadline
    this.store.set(k, '1');
    this.emit(a.cfg.id, 'rt_expiring', 'error', { leftDays: days, rtExpiresAt: nowIso(rtExp) });
  }

  async pollUsage(a: Account, accessToken: string, force = false): Promise<void> {
    const last = this.lastUsagePoll.get(a.cfg.id) ?? 0;
    if (!force && this.now() - last < a.cfg.usagePollMin * 60_000) return;
    if (a.busy || a.state === 'refreshing') return;
    this.lastUsagePoll.set(a.cfg.id, this.now());
    let snap: UsageSnapshot;
    try {
      snap = await fetchUsage(this.http, this.cfg.endpoints.usage, accessToken);
    } catch (e) {
      this.store.addEvent(a.cfg.id, 'usage_poll_failed', 'info', { error: (e as Error).message });
      return;
    }
    const now = this.now();
    const view: UsageView = {
      fiveHour: { ...snap.fiveHour, projected: project(snap.fiveHour, FIVE_H, now) },
      sevenDay: { ...snap.sevenDay, projected: project(snap.sevenDay, SEVEN_D, now) },
      limits: snap.limits,
      polledAt: nowIso(now),
    };
    this.usage.set(a.cfg.id, view);
    this.store.addUsage(a.cfg.id, view as unknown as Record<string, unknown>);
    const t = this.cfg.usageThresholds;
    const once = (type: string, window: string, resetsAt: string | null): boolean => {
      const k = `usage:${a.cfg.id}:${type}:${window}|${resetsAt}`;
      if (this.store.get(k)) return false; // once per window instance
      this.store.set(k, '1');
      return true;
    };
    for (const [window, w] of [['five_hour', view.fiveHour], ['seven_day', view.sevenDay]] as const) {
      if (w.locked) {
        if (once('usage_locked', window, w.resetsAt)) this.emit(a.cfg.id, 'usage_locked', 'error', { window, reason: w.locked, resetsAt: w.resetsAt });
      } else if (window === 'five_hour' && ((w.utilization ?? 0) >= t.fiveHourPct || (w.projected ?? 0) >= t.projectedPct)) {
        if (once('usage_high', window, w.resetsAt)) {
          this.emit(a.cfg.id, 'usage_high', 'warn', { window, value: w.utilization, projected: w.projected, resetsAt: w.resetsAt });
        }
      }
    }
  }

  private heartbeatIfDue(): void {
    const hb = this.cfg.alert?.heartbeat;
    if (!hb) return;
    const d = new Date(this.now());
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (hhmm < hb) return;
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local day, same clock as hhmm
    if (this.store.get('heartbeat:last') === day) return;
    this.store.set('heartbeat:last', day);
    this.emit(null, 'heartbeat', 'info', {
      accounts: [...this.accounts.values()].map((a) => {
        const s = a.status();
        const u = this.usage.get(a.cfg.id);
        return { id: s.id, state: s.state, atLeftMin: s.accessToken.leftMin, rtLeftDays: s.refreshToken.leftDays,
          fiveHour: u?.fiveHour.utilization ?? null, sevenDay: u?.sevenDay.utilization ?? null };
      }),
    });
  }

  private auditIfDue(): void {
    const bin = this.cfg.claudeBinary;
    if (!bin) return;
    const last = Number(this.store.get('audit:at') ?? 0);
    if (this.now() - last < 3600_000) return;
    this.store.set('audit:at', String(this.now()));
    try {
      const r = auditBinary(bin, this.cfg.clientId, this.store.get('audit:sig'));
      if (!r.changed) return;
      this.store.set('audit:sig', r.signature);
      if (r.missing.length) this.emit(null, 'contract_drift', 'error', { binary: bin, missing: r.missing });
      else this.store.addEvent(null, 'contract_ok', 'info', { binary: bin, signature: r.signature });
    } catch (e) {
      this.emit(null, 'contract_drift', 'error', { binary: bin, error: (e as Error).message });
    }
  }

  dataDirOf(): string { return dirname(paths(this.cfg).db); }
}

export type { Level };
