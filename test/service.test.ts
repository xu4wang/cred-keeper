import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Service } from '../src/service.ts';
import { startApi } from '../src/api.ts';
import { contractNeedles } from '../src/audit.ts';
import { FakeAnthropic, credText, tmp, writeConfig } from './helpers.ts';

const fake = await new FakeAnthropic().start();
after(() => fake.stop());
const HOUR = 3600_000;

function setup(expIn = 10 * HOUR, extra: Record<string, unknown> = {}) {
  const d = tmp();
  const cfgPath = writeConfig(d, fake, extra);
  const credPath = join(d, 'acct', '.credentials.json');
  writeFileSync(credPath, credText('AT-SECRET-1', 'RT-SECRET-1', Date.now() + expIn, { refreshTokenExpiresAt: Date.now() + 3 * 86_400_000 }), { mode: 0o600 });
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  for (const a of svc.accounts.values()) { a.jitterMs = 0; a.gateProbe = () => 'not-applicable'; }
  return { d, cfgPath, credPath, svc };
}

test('tick: refreshes when due, polls usage with the beta header otherwise; thresholds alert once per window', async () => {
  const { svc } = setup(10 * HOUR);
  const resetsAt = new Date(Date.now() + 2 * HOUR).toISOString();
  fake.usageReply = { status: 200, body: { five_hour: { utilization: 90, resets_at: resetsAt }, seven_day: { utilization: 10, resets_at: resetsAt }, limits: [] } };
  const nTok = fake.tokenRequests.length;
  await svc.tick();
  assert.equal(fake.tokenRequests.length, nTok, 'not due → no refresh');
  assert.equal(fake.usageRequests.at(-1)!.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(fake.usageRequests.at(-1)!.headers['authorization'], 'Bearer AT-SECRET-1');
  assert.equal(svc.usage.get('a1')!.fiveHour.utilization, 90);
  await svc.pollUsage(svc.accounts.get('a1')!, 'AT-SECRET-1', true);
  const high = svc.store.events({ type: 'usage_high', limit: 10 });
  assert.equal(high.length, 1, 'usage_high once per window instance');
  const rt = svc.store.events({ type: 'rt_expiring', limit: 10 });
  assert.equal(rt.length, 1, 'RT with 3 days left → rt_expiring once today');
  await svc.tick();
  assert.equal(svc.store.events({ type: 'rt_expiring', limit: 10 }).length, 1, 'not repeated on the next tick');
});

test('tick: due account is refreshed', async () => {
  const { svc, credPath } = setup(30 * 60_000);
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-SECRET-2', expires_in: 28800 } });
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-SECRET-2/);
});

test('API: GET only, known routes, and no token material in any response', async () => {
  const { svc } = setup(10 * HOUR);
  fake.usageReply = { status: 200, body: { five_hour: { utilization: 5, resets_at: new Date(Date.now() + HOUR).toISOString() }, seven_day: {} } };
  await svc.tick();
  const server = await startApi(svc);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const bodies: string[] = [];
    for (const p of ['/healthz', '/v1/accounts', '/v1/accounts/a1', '/v1/accounts/a1/usage', '/v1/accounts/a1/usage/history?since=1h', '/v1/usage', '/v1/events?since=1d', '/metrics']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      bodies.push(await r.text());
    }
    const all = bodies.join('\n');
    assert.doesNotMatch(all, /AT-SECRET|RT-SECRET/);
    const acct = JSON.parse(bodies[2]);
    assert.equal(acct.state, 'ok');
    assert.match(acct.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(acct.refreshToken.leftDays, 2);
    assert.equal((await fetch(base + '/v1/accounts', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/v1/accounts/nope')).status, 404);
    assert.equal((await fetch(base + '/v1/events?since=garbage')).status, 400);
  } finally {
    server.close();
  }
});

test('config reload is deferred while a refresh is in flight', async () => {
  const { svc, cfgPath } = setup(10 * HOUR);
  const a = svc.accounts.get('a1')!;
  (a as unknown as { refreshing: boolean }).refreshing = true;
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  cfg.accounts.push({ id: 'a2', credentialPath: join(tmp(), 'c.json') });
  writeFileSync(cfgPath, JSON.stringify(cfg));
  svc.reload();
  assert.equal(svc.accounts.has('a2'), false, 'deferred');
  (a as unknown as { refreshing: boolean }).refreshing = false;
  svc.reload();
  assert.equal(svc.accounts.has('a2'), true);
  assert.equal(svc.accounts.get('a1'), a, 'unchanged account keeps its state object');
});

test('contract needles are present in the installed claude binary (read-only, skipped if absent)', { skip: !process.env.CK_CLAUDE_BINARY }, () => {
  const buf = readFileSync(process.env.CK_CLAUDE_BINARY!);
  for (const n of contractNeedles('9d1c250a-e61b-44d9-88ed-5944d1962f5e')) assert.notEqual(buf.indexOf(n), -1, n);
});

test('tick does not overlap itself', async () => {
  const { svc } = setup(10 * HOUR);
  (svc as unknown as { ticking: boolean }).ticking = true;
  const n = fake.usageRequests.length;
  await svc.tick();
  assert.equal(fake.usageRequests.length, n);
});

test('healthz keychainGate is the most recent probe, not config order', () => {
  const { svc } = setup(10 * HOUR);
  const s = svc as unknown as { startupGate: string; startupGateAt: number };
  s.startupGate = 'active'; s.startupGateAt = 1;
  const a = svc.accounts.get('a1')!;
  a.keychainGate = 'unavailable'; a.keychainGateAt = 5;
  assert.equal(svc.keychainGate, 'unavailable');
  s.startupGateAt = 9;
  assert.equal(svc.keychainGate, 'active');
});
