/**
 * Claude's macOS keychain item for a credential file. claude prefers the
 * keychain over the file, so an item here means the file we refresh is not
 * what claude reads (a "split"). Only existence is ever checked — never -w.
 *   default config dir (~/.claude)      → "Claude Code-credentials"
 *   CLAUDE_CONFIG_DIR=<dir>              → "Claude Code-credentials-<sha256(dir)[:8]>"
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function keychainServiceFor(credentialPath: string): string {
  const dir = resolve(dirname(credentialPath));
  if (dir === join(homedir(), '.claude')) return 'Claude Code-credentials';
  return `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

/**
 * The user's login keychain, named explicitly: a LaunchDaemon runs in the system
 * domain, where the default search list does not include it, so an implicit
 * lookup would always answer "absent".
 */
export function loginKeychainPath(): string {
  return join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

/** Existence-only lookup in an explicitly named keychain (never `-w`: the secret is never read). */
export function keychainLookupArgs(service: string, keychain: string): string[] {
  return ['find-generic-password', '-s', service, keychain];
}

/** true = item exists, false = absent, null = cannot tell (not macOS / security failed oddly). */
export function keychainItemExists(service: string, keychain = loginKeychainPath()): boolean | null {
  if (process.platform !== 'darwin') return null;
  try {
    execFileSync('/usr/bin/security', keychainLookupArgs(service, keychain), { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch (e) {
    return (e as { status?: number }).status === 44 ? false : null;
  }
}

/**
 * A harmless item the operator creates from a normal login session
 * (`cred-keeper keychain-sentinel`). The service looks it up at startup in its
 * own context: found → the split gate really can see the login keychain;
 * not found → the gate cannot work here and is reported as unavailable instead
 * of silently answering "no split" forever.
 */
export const SENTINEL_SERVICE = 'cred-keeper-keychain-sentinel';

export type GateState = 'active' | 'unavailable' | 'not-applicable';

export function probeKeychainGate(keychain = loginKeychainPath()): GateState {
  if (process.platform !== 'darwin') return 'not-applicable';
  return keychainItemExists(SENTINEL_SERVICE, keychain) === true ? 'active' : 'unavailable';
}

export function installSentinel(keychain = loginKeychainPath()): void {
  execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', SENTINEL_SERVICE, '-a', 'cred-keeper', '-w', 'sentinel', keychain], { stdio: 'inherit' });
}
