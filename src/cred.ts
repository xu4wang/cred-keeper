/**
 * Claude OAuth credential file model (`.credentials.json`).
 * Only fingerprints and timestamps ever leave this module in logs/API.
 */
import { fingerprint, parseJsonObject } from './util.ts';

export interface OauthCred {
  /** The whole file object; unknown fields are preserved verbatim. */
  raw: Record<string, unknown>;
  accessToken: string;
  refreshToken: string;
  /** ms epoch */
  expiresAt: number;
  refreshTokenExpiresAt?: number;
  fingerprint: string;
}

export type ParseResult =
  | { ok: true; cred: OauthCred }
  | { ok: false; reason: 'absent' | 'unparseable' | 'logged_out' };

export function parseCred(text: string | null): ParseResult {
  if (text === null) return { ok: false, reason: 'absent' };
  const obj = parseJsonObject(text);
  if (!obj) return { ok: false, reason: 'unparseable' };
  const o = obj.claudeAiOauth as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return { ok: false, reason: 'logged_out' };
  const at = o.accessToken;
  const rt = o.refreshToken;
  if (typeof at !== 'string' || !at || typeof rt !== 'string' || !rt) return { ok: false, reason: 'logged_out' };
  const exp = Number(o.expiresAt) || 0;
  const rtExp = Number(o.refreshTokenExpiresAt) || undefined;
  return {
    ok: true,
    cred: { raw: obj, accessToken: at, refreshToken: rt, expiresAt: exp, refreshTokenExpiresAt: rtExp, fingerprint: fingerprint(at) },
  };
}

export interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
}

/**
 * Merge a token-endpoint response into the current credential (same rules as
 * the legacy bot-cred-refresh-oauth.sh): refresh_token / refresh_token_expires_in
 * / scope are replaced only when present; everything else is preserved.
 * Returns null when required fields are missing, or when neither the access token nor the refresh token changed.
 */
export function mergeTokenResponse(cur: OauthCred, r: TokenResponse, now: number): { text: string; rotatedRt: boolean } | null {
  if (typeof r.access_token !== 'string' || !r.access_token) return null;
  const expiresIn = Number(r.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  const rotatedRt = typeof r.refresh_token === 'string' && r.refresh_token.length > 0 && r.refresh_token !== cur.refreshToken;
  // Nothing new at all → not a usable refresh. A reused AT with a rotated RT is still new.
  if (r.access_token === cur.accessToken && !rotatedRt) return null;
  const o: Record<string, unknown> = { ...(cur.raw.claudeAiOauth as Record<string, unknown>) };
  o.accessToken = r.access_token;
  if (rotatedRt) o.refreshToken = r.refresh_token;
  o.expiresAt = now + expiresIn * 1000;
  const rtIn = Number(r.refresh_token_expires_in);
  if (Number.isFinite(rtIn) && rtIn > 0) o.refreshTokenExpiresAt = now + rtIn * 1000;
  if (typeof r.scope === 'string' && r.scope) o.scopes = r.scope.split(' ');
  return { text: JSON.stringify({ ...cur.raw, claudeAiOauth: o }), rotatedRt };
}
