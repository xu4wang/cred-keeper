import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mergeTokenResponse, parseCred } from '../src/cred.ts';
import { writeFileAtomic0600, fingerprint } from '../src/util.ts';
import { tryAcquire, lockIsLive, release } from '../src/lock.ts';
import { loadConfig } from '../src/config.ts';
import { project } from '../src/oauth.ts';
import { credText, tmp } from './helpers.ts';

test('parseCred: absent / unparseable / logged out / ok', () => {
  assert.deepEqual(parseCred(null), { ok: false, reason: 'absent' });
  assert.deepEqual(parseCred('{x'), { ok: false, reason: 'unparseable' });
  assert.deepEqual(parseCred('{}'), { ok: false, reason: 'logged_out' });
  assert.deepEqual(parseCred(JSON.stringify({ claudeAiOauth: { accessToken: 'a' } })), { ok: false, reason: 'logged_out' });
  const r = parseCred(credText('AT1', 'RT1', 1000, { refreshTokenExpiresAt: 5000 }));
  assert.ok(r.ok);
  assert.equal(r.ok && r.cred.fingerprint, fingerprint('AT1'));
  assert.equal(r.ok && r.cred.refreshTokenExpiresAt, 5000);
});

test('mergeTokenResponse: rotation, keep-old rules, rejects', () => {
  const cur = parseCred(credText('AT1', 'RT1', 1000, { refreshTokenExpiresAt: 9999 })) as any;
  const now = 1_000_000;
  const rot = mergeTokenResponse(cur.cred, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, refresh_token_expires_in: 60, scope: 'a b' }, now)!;
  const o = JSON.parse(rot.text);
  assert.equal(rot.rotatedRt, true);
  assert.equal(o.claudeAiOauth.refreshToken, 'RT2');
  assert.equal(o.claudeAiOauth.expiresAt, now + 3600_000);
  assert.equal(o.claudeAiOauth.refreshTokenExpiresAt, now + 60_000);
  assert.deepEqual(o.claudeAiOauth.scopes, ['a', 'b']);
  assert.equal(o.other, 'keep');
  const keep = JSON.parse(mergeTokenResponse(cur.cred, { access_token: 'AT2', expires_in: 10 }, now)!.text);
  assert.equal(keep.claudeAiOauth.refreshToken, 'RT1', 'no refresh_token → keep old RT');
  assert.equal(keep.claudeAiOauth.refreshTokenExpiresAt, 9999, 'no refresh_token_expires_in → keep old deadline');
  assert.deepEqual(keep.claudeAiOauth.scopes, ['user:inference'], 'no scope → keep old scopes');
  assert.equal(mergeTokenResponse(cur.cred, { expires_in: 10 }, now), null);
  assert.equal(mergeTokenResponse(cur.cred, { access_token: 'AT2' }, now), null);
  assert.equal(mergeTokenResponse(cur.cred, { access_token: 'AT1', expires_in: 10 }, now), null, 'unchanged AT is rejected');
});

test('writeFileAtomic0600: replaces a symlink instead of writing through it, forces 0600, refuses symlinked parent, no temp leftovers', () => {
  const d = tmp();
  const victim = join(d, 'victim');
  writeFileSync(victim, 'untouched');
  symlinkSync(victim, join(d, 'dst'));
  writeFileAtomic0600(join(d, 'dst'), 'secret');
  assert.equal(readFileSync(victim, 'utf-8'), 'untouched');
  assert.equal(lstatSync(join(d, 'dst')).isSymbolicLink(), false);
  writeFileSync(join(d, 'loose'), 'x');
  chmodSync(join(d, 'loose'), 0o644);
  writeFileAtomic0600(join(d, 'loose'), 'y');
  assert.equal(lstatSync(join(d, 'loose')).mode & 0o777, 0o600);
  symlinkSync(d, join(d, 'linkdir'));
  assert.throws(() => writeFileAtomic0600(join(d, 'linkdir', 'f'), 's'), /not a real directory/);
  // Refused before anything is created through the symlink: with the target
  // unwritable, a late check would surface EACCES from the temp-file open instead.
  const ro = join(d, 'ro');
  mkdirSync(ro);
  symlinkSync(ro, join(d, 'rolink'));
  chmodSync(ro, 0o500);
  try {
    assert.throws(() => writeFileAtomic0600(join(d, 'rolink', 'f'), 's'), /not a real directory/);
  } finally {
    chmodSync(ro, 0o700);
  }
  assert.deepEqual(readdirSync(d).filter((n) => n.includes('.tmp-')), []);
});

test('lock: exclusive while live; stale when pid dead or pid reused', () => {
  const d = tmp();
  const p = join(d, 'l.lock');
  const probe = () => 'start-A';
  assert.equal(tryAcquire(p, probe), true);
  assert.equal(tryAcquire(p, probe), false, 'second acquire while we hold it');
  assert.equal(lockIsLive(p, probe), true);
  assert.equal(lockIsLive(p, () => 'start-B'), false, 'same pid, different start time = reused pid');
  assert.equal(tryAcquire(p, () => 'start-B'), true, 'reused-pid lock is reclaimed');
  release(p);
  assert.equal(existsSync(p), false);
  writeFileSync(p, JSON.stringify({ pid: 999_999, start: 'x' }));
  assert.equal(lockIsLive(p, () => 'x'), false, 'dead pid is stale even if the start time would match');
  assert.equal(tryAcquire(p, probe), true, 'dead holder is reclaimed');
  release(p);
  writeFileSync(p, 'garbage');
  assert.equal(tryAcquire(p, probe), true, 'garbage lock is reclaimed');
  release(p);
});

test('config: loopback only, id format, alert level', () => {
  const d = tmp();
  const w = (o: unknown) => { writeFileSync(join(d, 'c.json'), JSON.stringify(o)); return join(d, 'c.json'); };
  assert.throws(() => loadConfig(w({ listen: '0.0.0.0:1', accounts: [] })), /loopback/);
  assert.throws(() => loadConfig(w({ accounts: [{ id: 'Bad Id', credentialPath: '/x' }] })), /id must match/);
  assert.throws(() => loadConfig(w({ accounts: [{ id: 'a', credentialPath: 'rel' }] })), /absolute/);
  assert.throws(() => loadConfig(w({ accounts: [], alert: { script: '/x', minLevel: 'loud' } })), /minLevel/);
  const c = loadConfig(w({ accounts: [{ id: 'a', credentialPath: '/x' }], alert: { script: '/s' } }));
  assert.equal(c.alert?.minLevel, 'error', 'default alert level is error');
  assert.equal(c.accounts[0].marginMin, 120);
});

test('project: linear extrapolation, undefined early in the window', () => {
  const len = 5 * 3600_000;
  const end = 10 * 3600_000;
  assert.equal(project({ utilization: 50, resetsAt: new Date(end).toISOString(), locked: null }, len, end - len / 2), 100);
  assert.equal(project({ utilization: 1, resetsAt: new Date(end).toISOString(), locked: null }, len, end - len + 60_000), null);
  assert.equal(project({ utilization: null, resetsAt: new Date(end).toISOString(), locked: null }, len, end - len / 2), null);
});
