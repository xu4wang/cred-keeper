import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, statSync } from 'node:fs';
import { auditBinary } from './audit.ts';
import { keychainItemExists, keychainServiceFor, probeKeychainGate } from './keychain.ts';
import { type Config } from './config.ts';
import { parseCred } from './cred.ts';
import { legacyLockLive } from './lock.ts';
import { Http } from './oauth.ts';
import { readFileNoFollow } from './util.ts';

export interface Check { name: string; ok: boolean; detail: string }

function executable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
}

export async function doctor(cfg: Config): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  // Connectivity from the service's own environment. Only 405 on GET counts:
  // a 403 may be an interception layer's fake response.
  try {
    const res = await new Http(cfg.proxy, 15_000).request(cfg.endpoints.token, { method: 'GET' });
    add('connectivity', res.status === 405, `GET ${cfg.endpoints.token} → ${res.status}${cfg.proxy ? ` via ${cfg.proxy}` : ' (direct)'}`);
  } catch (e) {
    add('connectivity', false, `GET ${cfg.endpoints.token} failed: ${(e as Error).message}`);
  }

  for (const a of cfg.accounts) {
    const text = readFileNoFollow(a.credentialPath);
    const c = parseCred(text);
    add(`account:${a.id}:credential`, c.ok, c.ok ? `fingerprint ${c.cred.fingerprint}` : `${a.credentialPath}: ${c.reason}`);
    if (text !== null) {
      const mode = lstatSync(a.credentialPath).mode & 0o777;
      add(`account:${a.id}:mode`, mode === 0o600, `mode ${mode.toString(8)}`);
    }
    if (a.onRefreshed) add(`account:${a.id}:onRefreshed`, executable(a.onRefreshed), a.onRefreshed);
    const svc = keychainServiceFor(a.credentialPath);
    const has = keychainItemExists(svc);
    if (has !== null) add(`account:${a.id}:keychain`, !has, has ? `keychain item "${svc}" exists — claude will read it instead of the file` : `no "${svc}"`);
  }
  if (process.platform === 'darwin') {
    const g = probeKeychainGate();
    add('keychain-gate', g === 'active', g === 'active' ? 'sentinel visible (from this context)' : 'sentinel not found: run `cred-keeper keychain-sentinel`; the running service reports its own view in /healthz keychainGate');
  }

  if (cfg.alert) add('alert:script', executable(cfg.alert.script), cfg.alert.script);
  else add('alert:script', true, 'not configured — no alerts will be sent');

  if (cfg.claudeBinary) {
    if (!existsSync(cfg.claudeBinary)) add('contract', false, `${cfg.claudeBinary} not found`);
    else {
      const r = auditBinary(cfg.claudeBinary, cfg.clientId, undefined);
      add('contract', r.missing.length === 0, r.missing.length ? `missing: ${r.missing.join(', ')}` : 'client_id, endpoints and beta header present');
    }
  }

  try {
    const cron = execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const legacy = cron.split('\n').filter((l) => !l.trimStart().startsWith('#') && /bot-cred-refresh|cred-contract-audit/.test(l));
    add('legacy-cron', legacy.length === 0, legacy.length ? `still scheduled: ${legacy.join(' | ')}` : 'no legacy refresh lines');
  } catch {
    add('legacy-cron', true, 'no crontab');
  }
  for (const a of cfg.accounts) if (a.legacyLockDir) add(`account:${a.id}:legacy-lock`, !legacyLockLive(a.legacyLockDir), `${a.legacyLockDir} (held by a running cron refresh?)`);
  return out;
}
