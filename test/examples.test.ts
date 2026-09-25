import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.ts';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'on-refreshed-botmux-default.sh');
const NODE_DIR = dirname(process.execPath);

function fakeHome(fakeCliBody: string) {
  const home = tmp();
  for (const app of ['cli_shared', 'cli_own']) {
    mkdirSync(join(home, '.botmux', 'bots', app, 'claude'), { recursive: true });
    writeFileSync(join(home, '.botmux', 'bots', app, 'claude', '.credentials.json'), `OLD-${app}`);
  }
  writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([
    { larkAppId: 'cli_shared' },
    { larkAppId: 'cli_own', credentialsSourceDir: '~/accounts/b' },
  ]));
  writeFileSync(join(home, 'new.json'), 'NEW-CRED');
  const cli = join(home, 'fake-botmux.js');
  writeFileSync(cli, fakeCliBody);
  return { home, cli };
}

function run(home: string, env: Record<string, string>) {
  // The same minimal PATH a LaunchDaemon gives the service: node's dir + system dirs.
  return spawnSync('/bin/bash', [HOOK], {
    encoding: 'utf-8',
    env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, CK_CREDENTIAL_PATH: join(home, 'new.json'), ...env },
  });
}

test('default hook: seeds shared bots, never a bot with its own account, then suspends', () => {
  const { home, cli } = fakeHome(`require('fs').writeFileSync(${JSON.stringify(join('/', 'dev', 'null'))}, ''); require('fs').appendFileSync(process.env.HOME + '/calls', process.argv.slice(2).join(' ') + '\\n');`);
  const r = run(home, { BOTMUX_CLI: cli });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, '.botmux/bots/cli_shared/claude/.credentials.json'), 'utf-8'), 'NEW-CRED');
  assert.equal(readFileSync(join(home, '.botmux/bots/cli_own/claude/.credentials.json'), 'utf-8'), 'OLD-cli_own', 'own-account bot untouched');
  assert.equal(readFileSync(join(home, 'calls'), 'utf-8').trim(), 'suspend all');
});

test('default hook: botmux that cannot run fails the hook (no silent success)', () => {
  const { home } = fakeHome('');
  const missing = run(home, { BOTMUX_CLI: join(home, 'nope.js') });
  assert.equal(missing.status, 127);
  const { home: h2, cli } = fakeHome('process.exit(127)');
  const r = run(h2, { BOTMUX_CLI: cli });
  assert.equal(r.status, 127, 'rc 126/127 from botmux is propagated');
  const { home: h3, cli: c3 } = fakeHome('process.exit(1)');
  assert.equal(run(h3, { BOTMUX_CLI: c3 }).status, 0, 'other non-zero (inactive sessions) is tolerated, as before');
});

test('default hook: no node on PATH → fails loudly', () => {
  const { home, cli } = fakeHome('');
  const r = spawnSync('/bin/bash', [HOOK], {
    encoding: 'utf-8',
    env: { HOME: home, PATH: '/usr/bin:/bin', CK_CREDENTIAL_PATH: join(home, 'new.json'), BOTMUX_CLI: cli },
  });
  assert.notEqual(r.status, 0);
});

test('default hook: unreadable bots.json → refuses to seed', () => {
  const { home, cli } = fakeHome('');
  writeFileSync(join(home, '.botmux', 'bots.json'), '{broken');
  const r = run(home, { BOTMUX_CLI: cli });
  assert.equal(r.status, 3);
  assert.equal(readFileSync(join(home, '.botmux/bots/cli_shared/claude/.credentials.json'), 'utf-8'), 'OLD-cli_shared');
});
