/**
 * Per-account refresh lock. Held only for one refresh, never across the
 * service's lifetime. The file records holder pid + that process's start
 * time, so a stale lock is recognised both when the pid is gone and when the
 * pid has been reused by an unrelated process (e.g. our own previous instance
 * crashed and the pid number came back).
 */
import { execFileSync } from 'node:child_process';
import { constants, closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir0700, parseJsonObject } from './util.ts';

export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const s = out.trim().replace(/\s+/g, ' ');
    return s || null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockHolder { pid: number; start: string | null }

/** Is the lock at `path` held by a process that is still the one that took it? */
export function lockIsLive(path: string, probeStart: (pid: number) => string | null = processStartTime): boolean {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return false; }
  const h = parseJsonObject(raw) as LockHolder | null;
  if (!h || !Number.isInteger(h.pid) || h.pid <= 0) return false;
  if (!pidAlive(h.pid)) return false;
  const start = probeStart(h.pid);
  if (h.start && start && h.start !== start) return false; // pid reused
  return true;
}

export function tryAcquire(path: string, probeStart: (pid: number) => string | null = processStartTime): boolean {
  ensureDir0700(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, start: probeStart(process.pid) }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (lockIsLive(path, probeStart)) return false;
      rmSync(path, { force: true }); // stale: dead holder or reused pid
    }
  }
  return false;
}

export function release(path: string): void {
  try {
    const h = parseJsonObject(readFileSync(path, 'utf-8')) as LockHolder | null;
    if (h?.pid === process.pid) rmSync(path, { force: true });
  } catch { /* already gone */ }
}

/** The legacy cron script's mkdir lock: `<dir>/pid`. Live iff that pid is alive. */
export function legacyLockLive(dir: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(`${dir}/pid`, 'utf-8').trim()); } catch { return false; }
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
}
