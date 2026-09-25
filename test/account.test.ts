import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { Service } from '../src/service.ts';
import { paths } from '../src/config.ts';
import { parseCred } from '../src/cred.ts';
import { FakeAnthropic, credText, script, tmp, writeConfig } from './helpers.ts';

const fake = await new FakeAnthropic().start();
after(() => fake.stop());

const HOUR = 3600_000;
function setup(opts: { hook?: string; alert?: string; expIn?: number; minLevel?: string } = {}) {
  fake.tokenReplies.length = 0;
  const d = tmp();
  const extra: Record<string, unknown> = {};
  const accounts = [{ id: 'a1', credentialPath: join(d, 'acct', '.credentials.json'), onRefreshed: opts.hook, hookTimeoutSec: 5 }];
  extra.accounts = accounts;
  if (opts.alert) extra.alert = { script: opts.alert, timeoutSec: 5, minLevel: opts.minLevel ?? 'error' };
  const cfgPath = writeConfig(d, fake, extra);
  writeFileSync(accounts[0].credentialPath, credText('AT-old', 'RT-old', Date.now() + (opts.expIn ?? HOUR)), { mode: 0o600 });
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  const a = svc.accounts.get('a1')!;
  a.jitterMs = 0;
  return { d, svc, a, credPath: accounts[0].credentialPath, p: paths(svc.cfg) };
}
const types = (svc: Service) => svc.store.events({ limit: 100 }).map((e) => e.type).reverse();

test('refresh ok: vault + file updated, .prev kept, pending removed, hook env carries no token', async () => {
  const d0 = tmp();
  const envOut = join(d0, 'env.txt');
  const hook = script(d0, 'hook.sh', `env > ${envOut}`);
  const { svc, a, credPath, p } = setup({ hook });
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 28800 } });
  assert.equal(await a.refresh(), 'refreshed');
  const pub = parseCred(readFileSync(credPath, 'utf-8'));
  assert.ok(pub.ok && pub.cred.accessToken === 'AT-new' && pub.cred.refreshToken === 'RT-new');
  assert.equal(readFileSync(p.vault('a1'), 'utf-8'), readFileSync(credPath, 'utf-8'), 'vault == published');
  assert.match(readFileSync(`${credPath}.prev`, 'utf-8'), /AT-old/);
  assert.equal(existsSync(p.pending('a1')), false);
  assert.equal(fake.tokenRequests.at(-1).refresh_token, 'RT-old');
  const env = readFileSync(envOut, 'utf-8');
  assert.match(env, /CK_ACCOUNT=a1/);
  assert.match(env, /CK_FINGERPRINT=[0-9a-f]{12}/);
  assert.doesNotMatch(env, /AT-new|RT-new|AT-old|RT-old/);
  assert.deepEqual(types(svc).filter((t) => t !== 'vault_initialized'), ['refreshed', 'hook_ok']);
});

test('not due → no request', async () => {
  const { a } = setup({ expIn: 10 * HOUR });
  const n = fake.tokenRequests.length;
  assert.equal(await a.refresh(), 'not_due');
  assert.equal(fake.tokenRequests.length, n);
});

test('network failure: file untouched, warn then error, recovered after success', async () => {
  const { svc, a, credPath } = setup();
  const before = readFileSync(credPath, 'utf-8');
  fake.tokenReplies.push('hangup', 'hangup');
  assert.equal(await a.refresh(), 'network');
  assert.equal(await a.refresh(), 'network');
  assert.equal(readFileSync(credPath, 'utf-8'), before);
  assert.equal(a.state, 'retrying');
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-2', expires_in: 100 } });
  assert.equal(await a.refresh(), 'refreshed');
  const t = types(svc);
  assert.deepEqual(t.filter((x) => /refresh|recovered/.test(x)), ['refresh_retry', 'refresh_failed', 'refreshed', 'recovered']);
});

test('invalid_grant → dead, not retried with the same RT; adopting a newer file recovers', async () => {
  const { svc, a, credPath } = setup();
  fake.tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
  assert.equal(await a.refresh(), 'dead');
  const n = fake.tokenRequests.length;
  assert.equal(await a.refresh(), 'dead');
  assert.equal(fake.tokenRequests.length, n, 'no request with a known-dead RT');
  writeFileSync(credPath, credText('AT-human', 'RT-human', Date.now() + 8 * HOUR), { mode: 0o600 });
  a.reconcile();
  assert.equal(a.state, 'ok');
  assert.ok(types(svc).includes('adopted'));
});

test('200 with unknown fields → critical, pending response kept, file untouched', async () => {
  const { a, credPath, p } = setup();
  const before = readFileSync(credPath, 'utf-8');
  fake.tokenReplies.push({ status: 200, body: { weird: 1 } });
  assert.equal(await a.refresh(), 'critical');
  assert.equal(readFileSync(credPath, 'utf-8'), before);
  assert.ok(existsSync(p.pending('a1')));
});

test('request error shape → rejected (contract drift suspect)', async () => {
  const { svc, a } = setup();
  fake.tokenReplies.push({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error' } } });
  assert.equal(await a.refresh(), 'rejected');
  const ev = svc.store.events({ type: 'refresh_failed', limit: 1 })[0];
  assert.equal(ev.data.errorKind, 'invalid_request_error');
});

test('reconcile table: cleared/older → republish from vault; newer → adopt; both gone → breaker', async () => {
  const { svc, a, credPath, p } = setup();
  a.reconcile(); // initializes vault
  const vault = readFileSync(p.vault('a1'), 'utf-8');
  writeFileSync(credPath, '{}'); // logged out by a consumer
  a.reconcile();
  assert.equal(readFileSync(credPath, 'utf-8'), vault);
  rmSync(credPath);
  a.reconcile();
  assert.equal(readFileSync(credPath, 'utf-8'), vault, 'absent → republished');
  writeFileSync(credPath, credText('AT-older', 'RT-older', Date.now() - HOUR));
  a.reconcile();
  assert.equal(readFileSync(credPath, 'utf-8'), vault, 'older → republished');
  const newer = credText('AT-newer', 'RT-newer', Date.now() + 5 * HOUR);
  writeFileSync(credPath, newer);
  a.reconcile();
  assert.equal(readFileSync(p.vault('a1'), 'utf-8'), newer, 'newer → adopted');
  rmSync(p.vault('a1'));
  writeFileSync(credPath, 'garbage');
  assert.equal(a.reconcile(), null);
  assert.equal(a.state, 'breaker');
  const t = types(svc);
  assert.equal(t.filter((x) => x === 'republished').length, 3);
  assert.ok(t.includes('adopted') && t.includes('breaker'));
});

test('pending recovery: applied from base; already-applied or superseded removed; unrelated kept and blocks refresh', async () => {
  const { svc, a, credPath, p } = setup();
  const vault = a.reconcile()!;
  mkdirSync(dirname(p.pending('a1')), { recursive: true });
  const pend = (base: string, body: unknown, at = Date.now()) =>
    writeFileSync(p.pending('a1'), JSON.stringify({ base, at, raw: JSON.stringify(body) }));
  pend(vault.fingerprint, { access_token: 'AT-rec', refresh_token: 'RT-rec', expires_in: 100 });
  assert.equal(await a.recoverPending(), 'applied');
  const pub = parseCred(readFileSync(credPath, 'utf-8'));
  assert.ok(pub.ok && pub.cred.refreshToken === 'RT-rec');
  assert.equal(existsSync(p.pending('a1')), false);
  assert.ok(types(svc).includes('recovered_pending'));
  pend('whatever', { access_token: 'AT-rec', expires_in: 100 });
  assert.equal(await a.recoverPending(), 'none', 'vault already carries this AT → applied earlier');
  assert.equal(existsSync(p.pending('a1')), false);
  pend('whatever', { access_token: 'AT-other', refresh_token: 'RT-rec', expires_in: 100 });
  assert.equal(await a.recoverPending(), 'none', 'vault already carries this RT → applied earlier');
  pend('oldbase', { access_token: 'AT-x', refresh_token: 'RT-x', expires_in: 1 }, Date.now() - HOUR);
  assert.equal(await a.recoverPending(), 'unresolved', 'expiry ordering proves nothing about lineage: keep it');
  assert.ok(existsSync(p.pending('a1')), 'possibly the only live RT: never deleted automatically');
  assert.equal(a.state, 'critical');
  const n = fake.tokenRequests.length;
  assert.equal(await a.refresh(true), 'pending_unresolved');
  assert.equal(fake.tokenRequests.length, n, 'no new refresh while a pending response is unresolved');
  await a.recoverPending();
  await a.recoverPending();
  assert.equal(svc.store.events({ type: 'pending_unresolved', limit: 10 }).length, 1, 'reported once per pending content, not per tick');
  assert.equal(await a.resolvePending('apply'), 'base_mismatch', 'must name the credential being displaced');
  const displacedFp = a.vault()!.fingerprint;
  assert.equal(await a.resolvePending('apply', displacedFp), 'applied');
  assert.match(readFileSync(credPath, 'utf-8'), /RT-x/);
  const vdir = dirname(p.vault('a1'));
  const displaced = (await import('node:fs')).readdirSync(vdir).filter((n) => n.includes('.displaced-'));
  assert.equal(displaced.length, 1, 'the displaced vault is kept aside');
  assert.match(readFileSync(join(vdir, displaced[0]), 'utf-8'), /RT-rec/);
  assert.equal(existsSync(p.pending('a1')), false);
  pend('oldbase', { access_token: 'AT-z', refresh_token: 'RT-z', expires_in: 1 });
  assert.equal(await a.resolvePending('discard'), 'discarded');
  assert.equal(existsSync(p.pending('a1')), false);
  // another process holds the account lock → the service's recovery skips this tick
  pend('oldbase2', { access_token: 'AT-l', refresh_token: 'RT-l', expires_in: 1 });
  writeFileSync(p.lock('a1'), JSON.stringify({ pid: process.ppid, start: null }));
  assert.equal(await a.recoverPending(), 'locked');
  rmSync(p.lock('a1'));
});

test('pending cannot be persisted → the new credential is still applied', async () => {
  const { svc, a, credPath, p } = setup();
  writeFileSync(dirname(p.pending('a1')), 'not a dir'); // makes the pending write fail
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-np', refresh_token: 'RT-np', expires_in: 100 } });
  assert.equal(await a.refresh(), 'refreshed');
  assert.match(readFileSync(credPath, 'utf-8'), /RT-np/);
  assert.ok(types(svc).includes('persist_failed'));
});

test('vault cannot be written → kept in memory, flushed on a later tick', async () => {
  const { svc, a, credPath, p } = setup();
  a.reconcile();
  const vdir = dirname(p.vault('a1'));
  chmodSync(vdir, 0o500);
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-mem', refresh_token: 'RT-mem', expires_in: 28800 } });
  try {
    assert.equal(await a.refresh(), 'persist_failed');
    assert.equal(a.state, 'critical');
    assert.ok(a.unsaved?.includes('RT-mem'));
  } finally {
    chmodSync(vdir, 0o700);
  }
  writeFileSync(p.lock('a1'), JSON.stringify({ pid: process.ppid, start: null })); // another process holds the lock
  assert.equal(a.flushUnsaved(), false, 'never touches vault/pending without the account lock');
  assert.doesNotMatch(readFileSync(credPath, 'utf-8'), /RT-mem/);
  rmSync(p.lock('a1'));
  await svc.tick();
  assert.equal(a.unsaved, null);
  assert.match(readFileSync(credPath, 'utf-8'), /RT-mem/);
  assert.match(readFileSync(p.vault('a1'), 'utf-8'), /RT-mem/);
  assert.equal(a.state, 'ok');
});

test('raw 200 body is persisted verbatim, even when it is not valid JSON', async () => {
  const { a, p } = setup();
  const rawText = '{"access_token":"AT-trunc","refresh_token":"RT-trunc"'; // truncated: not JSON
  fake.tokenReplies.push({ status: 200, body: { __raw: rawText } });
  assert.equal(await a.refresh(), 'critical');
  const pend = JSON.parse(readFileSync(p.pending('a1'), 'utf-8'));
  assert.equal(pend.raw, rawText, 'kept byte-for-byte so a human can still recover the RT');
});

test('a stuck state clears when another process refreshed (vault and file both moved on)', async () => {
  const { a, credPath, p } = setup();
  fake.tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
  await a.refresh();
  assert.equal(a.state, 'dead');
  const next = credText('AT-cli', 'RT-cli', Date.now() + 7 * HOUR);
  writeFileSync(p.vault('a1'), next); // what `cred-keeper refresh` in another process leaves behind
  writeFileSync(credPath, next);
  a.reconcile();
  assert.equal(a.state, 'ok');
});

test('a stuck state clears when a newer login is adopted', async () => {
  const { a, credPath } = setup();
  fake.tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
  await a.refresh();
  assert.equal(a.state, 'dead');
  // e.g. `cred-keeper refresh` in another process, or a login published to the file
  writeFileSync(credPath, credText('AT-other', 'RT-other', Date.now() + 7 * HOUR));
  a.reconcile();
  assert.equal(a.state, 'ok');
});

test('hook: one retry within budget, then hook_failed (critical)', async () => {
  const d0 = tmp();
  const counter = join(d0, 'n');
  const flaky = script(d0, 'flaky.sh', `n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; [ $n -ge 2 ]`);
  let s = setup({ hook: flaky });
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-h1', expires_in: 100 } });
  await s.a.refresh();
  assert.equal(readFileSync(counter, 'utf-8').trim(), '2');
  assert.ok(types(s.svc).includes('hook_ok'));
  const bad = script(d0, 'bad.sh', 'exit 3');
  s = setup({ hook: bad });
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-h2', expires_in: 100 } });
  await s.a.refresh();
  const ev = s.svc.store.events({ type: 'hook_failed', limit: 1 })[0];
  assert.equal(ev.level, 'critical');
  assert.equal(ev.data.attempts, 2);
  assert.equal(ev.data.code, 3);
  assert.equal(JSON.stringify(ev).includes('exit'), false, 'no script output in events');
  const leaky = script(d0, 'leaky.sh', 'cat "$CK_CREDENTIAL_PATH"; echo sk-ant-ort01-abcdefghijklmnop');
  s = setup({ hook: leaky });
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-leak-123456', refresh_token: 'RT-leak-123456', expires_in: 100 } });
  await s.a.refresh();
  const log = readFileSync(join(s.p.logDir, 'scripts.log'), 'utf-8');
  assert.doesNotMatch(log, /AT-leak-123456|RT-leak-123456|sk-ant-ort01-abcdefghijklmnop/);
  assert.match(log, /\[redacted\]/);
});

test('alerts: minLevel filter, dedupe per episode, reset on recovery, undelivered after retries', async () => {
  const d0 = tmp();
  const log = join(d0, 'alerts.log');
  const alert = script(d0, 'alert.sh', `echo "$CK_EVENT $CK_LEVEL $CK_ACCOUNT" >> ${log}; cat > /dev/null`);
  const { svc, a } = setup({ alert });
  fake.tokenReplies.push('hangup', 'hangup', 'hangup');
  await a.refresh(); // warn → filtered
  await a.refresh(); // error → sent
  await a.refresh(); // error again → deduped
  fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-r', expires_in: 100 } });
  await a.refresh(); // recovered → sent
  await svc.alerter.drain();
  assert.deepEqual(readFileSync(log, 'utf-8').trim().split('\n'), ['refresh_failed error a1', 'recovered info a1']);
  const broken = script(d0, 'broken.sh', 'exit 1');
  const s2 = setup({ alert: broken });
  fake.tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
  await s2.a.refresh();
  await s2.svc.alerter.drain();
  assert.equal(s2.svc.store.events({ type: 'alert_undelivered', limit: 5 }).length, 1);
  assert.equal(s2.svc.store.db.prepare("SELECT count(*) AS n FROM kv WHERE k LIKE 'alert:%'").get()!.n, 0, 'dedupe key released after non-delivery');
});

test('no alert script → nothing is executed, event still recorded', async () => {
  const { svc, a } = setup();
  fake.tokenReplies.push({ status: 400, body: { error: 'invalid_grant' } });
  await a.refresh();
  assert.equal(svc.alerter.enabled, false);
  assert.ok(types(svc).includes('rt_dead'));
});
