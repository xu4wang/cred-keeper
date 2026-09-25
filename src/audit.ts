/**
 * Contract audit: when the configured claude binary changes (size/mtime),
 * confirm the strings this service depends on are still inside it.
 */
import { readFileSync, statSync } from 'node:fs';
import { USAGE_BETA_HEADER } from './oauth.ts';

export interface AuditResult { changed: boolean; missing: string[]; signature: string }

export function contractNeedles(clientId: string): string[] {
  return [clientId, '/v1/oauth/token', '/api/oauth/usage', USAGE_BETA_HEADER];
}

export function auditBinary(path: string, clientId: string, lastSignature: string | undefined): AuditResult {
  const st = statSync(path);
  const signature = `${st.size}:${Math.floor(st.mtimeMs)}`;
  if (signature === lastSignature) return { changed: false, missing: [], signature };
  const buf = readFileSync(path);
  const missing = contractNeedles(clientId).filter((n) => buf.indexOf(n) === -1);
  return { changed: true, missing, signature };
}
