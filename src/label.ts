/**
 * Display name for an account: the local part (before "@") of the e-mail the CLI
 * is logged in with, read from the claude config that sits next to the credential
 * file — the same resolution claude uses: `~/.claude/.credentials.json` pairs with
 * `~/.claude.json`, `CLAUDE_CONFIG_DIR=<d>` pairs with `<d>/.claude.json`.
 * Only the local part leaves this function (the API has no access control, so no
 * full e-mail addresses). A configured `label` wins; the account id is the fallback.
 */
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileNoFollow } from './util.ts';

export type LabelSource = 'config' | 'claude-login' | 'id';

export function claudeConfigFor(credentialPath: string, home: string = homedir()): string {
  const dir = resolve(dirname(credentialPath));
  return dir === join(home, '.claude') ? join(home, '.claude.json') : join(dir, '.claude.json');
}

export function loginLocalPart(credentialPath: string, home: string = homedir()): string | null {
  let text: string | null;
  try { text = readFileNoFollow(claudeConfigFor(credentialPath, home)); } catch { return null; }
  if (!text) return null;
  try {
    const email = (JSON.parse(text) as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount?.emailAddress;
    if (typeof email !== 'string') return null;
    const local = email.split('@')[0].trim();
    return local || null;
  } catch {
    return null;
  }
}

export function accountLabel(cfg: { id: string; label?: string; credentialPath: string }, home: string = homedir()):
  { label: string; labelSource: LabelSource } {
  if (cfg.label) return { label: cfg.label, labelSource: 'config' };
  const local = loginLocalPart(cfg.credentialPath, home);
  return local ? { label: local, labelSource: 'claude-login' } : { label: cfg.id, labelSource: 'id' };
}
