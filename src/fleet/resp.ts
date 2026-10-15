/**
 * Minimal Redis (RESP2) client: just what the fleet cache needs, no dependency.
 * One connection, commands answered in order. Any socket error or timeout fails
 * every outstanding command and closes the connection; callers open a new one.
 */
import { connect, type Socket } from 'node:net';

export type Reply = string | number | null | Reply[];

export class RedisError extends Error {}

interface Pending { resolve: (r: Reply) => void; reject: (e: Error) => void }

export interface RedisTarget { host: string; port: number; password?: string; db?: number }

/** `redis://[:password@]host[:port][/db]`; a password given separately wins over one in the URL. */
export function parseRedisUrl(url: string, password?: string): RedisTarget {
  const u = new URL(url);
  if (u.protocol !== 'redis:') throw new Error(`fleet.redis must be a redis:// URL, got ${u.protocol}`);
  const db = u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined;
  if (db !== undefined && (!Number.isInteger(db) || db < 0)) throw new Error('fleet.redis: bad database number');
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    password: password ?? (u.password ? decodeURIComponent(u.password) : undefined),
    db,
  };
}

export function encodeCommand(args: (string | number)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(String(a), 'utf-8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Parse one reply starting at `pos`; returns null when the buffer holds less than one full reply. */
export function parseReply(buf: Buffer, pos = 0): { value: Reply | RedisError; next: number } | null {
  if (pos >= buf.length) return null;
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf-8', pos + 1, eol);
  switch (type) {
    case '+': return { value: line, next: eol + 2 };
    case '-': return { value: new RedisError(line), next: eol + 2 };
    case ':': return { value: Number(line), next: eol + 2 };
    case '$': {
      const n = Number(line);
      if (n < 0) return { value: null, next: eol + 2 };
      const end = eol + 2 + n;
      if (buf.length < end + 2) return null;
      return { value: buf.toString('utf-8', eol + 2, end), next: end + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) return { value: null, next: eol + 2 };
      const out: Reply[] = [];
      let p = eol + 2;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, p);
        if (!r) return null;
        if (r.value instanceof RedisError) return { value: r.value, next: r.next }; // nested errors fail the whole reply
        out.push(r.value);
        p = r.next;
      }
      return { value: out, next: p };
    }
    default:
      throw new RedisError(`protocol error: unexpected reply type ${JSON.stringify(type)}`);
  }
}

export class RedisConn {
  private sock: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private dead: Error | null = null;

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new RedisError('connection closed')));
  }

  /** Connect, AUTH and SELECT. `timeoutMs` bounds the connect and each command (except blocking reads). */
  static async open(t: RedisTarget, timeoutMs = 5000): Promise<RedisConn> {
    const sock = connect({ host: t.host, port: t.port });
    sock.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new RedisError(`connect timeout ${t.host}:${t.port}`)); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(timer); resolve(); });
      sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const c = new RedisConn(sock);
    try {
      if (t.password) await c.cmd(['AUTH', t.password], timeoutMs);
      if (t.db) await c.cmd(['SELECT', t.db], timeoutMs);
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  /** Send one command. `timeoutMs` 0 = no client-side timeout (blocking reads bring their own). */
  cmd(args: (string | number)[], timeoutMs = 5000): Promise<Reply> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise<Reply>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => this.fail(new RedisError(`command timeout: ${String(args[0])}`)), timeoutMs);
      }
      this.queue.push({
        resolve: (r) => { if (timer) clearTimeout(timer); resolve(r); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      this.sock.write(encodeCommand(args));
    });
  }

  close(): void {
    this.fail(new RedisError('closed by client'));
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let pos = 0;
    try {
      for (;;) {
        const r = parseReply(this.buf, pos);
        if (!r) break;
        pos = r.next;
        const p = this.queue.shift();
        if (!p) throw new RedisError('protocol error: reply without a request');
        if (r.value instanceof RedisError) p.reject(r.value); else p.resolve(r.value);
      }
    } catch (e) {
      this.fail(e as Error);
      return;
    }
    this.buf = this.buf.subarray(pos);
  }

  private fail(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    for (const p of this.queue.splice(0)) p.reject(e);
    this.sock.destroy();
  }
}

/** Open, run `fn`, always close. */
export async function withRedis<T>(t: RedisTarget, fn: (c: RedisConn) => Promise<T>, timeoutMs = 5000): Promise<T> {
  const c = await RedisConn.open(t, timeoutMs);
  try { return await fn(c); } finally { c.close(); }
}
