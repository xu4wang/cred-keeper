import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { absPath } from './util.ts';

export type Level = 'info' | 'warn' | 'error' | 'critical';
export const LEVELS: Level[] = ['info', 'warn', 'error', 'critical'];

export interface AccountConfig {
  id: string;
  provider: 'claude-oauth';
  credentialPath: string;
  onRefreshed?: string;
  hookTimeoutSec: number;
  marginMin: number;
  redMin: number;
  rtWarnDays: number;
  usagePollMin: number;
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
  /** Legacy cron lock the service waits for at startup (default account migration). */
  legacyLockDir?: string;
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
      provider: 'claude-oauth',
      credentialPath,
      onRefreshed: a.onRefreshed ? absPath(String(a.onRefreshed), `accounts[${i}].onRefreshed`) : undefined,
      hookTimeoutSec: num(a.hookTimeoutSec, 60, `accounts[${i}].hookTimeoutSec`, 1),
      marginMin: num(a.marginMin, defaults.marginMin, `accounts[${i}].marginMin`, 1),
      redMin: num(a.redMin, defaults.redMin, `accounts[${i}].redMin`, 0),
      rtWarnDays: num(a.rtWarnDays, defaults.rtWarnDays, `accounts[${i}].rtWarnDays`, 0),
      usagePollMin: num(a.usagePollMin, defaults.usagePollMin, `accounts[${i}].usagePollMin`, 1),
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
    legacyLockDir: raw.legacyLockDir === null ? undefined
      : absPath(String(raw.legacyLockDir ?? '~/.botmux/logs/.cred-refresh.lock'), 'legacyLockDir'),
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
