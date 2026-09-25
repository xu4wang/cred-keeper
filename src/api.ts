/** Read-only REST API. GET only; no secrets and no script output in any response. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Service } from './service.ts';

const VERSION = '0.1.0';

function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sinceParam(v: string | null, def: string): string {
  const s = v ?? def;
  const m = /^(\d+)([mhd])$/.exec(s);
  if (m) {
    const ms = Number(m[1]) * ({ m: 60_000, h: 3600_000, d: 86_400_000 } as const)[m[2] as 'm' | 'h' | 'd'];
    return new Date(Date.now() - ms).toISOString();
  }
  if (!Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  throw new Error(`bad since: ${s}`);
}

export function handle(svc: Service, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') { send(res, 405, { error: 'read-only API: GET only' }); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (url.pathname === '/healthz') {
      send(res, 200, { ok: true, version: VERSION, config: svc.configPath, accounts: [...svc.accounts.keys()], alerts: svc.alerter.enabled });
      return;
    }
    if (parts[0] === 'v1' && parts[1] === 'accounts') {
      if (parts.length === 2) {
        send(res, 200, [...svc.accounts.values()].map((a) => ({ ...a.status(), usage: svc.usage.get(a.cfg.id) ?? null })));
        return;
      }
      const a = svc.accounts.get(parts[2]);
      if (!a) { send(res, 404, { error: 'unknown account' }); return; }
      if (parts.length === 3) {
        send(res, 200, { ...a.status(), usage: svc.usage.get(a.cfg.id) ?? null, recentEvents: svc.store.events({ account: a.cfg.id, limit: 20 }) });
        return;
      }
      if (parts[3] === 'usage' && parts.length === 4) { send(res, 200, svc.usage.get(a.cfg.id) ?? null); return; }
      if (parts[3] === 'usage' && parts[4] === 'history' && parts.length === 5) {
        send(res, 200, svc.store.usageHistory(a.cfg.id, sinceParam(url.searchParams.get('since'), '24h')));
        return;
      }
    }
    if (url.pathname === '/v1/usage') {
      send(res, 200, Object.fromEntries([...svc.accounts.keys()].map((id) => [id, svc.usage.get(id) ?? null])));
      return;
    }
    if (url.pathname === '/v1/events') {
      const q = url.searchParams;
      send(res, 200, svc.store.events({
        account: q.get('account') ?? undefined, type: q.get('type') ?? undefined,
        since: q.get('since') ? sinceParam(q.get('since'), '24h') : undefined, limit: Number(q.get('limit') ?? 200),
      }));
      return;
    }
    if (url.pathname === '/metrics') {
      const lines: string[] = [];
      for (const a of svc.accounts.values()) {
        const s = a.status();
        const l = `account="${s.id}"`;
        if (s.accessToken.leftMin !== null) lines.push(`credkeeper_access_token_left_minutes{${l}} ${s.accessToken.leftMin}`);
        if (s.refreshToken.leftDays !== null) lines.push(`credkeeper_refresh_token_left_days{${l}} ${s.refreshToken.leftDays}`);
        lines.push(`credkeeper_consecutive_failures{${l}} ${s.consecutiveFailures}`);
        lines.push(`credkeeper_state_ok{${l}} ${s.state === 'ok' ? 1 : 0}`);
        const u = svc.usage.get(s.id);
        if (u?.fiveHour.utilization != null) lines.push(`credkeeper_usage_five_hour_pct{${l}} ${u.fiveHour.utilization}`);
        if (u?.sevenDay.utilization != null) lines.push(`credkeeper_usage_seven_day_pct{${l}} ${u.sevenDay.utilization}`);
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(lines.join('\n') + '\n');
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
  }
}

export function startApi(svc: Service): Promise<Server> {
  const server = createServer((req, res) => handle(svc, req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(svc.cfg.listen.port, svc.cfg.listen.host, () => resolve(server));
  });
}
