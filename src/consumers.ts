/**
 * Optional "who uses which credential file" listing. cred-keeper knows nothing about
 * its consumers; a configured script does (e.g. reads botmux's bots.json) and prints
 * a JSON array on stdout:
 *   [{ "id": "<consumer id>", "name": "<display name>", "credentialPath": "/abs/or/~/path" }, …]
 * Entries are matched to accounts and fleet mirrors by credentialPath. Only `id`,
 * `name` and the match leave this module: anything else the script prints is dropped,
 * so a script that dumps a whole config file cannot leak it through the API.
 */
import { absPath } from './util.ts';

export interface Consumer { id: string; name: string }

const ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_ENTRIES = 1000;

/** Parse the script's output; throws on anything that is not a JSON array. Bad entries are skipped. */
export function parseConsumers(text: string): Map<string, Consumer[]> {
  const v = JSON.parse(text) as unknown;
  if (!Array.isArray(v)) throw new Error('consumers script must print a JSON array');
  const out = new Map<string, Consumer[]>();
  for (const e of v.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') continue;
    const { id, name, credentialPath } = e as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id) || typeof credentialPath !== 'string') continue;
    let path: string;
    try { path = absPath(credentialPath, 'credentialPath'); } catch { continue; }
    const display = typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : id;
    const list = out.get(path) ?? [];
    if (!list.some((c) => c.id === id)) list.push({ id, name: display });
    out.set(path, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
