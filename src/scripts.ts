/**
 * Runs operator scripts (onRefreshed / alert). Executed directly (no shell),
 * in their own process group so a timeout kills the whole tree. Only
 * secret-free env is passed; stdout/stderr tails go to the local log file,
 * never into events or the API.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir0700, nowIso, redact } from './util.ts';

export interface ScriptResult { code: number | null; signal: string | null; timedOut: boolean; ms: number; error?: string }

const TAIL = 4096;

export function runScript(opts: {
  script: string; env: Record<string, string>; stdin?: string; timeoutMs: number; logDir: string; label: string;
  /** Secrets to scrub from the captured output before it is logged. */
  redactKnown?: readonly string[];
  /** How long to let stdio drain after exit (ms). */
  drainMs?: number;
}): Promise<ScriptResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString('utf-8')).slice(-TAIL); };
    let child;
    try {
      child = spawn(opts.script, [], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', ...opts.env },
      });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut: false, ms: 0, error: (e as Error).message });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
    }, opts.timeoutMs);
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    child.stdin!.on('error', () => { /* script may not read stdin */ });
    child.stdin!.end(opts.stdin ?? '');
    let finished = false;
    const done = (r: ScriptResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        ensureDir0700(opts.logDir);
        appendFileSync(join(opts.logDir, 'scripts.log'),
          `${nowIso()} ${opts.label} code=${r.code} signal=${r.signal} timedOut=${r.timedOut} ms=${r.ms}${r.error ? ` error=${r.error}` : ''}\n${redact(out, opts.redactKnown)}\n---\n`,
          { mode: 0o600 });
      } catch { /* logging is best effort */ }
      resolve(r);
    };
    child.on('error', (e) => done({ code: null, signal: null, timedOut, ms: Date.now() - started, error: e.message }));
    // 'exit', not 'close': a background descendant holding stdout open must not
    // turn a finished script into a timeout. Give stdio a moment to flush.
    child.on('exit', (code, signal) => {
      clearTimeout(timer); // the script is done; the drain delay below must not count against its timeout
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done({ code, signal, timedOut, ms: Date.now() - started });
      }, opts.drainMs ?? 100);
    });
  });
}

export const succeeded = (r: ScriptResult) => r.code === 0 && !r.timedOut && !r.error;
