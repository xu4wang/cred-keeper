/** In-process Redis stand-in speaking RESP2: just the commands fleet mode uses. */
import { createServer, type Server, type Socket } from 'node:net';
import { parseReply, type Reply } from '../src/fleet/resp.ts';

type Entry = [string, string[]];

function bulk(v: string | null): string {
  if (v === null) return '$-1\r\n';
  return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
}
function arr(items: string[]): string {
  return `*${items.length}\r\n${items.join('')}`;
}

export class FakeRedis {
  server!: Server;
  port = 0;
  password = 'pw';
  kv = new Map<string, { v: string; exp: number | null }>();
  streams = new Map<string, Entry[]>();
  connections = 0;
  commands: string[][] = [];
  private seq = 0;
  private waiters: (() => void)[] = [];
  private sockets = new Set<Socket>();

  async start(): Promise<this> {
    this.server = createServer((sock) => this.serve(sock));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  url(): string { return `redis://127.0.0.1:${this.port}`; }

  /** Drop every client and refuse new ones (simulates an outage) until resume(). */
  async pause(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  async resume(): Promise<void> {
    this.server = createServer((sock) => this.serve(sock));
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', r));
  }
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  get(k: string): string | null {
    const e = this.kv.get(k);
    if (!e) return null;
    if (e.exp !== null && e.exp <= Date.now()) { this.kv.delete(k); return null; }
    return e.v;
  }

  private serve(sock: Socket): void {
    this.connections++;
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let authed = false;
    let chain = Promise.resolve();
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = parseReply(buf, 0);
        if (!r) break;
        buf = buf.subarray(r.next);
        const args = (r.value as Reply[]).map(String);
        this.commands.push(args);
        chain = chain.then(async () => {
          const out = await this.exec(args, authed, () => { authed = true; });
          if (!sock.destroyed) sock.write(out);
        });
      }
    });
  }

  private async exec(a: string[], authed: boolean, auth: () => void): Promise<string> {
    const cmd = a[0].toUpperCase();
    if (cmd === 'AUTH') {
      if (a[1] === this.password) { auth(); return '+OK\r\n'; }
      return '-WRONGPASS invalid username-password pair\r\n';
    }
    if (!authed) return '-NOAUTH Authentication required.\r\n';
    switch (cmd) {
      case 'PING': return '+PONG\r\n';
      case 'SELECT': return '+OK\r\n';
      case 'GET': return bulk(this.get(a[1]));
      case 'SET': {
        const i = a.findIndex((x, j) => j > 2 && x.toUpperCase() === 'EX');
        this.kv.set(a[1], { v: a[2], exp: i > 0 ? Date.now() + Number(a[i + 1]) * 1000 : null });
        return '+OK\r\n';
      }
      case 'DEL': return `:${this.kv.delete(a[1]) ? 1 : 0}\r\n`;
      case 'KEYS': {
        const prefix = a[1].replace(/\*$/, '');
        const keys = [...this.kv.keys()].filter((k) => k.startsWith(prefix) && this.get(k) !== null);
        return arr(keys.map(bulk));
      }
      case 'XADD': {
        const key = a[1];
        const star = a.indexOf('*');
        const id = `${Date.now()}-${this.seq++}`;
        const list = this.streams.get(key) ?? [];
        list.push([id, a.slice(star + 1)]);
        this.streams.set(key, list);
        for (const w of this.waiters.splice(0)) w();
        return bulk(id);
      }
      case 'XREAD': {
        const block = Number(a[a.indexOf('BLOCK') + 1]);
        const si = a.indexOf('STREAMS');
        const key = a[si + 1];
        let after = a[si + 2];
        const list = () => this.streams.get(key) ?? [];
        if (after === '$') after = list().at(-1)?.[0] ?? '0-0';
        const newer = () => list().filter(([id]) => cmpId(id, after) > 0);
        if (newer().length === 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, block);
            this.waiters.push(() => { clearTimeout(t); r(); });
          });
        }
        const got = newer();
        if (got.length === 0) return '*-1\r\n';
        const entries = got.map(([id, f]) => arr([bulk(id), arr(f.map(bulk))]));
        return arr([arr([bulk(key), arr(entries)])]);
      }
      default: return `-ERR unknown command '${cmd}'\r\n`;
    }
  }
}

function cmpId(x: string, y: string): number {
  const [a1, a2] = x.split('-').map(Number);
  const [b1, b2] = y.split('-').map(Number);
  return a1 - b1 || a2 - b2;
}
