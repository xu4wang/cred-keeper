import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseConsumers } from '../src/consumers.ts';
import { Service } from '../src/service.ts';
import { FakeAnthropic, credText, script, tmp, writeConfig } from './helpers.ts';

const fake = await new FakeAnthropic().start();
after(() => fake.stop());

test('parseConsumers: keeps only id/name, matches by absolute path, drops bad entries', () => {
  const m = parseConsumers(JSON.stringify([
    { id: 'cli_b', name: 'Bee', credentialPath: '~/accounts/x/claude/.credentials.json', larkAppSecret: 'SECRET' },
    { id: 'cli_a', credentialPath: '/abs/c.json' },
    { id: 'cli_b', name: 'dup', credentialPath: '~/accounts/x/claude/.credentials.json' },
    { id: 'bad id!', credentialPath: '/abs/c.json' },
    { id: 'cli_c', credentialPath: 'relative/path' },
    'junk', null,
  ]));
  assert.deepEqual(m.get(join(homedir(), 'accounts/x/claude/.credentials.json')), [{ id: 'cli_b', name: 'Bee' }]);
  assert.deepEqual(m.get('/abs/c.json'), [{ id: 'cli_a', name: 'cli_a' }], 'name defaults to id');
  assert.equal(m.size, 2);
  assert.ok(!JSON.stringify([...m]).includes('SECRET'), 'extra fields never pass through');
  assert.throws(() => parseConsumers('{"a":1}'), /JSON array/);
});

test('service: consumers attached per account; a failing script keeps the last good list', async () => {
  const d = tmp();
  const credPath = join(d, 'acct', '.credentials.json');
  const outFile = join(d, 'consumers.json');
  writeFileSync(outFile, JSON.stringify([{ id: 'cli_1', name: '一号', credentialPath: credPath, larkAppSecret: 'S3CRET' }]));
  const sc = script(join(d, 'h'), 'consumers.sh', `[ -f ${outFile}.fail ] && exit 3; cat ${outFile}`);
  const cfgPath = writeConfig(d, fake, { consumers: { script: sc, refreshMin: 1 } });
  writeFileSync(credPath, credText('AT', 'RT', Date.now() + 300 * 60_000), { mode: 0o600 });
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  await svc.tick();
  assert.deepEqual(svc.consumersOf(credPath), [{ id: 'cli_1', name: '一号' }]);
  assert.deepEqual(svc.consumersOf('/elsewhere'), [], 'configured but unused → empty list');
  assert.ok(svc.consumersStatus.at);
  const log = readFileSync(join(d, 'data', 'logs', 'scripts.log'), 'utf-8');
  assert.ok(!log.includes('S3CRET'), 'captured stdout is not written to the script log');

  writeFileSync(`${outFile}.fail`, '');
  await svc.refreshConsumersIfDue(true);
  assert.deepEqual(svc.consumersOf(credPath), [{ id: 'cli_1', name: '一号' }], 'last good list kept');
  assert.match(svc.consumersStatus.error ?? '', /exit 3/);
  assert.equal(svc.store.events({ type: 'consumers_failed', limit: 5 }).length, 1);
});

test('no consumers section → no consumers field, script never runs', async () => {
  const d = tmp();
  const cfgPath = writeConfig(d, fake);
  writeFileSync(join(d, 'acct', '.credentials.json'), credText('AT', 'RT', Date.now() + 300 * 60_000), { mode: 0o600 });
  const svc = new Service(cfgPath, { alertSleep: async () => {} });
  await svc.tick();
  assert.equal(svc.consumersOf(join(d, 'acct', '.credentials.json')), undefined);
});
