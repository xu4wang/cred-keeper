import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ck-test-'));
}

export function credText(at: string, rt: string, expiresAt: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: at, refreshToken: rt, expiresAt, scopes: ['user:inference'], ...extra }, other: 'keep' });
}

export type Reply = { status: number; body: unknown } | 'hangup';

export class FakeAnthropic {
  server!: Server;
  port = 0;
  tokenReplies: Reply[] = [];
  usageReply: Reply = { status: 200, body: {} };
  tokenRequests: any[] = [];
  usageRequests: { headers: Record<string, unknown> }[] = [];

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (path === '/v1/oauth/token') {
          if (req.method === 'GET') { res.writeHead(405).end(); return; }
          this.tokenRequests.push(JSON.parse(body));
          const r = this.tokenReplies.shift() ?? { status: 500, body: { error: 'no reply queued' } };
          if (r === 'hangup') { req.socket.destroy(); return; }
          const raw = (r.body as { __raw?: string } | null)?.__raw;
          res.writeHead(r.status, { 'content-type': 'application/json' }).end(raw ?? JSON.stringify(r.body));
          return;
        }
        if (path === '/api/oauth/usage') {
          this.usageRequests.push({ headers: req.headers });
          const r = this.usageReply;
          if (r === 'hangup') { req.socket.destroy(); return; }
          res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }
  url(p: string): string { return `http://127.0.0.1:${this.port}${p}`; }
  stop(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
}

export function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o700);
  return p;
}

export function writeConfig(dir: string, fake: FakeAnthropic, extra: Record<string, unknown> = {}): string {
  const cfg = {
    listen: '127.0.0.1:0',
    dataDir: join(dir, 'data'),
    endpoints: { token: fake.url('/v1/oauth/token'), usage: fake.url('/api/oauth/usage') },
    legacyLockDir: null,
    accounts: [{ id: 'a1', credentialPath: join(dir, 'acct', '.credentials.json') }],
    ...extra,
  };
  mkdirSync(join(dir, 'acct'), { recursive: true });
  const p = join(dir, 'config.json');
  writeFileSync(p, JSON.stringify(cfg));
  return p;
}
