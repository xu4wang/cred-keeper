/**
 * Claude OAuth endpoints (non-public contract, verified with garbage-RT probes):
 *   POST /v1/oauth/token  grant_type=refresh_token + client_id + refresh_token
 *     RT dead      → 400 {"error":"invalid_grant"}          (flat OAuth shape)
 *     bad request  → 400 {"type":"error","error":{"type":"invalid_request_error"}}
 *     network fail → no response at all
 *   GET  /api/oauth/usage  Bearer AT + anthropic-beta: oauth-2025-04-20
 */
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { TokenResponse } from './cred.ts';

export const USAGE_BETA_HEADER = 'oauth-2025-04-20';

export type RefreshOutcome =
  | { kind: 'ok'; status: 200; bodyText: string; body: TokenResponse }
  | { kind: 'network'; error: string }
  | { kind: 'invalid_grant'; status: number }
  | { kind: 'rejected'; status: number; errorKind: string }
  | { kind: 'unparseable_200'; status: 200; bodyText: string };

export class Http {
  readonly dispatcher?: Dispatcher;
  readonly timeoutMs: number;
  constructor(proxy?: string, timeoutMs = 60_000) {
    this.dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    this.timeoutMs = timeoutMs;
  }

  async request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

/**
 * On HTTP 200 the raw response text is returned unparsed-first (`bodyText`) so
 * the caller persists exactly what the server sent: the RT may already be
 * rotated server-side. Persistence is the caller's job and is deliberately
 * outside this function's network error handling.
 */
export async function refreshToken(http: Http, url: string, clientId: string, refreshTokenValue: string): Promise<RefreshOutcome> {
  let res: Awaited<ReturnType<Http['request']>>;
  let text: string;
  try {
    res = await http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshTokenValue }),
    });
    text = await res.text();
  } catch (e) {
    return { kind: 'network', error: (e as Error).message };
  }
  if (res.status === 200) {
    try {
      const body = JSON.parse(text) as TokenResponse;
      if (body && typeof body === 'object') return { kind: 'ok', status: 200, bodyText: text, body };
    } catch { /* fallthrough */ }
    return { kind: 'unparseable_200', status: 200, bodyText: text };
  }
  let errorKind = 'unknown';
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === 'string') errorKind = j.error;
    else if (j.error && typeof j.error === 'object' && typeof (j.error as { type?: unknown }).type === 'string') {
      errorKind = (j.error as { type: string }).type;
    }
  } catch {
    errorKind = 'unparseable';
  }
  if (errorKind === 'invalid_grant') return { kind: 'invalid_grant', status: res.status };
  return { kind: 'rejected', status: res.status, errorKind };
}

export interface UsageWindow { utilization: number | null; resetsAt: string | null; locked: string | null }
export interface UsageSnapshot {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  limits: { kind: string; percent: number | null; severity: string | null; isActive: boolean | null }[];
}

function win(w: any): UsageWindow {
  return {
    utilization: typeof w?.utilization === 'number' ? w.utilization : null,
    resetsAt: typeof w?.resets_at === 'string' ? w.resets_at : null,
    locked: typeof w?.locked_reason === 'string' && w.locked_reason ? w.locked_reason : null,
  };
}

export async function fetchUsage(http: Http, url: string, accessToken: string): Promise<UsageSnapshot> {
  const res = await http.request(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': USAGE_BETA_HEADER },
  });
  if (res.status !== 200) throw new Error(`usage http ${res.status}`);
  const j = (await res.json()) as any;
  return {
    fiveHour: win(j.five_hour),
    sevenDay: win(j.seven_day),
    limits: Array.isArray(j.limits)
      ? j.limits.map((l: any) => ({
          kind: String(l?.kind ?? ''),
          percent: typeof l?.percent === 'number' ? l.percent : null,
          severity: typeof l?.severity === 'string' ? l.severity : null,
          isActive: typeof l?.is_active === 'boolean' ? l.is_active : null,
        }))
      : [],
  };
}

/**
 * Linear projection of a window's utilization to its end. Window start =
 * resetsAt − length. Undefined in the first 5% of the window (the ratio is
 * meaningless there). An early warning, not a promise.
 */
export function project(w: UsageWindow, lengthMs: number, now: number): number | null {
  if (w.utilization === null || !w.resetsAt) return null;
  const end = Date.parse(w.resetsAt);
  if (!Number.isFinite(end)) return null;
  const elapsed = (now - (end - lengthMs)) / lengthMs;
  if (elapsed < 0.05 || elapsed > 1) return null;
  return Math.round(w.utilization / elapsed);
}
