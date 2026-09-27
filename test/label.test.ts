import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountLabel, claudeConfigFor, loginLocalPart } from '../src/label.ts';
import { loadConfig } from '../src/config.ts';
import { Service } from '../src/service.ts';
import { FakeAnthropic, credText, tmp, writeConfig } from './helpers.ts';

const claudeJson = (email: unknown) => JSON.stringify({ projects: {}, oauthAccount: { emailAddress: email, accountUuid: 'u' } });

test('claude config resolution: ~/.claude pairs with ~/.claude.json, other dirs with <dir>/.claude.json', () => {
  const home = tmp();
  assert.equal(claudeConfigFor(join(home, '.claude', '.credentials.json'), home), join(home, '.claude.json'));
  assert.equal(claudeConfigFor(join(home, 'accounts', 'a1', 'claude', '.credentials.json'), home),
    join(home, 'accounts', 'a1', 'claude', '.claude.json'));
});

test('label: local part of the logged-in e-mail; the domain never leaves', () => {
  const home = tmp();
  writeFileSync(join(home, '.claude.json'), claudeJson('nut@example.com'));
  const dir = join(home, 'accounts', 'a1', 'claude'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.claude.json'), claudeJson('young@example.com'));
  assert.deepEqual(accountLabel({ id: 'default', credentialPath: join(home, '.claude', '.credentials.json') }, home),
    { label: 'nut', labelSource: 'claude-login' });
  const r = accountLabel({ id: 'acct1', credentialPath: join(dir, '.credentials.json') }, home);
  assert.deepEqual(r, { label: 'young', labelSource: 'claude-login' });
  assert.ok(!JSON.stringify(r).includes('example.com'));
});

test('label: config override wins; missing/garbled/absent e-mail falls back to the id', () => {
  const home = tmp();
  const dir = join(home, 'x'); mkdirSync(dir);
  const cred = join(dir, '.credentials.json');
  writeFileSync(join(dir, '.claude.json'), claudeJson('someone@example.com'));
  assert.deepEqual(accountLabel({ id: 'a', label: 'ops', credentialPath: cred }, home), { label: 'ops', labelSource: 'config' });
  writeFileSync(join(dir, '.claude.json'), '{not json');
  assert.equal(loginLocalPart(cred, home), null);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
  assert.equal(loginLocalPart(cred, home), null);
  writeFileSync(join(dir, '.claude.json'), claudeJson('@example.com'));
  assert.deepEqual(accountLabel({ id: 'a', credentialPath: cred }, home), { label: 'a', labelSource: 'id' });
  assert.deepEqual(accountLabel({ id: 'b', credentialPath: join(home, 'nowhere', '.credentials.json') }, home), { label: 'b', labelSource: 'id' });
});

test('config: label must be a non-empty string', async () => {
  const fake = await new FakeAnthropic().start();
  try {
    const d = tmp();
    const bad = writeConfig(d, fake, { accounts: [{ id: 'a1', label: '  ', credentialPath: join(d, 'c', '.credentials.json') }] });
    assert.throws(() => loadConfig(bad), /label must be a non-empty string/);
    const ok = writeConfig(d, fake, { accounts: [{ id: 'a1', label: 'ops', credentialPath: join(d, 'c', '.credentials.json') }] });
    assert.equal(loadConfig(ok).accounts[0].label, 'ops');
  } finally { await fake.stop(); }
});

test('status and /v1/accounts carry label + labelSource', async () => {
  const fake = await new FakeAnthropic().start();
  try {
    const d = tmp();
    const dir = join(d, 'acct'); mkdirSync(dir, { recursive: true });
    const cred = join(dir, '.credentials.json');
    writeFileSync(cred, credText('AT', 'RT', Date.now() + 3600_000), { mode: 0o600 });
    writeFileSync(join(dir, '.claude.json'), claudeJson('young@example.com'));
    const svc = new Service(writeConfig(d, fake, { accounts: [{ id: 'acct1', credentialPath: cred }] }), { alertSleep: async () => {} });
    const s = svc.accounts.get('acct1')!.status();
    assert.equal(s.label, 'young');
    assert.equal(s.labelSource, 'claude-login');
    svc.store.db.close();
  } finally { await fake.stop(); }
});
