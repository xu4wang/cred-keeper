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
  assert.equal(readFileSync(join(home, 'calls'), 'utf-8').trim(), 'suspend --bot cli_shared',
    'with an own-account bot present, only the shared-account bots are suspended');
});

test('default hook: no bot has its own account → suspend all (also covers bots missing from bots.json)', () => {
  const { home, cli } = fakeHome(`require('fs').appendFileSync(process.env.HOME + '/calls', process.argv.slice(2).join(' ') + '\\n');`);
  writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([{ larkAppId: 'cli_shared' }, { larkAppId: 'cli_own' }]));
  const r = run(home, { BOTMUX_CLI: cli });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, 'calls'), 'utf-8').trim(), 'suspend all');
  assert.equal(readFileSync(join(home, '.botmux/bots/cli_own/claude/.credentials.json'), 'utf-8'), 'NEW-CRED');
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

test('default hook: finds botmux from the exec line of ~/.botmux/bin/botmux when BOTMUX_CLI is unset', () => {
  const { home, cli } = fakeHome(`require('fs').appendFileSync(process.env.HOME + '/calls', process.argv.slice(2).join(' ') + '\\n');`);
  mkdirSync(join(home, '.botmux', 'bin'), { recursive: true });
  writeFileSync(join(home, '.botmux', 'bin', 'botmux'), `#!/bin/sh\nexec node "${cli}" "$@"\n`);
  const r = run(home, {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, 'calls'), 'utf-8').trim(), 'suspend --bot cli_shared');
  // Newer botmux writes the node path quoted too: exec "/abs/node" "/abs/dist/cli.js" "$@"
  writeFileSync(join(home, 'calls'), '');
  writeFileSync(join(home, '.botmux', 'bin', 'botmux'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  const r2 = run(home, {});
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(home, 'calls'), 'utf-8').trim(), 'suspend --bot cli_shared');
  const { home: bare } = fakeHome('');
  assert.equal(run(bare, {}).status, 127, 'no wrapper and no BOTMUX_CLI → fails loudly');
});

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'pre-refresh-botmux.sh');

function runGate(fakeCliBody: string, bots?: string) {
  const home = tmp();
  const cli = join(home, 'fake-botmux.js');
  writeFileSync(cli, fakeCliBody);
  let gate = GATE;
  if (bots !== undefined) {
    gate = join(home, 'gate.sh');
    writeFileSync(gate, readFileSync(GATE, 'utf-8').replace(/^BOTS=\(\)/m, `BOTS=(${bots})`));
  }
  return { home, r: spawnSync('/bin/bash', [gate], {
    encoding: 'utf-8',
    env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, BOTMUX_CLI: cli },
  }) };
}

const DRY = (lines: string[]) => `require('fs').appendFileSync(process.env.HOME + '/calls', process.argv.slice(2).join(' ') + '\\n'); console.log(${JSON.stringify(lines.join('\n'))});`;

test('pre-refresh gate: a queued (in-turn) session → 75; only skips/suspends → 0; read-only dry-run', () => {
  const busy = runGate(DRY(['· 将跳过（本就无存活 CLI）: aaaa1111  x', '· 将排队（正在回复，完成后自动挂起）: bbbb2222  y']));
  assert.equal(busy.r.status, 75, busy.r.stderr);
  assert.equal(readFileSync(join(busy.home, 'calls'), 'utf-8').trim(), 'suspend all --dry-run', 'empty BOTS → whole host, and always --dry-run');
  const idle = runGate(DRY(['· 将跳过（本就无存活 CLI）: aaaa1111  x', '· 将挂起: cccc3333  z']));
  assert.equal(idle.r.status, 0, idle.r.stderr);
});

test('pre-refresh gate: per-bot list checks each bot; busy in any one → 75', () => {
  const body = `const a=process.argv.slice(2); require('fs').appendFileSync(process.env.HOME + '/calls', a.join(' ') + '\\n'); console.log(a[2]==='cli_b' ? '· 将排队（正在回复，完成后自动挂起）: x' : '· 将挂起: y');`;
  const { home, r } = runGate(body, 'cli_a cli_b');
  assert.equal(r.status, 75, r.stderr);
  assert.equal(readFileSync(join(home, 'calls'), 'utf-8').trim(), 'suspend --bot cli_a --dry-run\nsuspend --bot cli_b --dry-run');
});

test('pre-refresh gate: botmux that cannot answer is a gate failure, never "idle"', () => {
  const down = runGate(`console.error('daemon not running'); process.exit(1)`);
  const partial = runGate(`console.log('· 将挂起: x'); process.exit(2)`); // looks like a dry-run, but failed
  assert.equal(partial.r.status, 1, 'non-zero dry-run is a failure even with session lines');
  assert.notEqual(down.r.status, 0);
  assert.notEqual(down.r.status, 75);
  const home = tmp();
  const missing = spawnSync('/bin/bash', [GATE], { encoding: 'utf-8', env: { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, BOTMUX_CLI: join(home, 'nope.js') } });
  assert.equal(missing.status, 127);
});
