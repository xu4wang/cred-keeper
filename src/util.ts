import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function absPath(p: string, label: string): string {
  const e = expandHome(p.trim());
  if (!isAbsolute(e)) throw new Error(`${label} must be an absolute path or start with ~/: ${p}`);
  return resolve(e);
}

/** First 12 hex chars of sha256 — the only form a secret ever leaves this process in. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

/** Read a regular file without following a leaf symlink. `null` when absent. */
export function readFileNoFollow(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically replace `path` with `body`: a fresh O_EXCL 0600 temp file in the
 * same directory, then rename. Never writes through an existing leaf symlink,
 * always leaves a private regular file, removes the temp file on any failure.
 * The parent must be a real directory (not a symlink).
 */
export function writeFileAtomic0600(path: string, body: string): void {
  const parent = dirname(path);
  assertRealDir(parent);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, body);
    } finally {
      closeSync(fd);
    }
    assertRealDir(parent);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function assertRealDir(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real directory`);
}

export function ensureDir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function nowIso(t: number = Date.now()): string {
  return new Date(t).toISOString();
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
