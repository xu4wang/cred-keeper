import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { absPath } from './util.ts';

export type Level = 'info' | 'warn' | 'error' | 'critical';
export const LEVELS: Level[] = ['info', 'warn', 'error', 'critical'];

export interface AccountConfig {
  id: string;
  /** Display name override; default is the logged-in e-mail's local part (see label.ts). */
  label?: string;
  provider: 'claude-oauth';
  credentialPath: string;
  onRefreshed?: string;
  hookTimeoutSec: number;
  /**
   * Optional gate run before a due refresh. Exit 75 (EX_TEMPFAIL) = consumers are
   * busy, defer; anything else = go. A refresh revokes the old access token at once,
   * so a turn in flight at that moment fails: the gate lets the refresh wait for idle.
   */
  preRefresh?: string;
  preRefreshTimeoutSec: number;
  /** Longest a refresh may be deferred by preRefresh, counted from the first deferral. */
  preRefreshMaxDeferMin: number;
  marginMin: number;
  redMin: number;
  rtWarnDays: number;
  usagePollMin: number;
  /**
   * The legacy cron script's mkdir+pid lock for this credential (default account
   * migration). When set, every refresh also holds it, so the service and a
   * still-scheduled cron can never refresh the same RT concurrently.
   */
  legacyLockDir?: string;
}

export interface Config {
  path: string;
  listen: { host: string; port: number };
  dataDir: string;
  proxy?: string;
  claudeBinary?: string;
  /** Endpoint overrides exist for tests only. */
  endpoints: { token: string; usage: string };
  clientId: string;
  accounts: AccountConfig[];
  alert?: { script: string; timeoutSec: number; minLevel: Level; heartbeat?: string };
  usageThresholds: { fiveHourPct: number; projectedPct: number };
  /** Optional: share credentials across machines through a central Redis. Absent = single-machine mode. */
  fleet?: FleetConfig;
  /** Optional: a script that lists who uses which credential file (shown in the API). */
  consumers?: { script: string; refreshMin: number; timeoutSec: number };
}

export interface MirrorConfig {
  /** Fleet-wide account name, as some other machine publishes it. */
  name: string;
  /** Where the copy is written (botmux bots point `credentialsSourceDir` at its grandparent dir). */
  credentialPath: string;
  /** Run after the copy changed (e.g. suspend the bots using it). Same env as onRefreshed. */
  onUpdated?: string;
  /** Exit 75 = a bot using this copy is mid-turn; reported to the fleet so the owner defers its refresh. */
  busyCheck?: string;
  /** Run once when the copy is about to expire without an update (errorMin). */
  onStale?: string;
  hookTimeoutSec: number;
  /** Copy's AT has fewer minutes left than this and no update arrived → warn. */
  warnMin: number;
  /** … fewer than this → error (+ onStale). */
  errorMin: number;
}

export interface FleetConfig {
  /** This machine's name in the fleet (busy reports, event origin). */
  machine: string;
  redis: string;
  redisPasswordFile?: string;
  keyFile: string;
  /** Local account id → fleet-wide name to publish it under. */
  publish: Record<string, string>;
  mirrors: MirrorConfig[];
  /** Republish unchanged credentials this often, so a restarted (empty) Redis refills itself. */
  republishMin: number;
  /** Lifetime of a busy report; a crashed machine stops blocking refreshes after this. */
  busyTtlSec: number;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function num(v: unknown, def: number, label: string, min = 0): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${label} must be a number >= ${min}`);
  return n;
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, any>;
  const listen = String(raw.listen ?? '127.0.0.1:8790');
  const m = /^([0-9.]+|localhost|\[[0-9a-f:]+\]):(\d{1,5})$/i.exec(listen);
  if (!m || Number(m[2]) > 65535) throw new Error(`listen must be host:port (port 0-65535), got ${listen}`);
  const host = m[1];
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('listen must be a loopback address; expose it through a reverse proxy (nginx) instead');
  }
  const d = (raw.defaults ?? {}) as Record<string, unknown>;
  const defaults = {
    marginMin: num(d.marginMin, 120, 'defaults.marginMin', 1),
    redMin: num(d.redMin, 30, 'defaults.redMin', 0),
    rtWarnDays: num(d.rtWarnDays, 7, 'defaults.rtWarnDays', 0),
    usagePollMin: num(d.usagePollMin, 10, 'defaults.usagePollMin', 1),
  };
  const accounts: AccountConfig[] = [];
  const seen = new Set<string>();
  const seenPaths = new Set<string>();
  for (const [i, a] of ((raw.accounts ?? []) as Record<string, any>[]).entries()) {
    const id = String(a.id ?? '');
    if (!ID_RE.test(id)) throw new Error(`accounts[${i}].id must match ${ID_RE}`);
    if (seen.has(id)) throw new Error(`duplicate account id ${id}`);
    seen.add(id);
    if ((a.provider ?? 'claude-oauth') !== 'claude-oauth') throw new Error(`accounts[${i}].provider must be claude-oauth`);
    const credentialPath = absPath(String(a.credentialPath ?? ''), `accounts[${i}].credentialPath`);
    if (seenPaths.has(credentialPath)) throw new Error(`accounts[${i}]: credentialPath ${credentialPath} is used by another account`);
    seenPaths.add(credentialPath);
    accounts.push({
      id,
      label: a.label === undefined ? undefined : nonEmptyLabel(a.label, `accounts[${i}].label`),
      provider: 'claude-oauth',
      credentialPath,
      onRefreshed: a.onRefreshed ? absPath(String(a.onRefreshed), `accounts[${i}].onRefreshed`) : undefined,
      hookTimeoutSec: num(a.hookTimeoutSec, 60, `accounts[${i}].hookTimeoutSec`, 1),
      preRefresh: a.preRefresh ? absPath(String(a.preRefresh), `accounts[${i}].preRefresh`) : undefined,
      preRefreshTimeoutSec: num(a.preRefreshTimeoutSec, 20, `accounts[${i}].preRefreshTimeoutSec`, 1),
      preRefreshMaxDeferMin: num(a.preRefreshMaxDeferMin, 60, `accounts[${i}].preRefreshMaxDeferMin`, 0),
      marginMin: num(a.marginMin, defaults.marginMin, `accounts[${i}].marginMin`, 1),
      redMin: num(a.redMin, defaults.redMin, `accounts[${i}].redMin`, 0),
      rtWarnDays: num(a.rtWarnDays, defaults.rtWarnDays, `accounts[${i}].rtWarnDays`, 0),
      usagePollMin: num(a.usagePollMin, defaults.usagePollMin, `accounts[${i}].usagePollMin`, 1),
      legacyLockDir: a.legacyLockDir ? absPath(String(a.legacyLockDir), `accounts[${i}].legacyLockDir`) : undefined,
    });
  }
  let alert: Config['alert'];
  if (raw.alert?.script) {
    const minLevel = (raw.alert.minLevel ?? 'error') as Level;
    if (!LEVELS.includes(minLevel)) throw new Error(`alert.minLevel must be one of ${LEVELS.join('/')}`);
    const hb = raw.alert.heartbeat ? String(raw.alert.heartbeat) : undefined;
    if (hb && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hb)) throw new Error('alert.heartbeat must be HH:MM');
    alert = {
      script: absPath(String(raw.alert.script), 'alert.script'),
      timeoutSec: num(raw.alert.timeoutSec, 30, 'alert.timeoutSec', 1),
      minLevel,
      heartbeat: hb,
    };
  }
  const dataDir = absPath(String(raw.dataDir ?? '~/.cred-keeper'), 'dataDir');
  const fleet = raw.fleet === undefined || raw.fleet === null ? undefined : parseFleet(raw.fleet, accounts);
  const consumers = raw.consumers?.script ? {
    script: absPath(String(raw.consumers.script), 'consumers.script'),
    refreshMin: num(raw.consumers.refreshMin, 10, 'consumers.refreshMin', 1),
    timeoutSec: num(raw.consumers.timeoutSec, 30, 'consumers.timeoutSec', 1),
  } : undefined;
  const t = (raw.usageThresholds ?? {}) as Record<string, unknown>;
  return {
    path,
    listen: { host: host.replace(/^\[|\]$/g, ''), port: Number(m[2]) },
    dataDir,
    proxy: raw.network?.proxy ? String(raw.network.proxy) : undefined,
    claudeBinary: raw.claudeBinary ? absPath(String(raw.claudeBinary), 'claudeBinary') : undefined,
    endpoints: {
      token: String(raw.endpoints?.token ?? 'https://api.anthropic.com/v1/oauth/token'),
      usage: String(raw.endpoints?.usage ?? 'https://api.anthropic.com/api/oauth/usage'),
    },
    clientId: String(raw.clientId ?? DEFAULT_CLIENT_ID),
    accounts,
    alert,
    usageThresholds: {
      fiveHourPct: num(t.fiveHourPct, 80, 'usageThresholds.fiveHourPct'),
      projectedPct: num(t.projectedPct, 100, 'usageThresholds.projectedPct'),
    },
    fleet,
    consumers,
  };
}

function parseFleet(f: Record<string, any>, accounts: AccountConfig[]): FleetConfig {
  const machine = String(f.machine ?? '');
  if (!ID_RE.test(machine)) throw new Error(`fleet.machine must match ${ID_RE}`);
  const redis = String(f.redis ?? '');
  if (!/^redis:\/\/[^/]+/.test(redis)) throw new Error('fleet.redis must be a redis:// URL');
  const names = new Set<string>();
  const claim = (name: string, field: string): void => {
    if (!ID_RE.test(name)) throw new Error(`${field} must match ${ID_RE}`);
    if (names.has(name)) throw new Error(`${field}: fleet name ${name} is used twice`);
    names.add(name);
  };
  const publish: Record<string, string> = {};
  for (const [id, name] of Object.entries((f.publish ?? {}) as Record<string, unknown>)) {
    if (!accounts.some((a) => a.id === id)) throw new Error(`fleet.publish.${id}: no such local account`);
    claim(String(name), `fleet.publish.${id}`);
    publish[id] = String(name);
  }
  const home = homedir();
  const localPaths = new Set(accounts.map((a) => a.credentialPath));
  const mirrors: MirrorConfig[] = [];
  for (const [i, m] of ((f.mirrors ?? []) as Record<string, any>[]).entries()) {
    const field = `fleet.mirrors[${i}]`;
    const name = String(m.name ?? '');
    claim(name, `${field}.name`);
    const credentialPath = absPath(String(m.credentialPath ?? `~/accounts/${name}/claude/.credentials.json`), `${field}.credentialPath`);
    if (localPaths.has(credentialPath)) throw new Error(`${field}.credentialPath is a local account's credentialPath`);
    if (mirrors.some((x) => x.credentialPath === credentialPath)) throw new Error(`${field}.credentialPath is used by another mirror`);
    // A copy must never land in the CLI's default config dir: that is the machine's own login.
    if (dirname(credentialPath) === join(home, '.claude')) throw new Error(`${field}.credentialPath must not be in ~/.claude`);
    const warnMin = num(m.warnMin, 45, `${field}.warnMin`, 1);
    const errorMin = num(m.errorMin, 20, `${field}.errorMin`, 0);
    if (errorMin >= warnMin) throw new Error(`${field}: errorMin must be below warnMin`);
    mirrors.push({
      name,
      credentialPath,
      onUpdated: m.onUpdated ? absPath(String(m.onUpdated), `${field}.onUpdated`) : undefined,
      busyCheck: m.busyCheck ? absPath(String(m.busyCheck), `${field}.busyCheck`) : undefined,
      onStale: m.onStale ? absPath(String(m.onStale), `${field}.onStale`) : undefined,
      hookTimeoutSec: num(m.hookTimeoutSec, 60, `${field}.hookTimeoutSec`, 1),
      warnMin,
      errorMin,
    });
  }
  return {
    machine,
    redis,
    redisPasswordFile: f.redisPasswordFile ? absPath(String(f.redisPasswordFile), 'fleet.redisPasswordFile') : undefined,
    keyFile: absPath(String(f.keyFile ?? '~/.cred-keeper/fleet.key'), 'fleet.keyFile'),
    publish,
    mirrors,
    republishMin: num(f.republishMin, 5, 'fleet.republishMin', 1),
    busyTtlSec: num(f.busyTtlSec, 150, 'fleet.busyTtlSec', 30),
  };
}

export function paths(cfg: Config) {
  return {
    vault: (id: string) => join(cfg.dataDir, 'vault', `${id}.json`),
    pending: (id: string) => join(cfg.dataDir, 'pending', `${id}.json`),
    lock: (id: string) => join(cfg.dataDir, 'locks', `${id}.lock`),
    db: join(cfg.dataDir, 'state.db'),
    logDir: join(cfg.dataDir, 'logs'),
  };
}

function nonEmptyLabel(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 64) throw new Error(`${field} must be a non-empty string (≤64 chars)`);
  return v.trim();
}
