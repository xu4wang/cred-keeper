import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Service } from '../src/service.ts';
import { loadConfig } from '../src/config.ts';
import { newFleetKey, open, seal } from '../src/fleet/envelope.ts';
import { FakeAnthropic, credText, script, tmp, writeConfig } from './helpers.ts';
import { FakeRedis } from './fake-redis.ts';

const fake = await new FakeAnthropic().start();
const redis = await new FakeRedis().start();
after(async () => { await fake.stop(); await redis.stop(); });
const MIN = 60_000;
const ACCOUNT = { emailAddress: 'owner@example.com', accountUuid: 'u-1', organizationUuid: 'o-1' };

/** One shared fleet key + Redis password for the "machines" of a test. */
function fleetFiles() {
  redis.kv.clear();
  redis.streams.clear();
  const d = tmp();
  writeFileSync(join(d, 'fleet.key'), newFleetKey(), { mode: 0o600 });
  writeFileSync(join(d, 'redis.pass'), redis.password, { mode: 0o600 });
  return { keyFile: join(d, 'fleet.key'), redisPasswordFile: join(d, 'redis.pass') };
}

/** Producer: owns a1, publishes it as `acc`. */
function producer(files: ReturnType<typeof fleetFiles>, expInMin: number, extra: Record<string, unknown> = {}) {
  const d = tmp();
  const credPath = join(d, 'acct', '.credentials.json');
  const cfgPath = writeConfig(d, fake, {
    accounts: [{ id: 'a1', credentialPath: credPath, ...(extra.account as object ?? {}) }],
    fleet: { machine: 'prod', redis: redis.url(), ...files, publish: { a1: 'acc' }, ...(extra.fleet as object ?? {}) },
  });
  writeFileSync(credPath, credText('AT-OLD', 'RT-OLD', Date.now() + expInMin * MIN), { mode: 0o600 });
  writeFileSync(join(d, 'acct', '.claude.json'), JSON.stringify({ oauthAccount: ACCOUNT, projects: { x: 1 } }));
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  const a = svc.accounts.get('a1')!;
  a.jitterMs = 0;
  a.gateProbe = () => 'not-applicable';
  return { d, svc, a, credPath, events: (type: string) => svc.store.events({ type, limit: 50 }) };
}

/** Consumer: no local accounts, mirrors `acc`. */
function consumer(files: ReturnType<typeof fleetFiles>, mirror: Record<string, unknown> = {}, machine = 'cons') {
  const d = tmp();
  const mirrorPath = join(d, 'accounts', 'acc', 'claude', '.credentials.json');
  const cfgPath = writeConfig(d, fake, {
    accounts: [],
    fleet: { machine, redis: redis.url(), ...files, mirrors: [{ name: 'acc', credentialPath: mirrorPath, ...mirror }] },
  });
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  return { d, svc, mirrorPath, events: (type: string) => svc.store.events({ type, limit: 50 }) };
}

const refreshReply = (at = 'AT-NEW', rt = 'RT-NEW') =>
  fake.tokenReplies.push({ status: 200, body: { access_token: at, refresh_token: rt, expires_in: 28800 } });

test('single-machine mode: no fleet section → no fleet, no Redis traffic', async () => {
  const d = tmp();
  const cfgPath = writeConfig(d, fake);
  writeFileSync(join(d, 'acct', '.credentials.json'), credText('AT-S', 'RT-S', Date.now() + 300 * MIN), { mode: 0o600 });
  const before = redis.connections;
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  await svc.tick();
  assert.equal(svc.fleet, null);
  assert.equal(svc.cfg.fleet, undefined);
  assert.equal(svc.accounts.get('a1')!.remoteBusy, undefined, 'no remote gate wired');
  assert.equal(redis.connections, before, 'never connects to Redis');
});

test('publish: a refresh is published sealed; a mirror receives the file byte for byte, plus oauthAccount', async () => {
  const files = fleetFiles();
  const p = producer(files, 100); // due: 100 < marginMin 120
  const hookLog = join(tmp(), 'hook.log');
  const c = consumer(files, { onUpdated: script(join(tmp(), 'h'), 'up.sh', `echo "$CK_EVENT $CK_ACCOUNT $CK_FINGERPRINT $CK_CREDENTIAL_PATH" >> ${hookLog}`) });
  mkdirSync(join(c.d, 'accounts', 'acc', 'claude'), { recursive: true });
  writeFileSync(join(c.d, 'accounts', 'acc', 'claude', '.claude.json'), JSON.stringify({ keep: 'me' }));
  refreshReply();
  await p.svc.tick();
  assert.match(readFileSync(p.credPath, 'utf-8'), /AT-NEW/, 'local refresh unchanged');
  const sealed = redis.get('ck:cred:acc')!;
  assert.ok(sealed, 'published');
  assert.ok(!sealed.includes('AT-NEW') && !sealed.includes('RT-NEW'), 'Redis only sees ciphertext');
  assert.equal(p.events('fleet_published').length, 1);
  assert.ok(redis.streams.get('ck:events')?.some(([, f]) => f.includes('acc')), 'event announced');

  await c.svc.tick();
  const vaultText = readFileSync(join(p.d, 'data', 'vault', 'a1.json'), 'utf-8');
  assert.equal(readFileSync(c.mirrorPath, 'utf-8'), vaultText, 'credential copied verbatim (schema untouched)');
  const cj = JSON.parse(readFileSync(join(c.d, 'accounts', 'acc', 'claude', '.claude.json'), 'utf-8'));
  assert.deepEqual(cj.oauthAccount, ACCOUNT, 'login identity copied');
  assert.equal(cj.keep, 'me', 'other fields of the login file kept');
  assert.equal(c.events('mirror_updated').length, 1);
  const runs = readFileSync(hookLog, 'utf-8').trim().split('\n');
  assert.equal(runs.length, 1);
  assert.match(runs[0], new RegExp(`^mirror_updated acc [0-9a-f]{12} ${c.mirrorPath}$`));

  await c.svc.tick(); // nothing new
  assert.equal(c.events('mirror_updated').length, 1, 'no rewrite, no hook rerun when unchanged');
  assert.equal(readFileSync(hookLog, 'utf-8').trim().split('\n').length, 1);
  assert.equal(c.svc.fleet!.status().mirrors[0].freshness, 'ok');
});

test('a stale or replayed publication never replaces a newer copy', async () => {
  const files = fleetFiles();
  const c = consumer(files);
  mkdirSync(join(c.d, 'accounts', 'acc', 'claude'), { recursive: true });
  const newer = credText('AT-NEWER', 'RT-N', Date.now() + 400 * MIN);
  writeFileSync(c.mirrorPath, newer, { mode: 0o600 });
  const key = Buffer.from(readFileSync(files.keyFile, 'utf-8').trim(), 'base64');
  const older = credText('AT-OLDER', 'RT-O', Date.now() + 100 * MIN);
  redis.kv.set('ck:cred:acc', { v: seal(key, 'ck:cred:acc', { name: 'acc', from: 'x', credentials: older, oauthAccount: null, fingerprint: 'f', expiresAt: 0, publishedAt: 0 }), exp: null });
  await c.svc.tick();
  assert.equal(readFileSync(c.mirrorPath, 'utf-8'), newer);
  assert.equal(c.events('mirror_updated').length, 0);
});

test('RESP parser rejects malformed lengths and unterminated bulk strings', async () => {
  const { parseReply } = await import('../src/fleet/resp.ts');
  assert.throws(() => parseReply(Buffer.from('$abc\r\nxx\r\n')), /bad integer/);
  assert.throws(() => parseReply(Buffer.from('*1.5\r\n')), /bad integer/);
  assert.throws(() => parseReply(Buffer.from('$2\r\nabXY')), /not terminated/);
  assert.equal(parseReply(Buffer.from('$5\r\nab')), null, 'incomplete → wait for more');
  assert.deepEqual(parseReply(Buffer.from('*2\r\n$1\r\na\r\n:7\r\n'))!.value, ['a', 7]);
});

test('an equal-expiry publication of a different credential does not replace the copy', async () => {
  const files = fleetFiles();
  const c = consumer(files);
  mkdirSync(join(c.d, 'accounts', 'acc', 'claude'), { recursive: true });
  const exp = Date.now() + 300 * MIN;
  const mine = credText('AT-MINE', 'RT-M', exp);
  writeFileSync(c.mirrorPath, mine, { mode: 0o600 });
  const key = Buffer.from(readFileSync(files.keyFile, 'utf-8').trim(), 'base64');
  redis.kv.set('ck:cred:acc', { v: seal(key, 'ck:cred:acc', { name: 'acc', from: 'x', credentials: credText('AT-TIE', 'RT-T', exp), oauthAccount: null }), exp: null });
  await c.svc.tick();
  assert.equal(readFileSync(c.mirrorPath, 'utf-8'), mine);
});

test('a value sealed with another key, or moved to another key name, is rejected', async () => {
  const files = fleetFiles();
  const c = consumer(files);
  const other = Buffer.from(newFleetKey(), 'base64');
  redis.kv.set('ck:cred:acc', { v: seal(other, 'ck:cred:acc', { name: 'acc', credentials: credText('X', 'Y', Date.now() + 400 * MIN) }), exp: null });
  await c.svc.tick();
  assert.equal(existsSync(c.mirrorPath), false);
  assert.equal(c.events('mirror_unreadable').length, 1);

  const key = Buffer.from(readFileSync(files.keyFile, 'utf-8').trim(), 'base64');
  const forOther = seal(key, 'ck:cred:other', { name: 'other', credentials: credText('X', 'Y', Date.now() + 400 * MIN) });
  assert.throws(() => open(key, 'ck:cred:acc', forOther), 'bound to its key name');
});

test('busy consumer defers the owner refresh; idle releases it', async () => {
  const files = fleetFiles();
  const p = producer(files, 100);
  const rcFile = join(tmp(), 'rc');
  writeFileSync(rcFile, '75');
  const c = consumer(files, { busyCheck: script(join(tmp(), 'h'), 'busy.sh', `exit "$(cat ${rcFile})"`) });
  // consumer holds a copy inside the refresh window → it reports
  mkdirSync(join(c.d, 'accounts', 'acc', 'claude'), { recursive: true });
  writeFileSync(c.mirrorPath, credText('AT-OLD', 'RT-OLD', Date.now() + 100 * MIN), { mode: 0o600 });
  // the copy must not be replaced by the producer's (same cred) — publish first so sync is a no-op
  await c.svc.tick();
  assert.ok(redis.get('ck:busy:acc:cons'), 'busy reported');
  assert.ok(!redis.get('ck:busy:acc:cons')!.includes('cons'), 'busy report sealed too');

  const n = fake.tokenRequests.length;
  await p.svc.tick();
  assert.equal(fake.tokenRequests.length, n, 'deferred while a remote bot is busy');
  const deferred = p.events('refresh_deferred');
  assert.equal(deferred.length, 1);
  assert.deepEqual(deferred[0].data.machines, ['cons']);

  writeFileSync(rcFile, '0');
  await c.svc.tick();
  assert.equal(redis.get('ck:busy:acc:cons'), null, 'idle clears the report');
  refreshReply();
  await p.svc.tick();
  assert.equal(fake.tokenRequests.length, n + 1, 'refreshed once idle');
  assert.equal(p.events('refresh_defer_ended')[0].data.reason, 'idle');
});

test('busy reports from this machine, too old, or forged are ignored', async () => {
  const files = fleetFiles();
  const p = producer(files, 100);
  const key = Buffer.from(readFileSync(files.keyFile, 'utf-8').trim(), 'base64');
  const put = (machine: string, at: number, k = key) =>
    redis.kv.set(`ck:busy:acc:${machine}`, { v: seal(k, `ck:busy:acc:${machine}`, { machine, at }), exp: null });
  put('old', Date.now() - 10 * MIN); // outlived busyTtlSec (Redis TTL lost, e.g. a restore)
  put('prod', Date.now()); // the owner itself
  put('evil', Date.now(), Buffer.from(newFleetKey(), 'base64'));
  refreshReply();
  const n = fake.tokenRequests.length;
  await p.svc.tick();
  assert.equal(fake.tokenRequests.length, n + 1);
  assert.equal(p.events('refresh_deferred').length, 0);
});

test('a copy far from its refresh window skips the busy check', async () => {
  const files = fleetFiles();
  const ran = join(tmp(), 'ran');
  const c = consumer(files, { busyCheck: script(join(tmp(), 'h'), 'busy.sh', `touch ${ran}; exit 75`) });
  mkdirSync(join(c.d, 'accounts', 'acc', 'claude'), { recursive: true });
  writeFileSync(c.mirrorPath, credText('AT', 'RT', Date.now() + 400 * MIN), { mode: 0o600 });
  await c.svc.tick();
  assert.equal(existsSync(ran), false);
  assert.equal(redis.get('ck:busy:acc:cons'), null);
});

test('Redis down: the local refresh still happens, never deferred; one unreachable event', async () => {
  const files = fleetFiles();
  const p = producer(files, 100, { fleet: { redis: 'redis://127.0.0.1:1' } }); // nothing listens on port 1
  refreshReply();
  const n = fake.tokenRequests.length;
  await p.svc.tick();
  assert.equal(fake.tokenRequests.length, n + 1);
  assert.match(readFileSync(p.credPath, 'utf-8'), /AT-NEW/);
  assert.equal(p.events('refresh_deferred').length, 0);
  assert.equal(p.events('hook_failed').length, 0);
  await p.svc.tick();
  assert.equal(p.events('fleet_unreachable').length, 1, 'hourly, not per attempt');
});

test('freshness: warn once below warnMin, error + onStale once below errorMin', async () => {
  const files = fleetFiles();
  const staleLog = join(tmp(), 'stale.log');
  const c = consumer(files, { warnMin: 45, errorMin: 20, onStale: script(join(tmp(), 'h'), 'stale.sh', `echo "$CK_EVENT" >> ${staleLog}`) });
  mkdirSync(join(c.d, 'accounts', 'acc', 'claude'), { recursive: true });
  writeFileSync(c.mirrorPath, credText('AT-S', 'RT-S', Date.now() + 40 * MIN), { mode: 0o600 });
  await c.svc.tick();
  await c.svc.tick();
  assert.equal(c.events('mirror_stale').length, 1);
  assert.equal(c.events('mirror_expiring').length, 0);
  assert.equal(c.svc.fleet!.status().mirrors[0].freshness, 'warn');
  writeFileSync(c.mirrorPath, credText('AT-S', 'RT-S', Date.now() + 10 * MIN), { mode: 0o600 });
  await c.svc.tick();
  await c.svc.tick();
  for (let i = 0; i < 60 && !existsSync(staleLog); i++) await new Promise((r) => setTimeout(r, 50)); // onStale runs in the background
  assert.equal(c.events('mirror_expiring').length, 1);
  assert.equal(readFileSync(staleLog, 'utf-8').trim(), 'mirror_stale');
});

test('the event stream delivers a refresh to a running consumer without waiting for its tick', async () => {
  const files = fleetFiles();
  const p = producer(files, 100);
  const c = consumer(files);
  c.svc.fleet = null;
  await c.svc.ensureFleet();
  c.svc.fleet!.start();
  await new Promise((r) => setTimeout(r, 200)); // listener connected and blocking
  refreshReply('AT-STREAM', 'RT-STREAM');
  await p.svc.tick();
  for (let i = 0; i < 40 && !existsSync(c.mirrorPath); i++) await new Promise((r) => setTimeout(r, 50));
  c.svc.fleet!.stop();
  assert.match(readFileSync(c.mirrorPath, 'utf-8'), /AT-STREAM/);
});

test('republish after the cache lost the value (Redis restarted empty)', async () => {
  const files = fleetFiles();
  const p = producer(files, 300, { fleet: { republishMin: 1 } });
  let now = Date.now();
  await p.svc.tick();
  assert.ok(redis.get('ck:cred:acc'), 'initial publish of a not-due account');
  redis.kv.delete('ck:cred:acc');
  await p.svc.tick();
  assert.equal(redis.get('ck:cred:acc'), null, 'not before republishMin');
  now += 2 * MIN;
  const f = p.svc.fleet!;
  (f as unknown as { now: () => number }).now = () => now;
  await p.svc.tick();
  assert.ok(redis.get('ck:cred:acc'), 'refilled after republishMin');
});

test('config validation', () => {
  const d = tmp();
  const base = (fleet: Record<string, unknown>, accounts: unknown[] = [{ id: 'a1', credentialPath: join(d, 'c.json') }]) => {
    const p = join(d, `cfg-${Math.random()}.json`);
    writeFileSync(p, JSON.stringify({ accounts, fleet: { machine: 'm', redis: 'redis://h:6379', ...fleet } }));
    return () => loadConfig(p);
  };
  assert.throws(base({ publish: { nope: 'x' } }), /no such local account/);
  assert.throws(base({ publish: { a1: 'x' }, mirrors: [{ name: 'x' }] }), /used twice/);
  assert.throws(base({ mirrors: [{ name: 'y', credentialPath: join(homedir(), '.claude', '.credentials.json') }] }), /must not be in ~\/.claude/);
  assert.throws(base({ mirrors: [{ name: 'y', credentialPath: join(d, 'c.json') }] }), /local account's credentialPath/);
  assert.throws(base({ mirrors: [{ name: 'y', warnMin: 10, errorMin: 20 }] }), /errorMin must be below warnMin/);
  assert.throws(base({ redis: 'http://h' }), /redis:\/\//);
  const ok = base({ publish: { a1: 'x' }, mirrors: [{ name: 'y' }] })();
  assert.equal(ok.fleet!.mirrors[0].credentialPath, join(homedir(), 'accounts', 'y', 'claude', '.credentials.json'));
  assert.equal(ok.fleet!.republishMin, 5);
});

test('localCopy: own published account is copied to <dir>/<name> from the vault, updated after a refresh, hook runs', async () => {
  const files = fleetFiles();
  const dir = tmp();
  const hookLog = join(tmp(), 'lc.log');
  const hook = script(join(tmp(), 'h'), 'lc.sh', `echo "$CK_EVENT $CK_ACCOUNT $CK_FINGERPRINT" >> ${hookLog}`);
  const p = producer(files, 300, { fleet: { localCopy: { dir, onUpdated: hook } } });
  await p.svc.tick();
  const copy = join(dir, 'acc', 'claude', '.credentials.json');
  const vault = () => readFileSync(join(p.d, 'data', 'vault', 'a1.json'), 'utf-8');
  assert.equal(readFileSync(copy, 'utf-8'), vault(), 'verbatim copy of the vault');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'acc', 'claude', '.claude.json'), 'utf-8')).oauthAccount, ACCOUNT);
  assert.equal(readFileSync(hookLog, 'utf-8').trim().split('\n').length, 1);
  const st = p.svc.fleet!.status().mirrors.find((m) => m.local);
  assert.equal(st?.name, 'acc');

  // a refresh rewrites the copy right away (onApplied), and the hook runs again
  const a = p.a;
  (a.cfg as { marginMin: number }).marginMin = 400; // due now
  refreshReply('AT-LC', 'RT-LC');
  await p.svc.tick();
  for (let i = 0; i < 40 && !readFileSync(copy, 'utf-8').includes('AT-LC'); i++) await new Promise((r) => setTimeout(r, 25));
  assert.match(readFileSync(copy, 'utf-8'), /AT-LC/);
  assert.equal(readFileSync(copy, 'utf-8'), vault());
  assert.equal(readFileSync(hookLog, 'utf-8').trim().split('\n').length, 2);
});

test('localCopy busyCheck defers the owner refresh even when Redis is down', async () => {
  const files = fleetFiles();
  const dir = tmp();
  const busy = script(join(tmp(), 'h'), 'busy.sh', 'exit 75');
  const p = producer(files, 100, { fleet: { redis: 'redis://127.0.0.1:1', localCopy: { dir, busyCheck: busy } } });
  const n = fake.tokenRequests.length;
  await p.svc.tick();
  assert.equal(fake.tokenRequests.length, n, 'deferred by a local copy consumer');
  assert.deepEqual(p.events('refresh_deferred')[0].data.machines, ['prod']);
});

test('localCopy config: may not land on the account\'s own credential file', () => {
  const d = tmp();
  const p = join(d, 'cfg.json');
  writeFileSync(p, JSON.stringify({ accounts: [{ id: 'a1', credentialPath: join(d, 'acc', 'claude', '.credentials.json') }],
    fleet: { machine: 'm', redis: 'redis://h:6379', publish: { a1: 'acc' }, localCopy: { dir: d } } }));
  assert.throws(() => loadConfig(p), /own credentialPath/);
});
