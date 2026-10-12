import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Service } from '../src/service.ts';
import { FakeAnthropic, credText, script, tmp, writeConfig } from './helpers.ts';

const fake = await new FakeAnthropic().start();
after(() => fake.stop());
const MIN = 60_000;

/**
 * An account with a preRefresh gate. The gate appends one line per run to
 * `<d>/gate.log` (its env) and exits with the code stored in `<d>/gate.rc`.
 */
function setup(expInMin: number, gate: { rc?: number; body?: string; extra?: Record<string, unknown> } = {}) {
  const d = tmp();
  writeFileSync(join(d, 'gate.rc'), String(gate.rc ?? 75));
  const gatePath = script(join(d, 'hooks'), 'pre.sh', gate.body ??
    `echo "$CK_EVENT $CK_ACCOUNT $CK_AT_LEFT_MIN $CK_CREDENTIAL_PATH" >> "${d}/gate.log"; exit "$(cat "${d}/gate.rc")"`);
  const credPath = join(d, 'acct', '.credentials.json');
  const cfgPath = writeConfig(d, fake, {
    accounts: [{ id: 'a1', credentialPath: credPath, preRefresh: gatePath, ...(gate.extra ?? {}) }],
  });
  writeFileSync(credPath, credText('AT-OLD', 'RT-OLD', Date.now() + expInMin * MIN), { mode: 0o600 });
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  const a = svc.accounts.get('a1')!;
  a.jitterMs = 0;
  a.gateProbe = () => 'not-applicable';
  const gateRuns = () => (existsSync(join(d, 'gate.log')) ? readFileSync(join(d, 'gate.log'), 'utf-8').trim().split('\n') : []);
  const setRc = (rc: number) => writeFileSync(join(d, 'gate.rc'), String(rc));
  const events = (type: string) => svc.store.events({ type, limit: 50 });
  return { d, svc, a, credPath, gateRuns, setRc, events };
}

const refreshReply = () => fake.tokenReplies.push({ status: 200, body: { access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_in: 28800 } });

test('busy gate defers a due refresh; the episode is reported once; idle then refreshes', async () => {
  const { svc, a, credPath, gateRuns, setRc, events } = setup(100);
  const n = fake.tokenRequests.length;
  await svc.tick();
  await svc.tick();
  assert.equal(fake.tokenRequests.length, n, 'busy → no token request');
  assert.equal(gateRuns().length, 2, 'gate is asked on every tick while due');
  assert.match(gateRuns()[0], /^pre_refresh a1 (99|100) /, 'gate env: event, account, AT minutes left');
  assert.ok(gateRuns()[0].endsWith(credPath));
  assert.equal(events('refresh_deferred').length, 1, 'one event per deferral episode, not per tick');
  assert.ok(a.status().refreshDeferredSince, 'status shows the deferral');
  assert.match(readFileSync(credPath, 'utf-8'), /AT-OLD/);

  setRc(0);
  refreshReply();
  await svc.tick();
  assert.equal(fake.tokenRequests.length, n + 1, 'idle → refreshed');
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  const ended = events('refresh_defer_ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.reason, 'idle');
  assert.equal(a.deferredSince, null);
  assert.equal(a.status().refreshDeferredSince, null);
});

test('within redMin the gate is not asked and the refresh goes ahead', async () => {
  const { svc, gateRuns, credPath, events } = setup(20); // redMin defaults to 30
  refreshReply();
  await svc.tick();
  assert.equal(gateRuns().length, 0, 'gate not run inside the floor');
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  assert.equal(events('refresh_deferred').length, 0);
});

test('a deferral never outlasts preRefreshMaxDeferMin', async () => {
  const { svc, a, credPath, events } = setup(100, { extra: { preRefreshMaxDeferMin: 15 } });
  await svc.tick();
  assert.ok(a.deferredSince !== null, 'deferred first');
  a.deferredSince = Date.now() - 16 * MIN; // pretend the episode began 16 minutes ago
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/, 'refreshed although the gate still says busy');
  const ended = events('refresh_defer_ended');
  assert.equal(ended.at(-1)!.data.reason, 'max_defer');
  assert.equal(ended.at(-1)!.level, 'warn');
});

test('a failing gate (other exit code) does not block the refresh and is reported', async () => {
  const { svc, credPath, events } = setup(100, { rc: 3 });
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  assert.equal(events('pre_refresh_failed').length, 1);
  assert.equal(events('refresh_deferred').length, 0);
});

test('a gate that times out does not block the refresh', async () => {
  const { svc, credPath, events } = setup(100, { body: 'sleep 30; exit 75', extra: { preRefreshTimeoutSec: 1 } });
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  const f = events('pre_refresh_failed');
  assert.equal(f.length, 1);
  assert.equal(f[0].data.timedOut, true);
});

test('not due: the gate is not run, and an open deferral is closed as not_due', async () => {
  const { svc, a, gateRuns, credPath, events } = setup(100);
  await svc.tick();
  assert.equal(gateRuns().length, 1);
  // Someone else (a login) moved the credential on: no longer due.
  writeFileSync(credPath, credText('AT-LOGIN', 'RT-LOGIN', Date.now() + 8 * 60 * MIN), { mode: 0o600 });
  await svc.tick();
  assert.equal(gateRuns().length, 1, 'gate not asked when nothing is due');
  assert.equal(a.deferredSince, null);
  assert.equal(events('refresh_defer_ended').at(-1)!.data.reason, 'not_due');
});

test('a forced CLI refresh ignores the gate', async () => {
  const { a, gateRuns, credPath } = setup(100);
  refreshReply();
  assert.equal(await a.refresh(true), 'refreshed');
  assert.equal(gateRuns().length, 0);
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
});

test('a slow gate cannot carry "busy" across the floor (limits are rechecked after it returns)', async () => {
  // 30 min + 2 s left, redMin 30: the gate starts outside the floor and returns inside it.
  const { svc, credPath, events } = setup(30 + 2 / 60, { body: 'sleep 3; exit 75' });
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  assert.equal(events('refresh_deferred').length, 0);
});

test('a slow gate cannot carry "busy" past preRefreshMaxDeferMin', async () => {
  const { svc, a, d, credPath, events } = setup(100, { extra: { preRefreshMaxDeferMin: 1 } });
  await svc.tick();
  a.deferredSince = Date.now() - 60_000 + 1500; // budget ends 1.5 s from now
  writeFileSync(join(d, 'hooks', 'pre.sh'), '#!/bin/bash\nsleep 3; exit 75\n');
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  assert.equal(events('refresh_defer_ended').at(-1)!.data.reason, 'max_defer');
});

test('preRefreshMaxDeferMin = 0 means no gate at all', async () => {
  const { svc, gateRuns, credPath } = setup(100, { extra: { preRefreshMaxDeferMin: 0 } });
  refreshReply();
  await svc.tick();
  assert.equal(gateRuns().length, 0);
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
});

test('removing preRefresh (hot reload) closes the open episode, then refreshes', async () => {
  const { svc, a, credPath, events } = setup(100);
  await svc.tick();
  assert.ok(a.deferredSince !== null);
  a.cfg.preRefresh = undefined; // what a hot reload does in place
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  assert.equal(a.deferredSince, null);
  assert.equal(events('refresh_defer_ended').at(-1)!.data.reason, 'gate_removed');
});

test('a critical account closes the episode as critical, not as not_due', async () => {
  const { svc, a, events } = setup(100);
  await svc.tick();
  a.state = 'critical';
  await svc.tick();
  assert.equal(a.deferredSince, null);
  const e = events('refresh_defer_ended').at(-1)!;
  assert.equal(e.data.reason, 'critical');
  assert.equal(e.level, 'warn');
});

test('a first "busy" that took longer than the whole budget does not defer', async () => {
  // Budget 0.02 min (1.2 s), gate takes 2 s: the episode would already be over.
  const { svc, credPath, events } = setup(100, { body: 'sleep 2; exit 75', extra: { preRefreshMaxDeferMin: 0.02 } });
  refreshReply();
  await svc.tick();
  assert.match(readFileSync(credPath, 'utf-8'), /AT-NEW/);
  assert.equal(events('refresh_deferred').length, 0);
});
