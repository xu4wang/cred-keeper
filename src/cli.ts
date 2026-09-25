#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startApi } from './api.ts';
import { loadConfig, paths } from './config.ts';
import { doctor } from './doctor.ts';
import { installService } from './install.ts';
import { Service } from './service.ts';

const USAGE = `usage: cred-keeper <command> [--config <path>]
  serve                              run the service (launchd / systemd calls this)
  status [id]                        query the running service
  refresh <id> --force --confirm <id>  force a refresh (rotates the RT, revokes the old AT)
  pending <id> apply|discard --confirm <id> [--replace <vault-fp>]  resolve a saved refresh response the service could not apply
  doctor                             environment and configuration checks
  alert-test                         send a test event through the alert script
  install-service [--load]           write (and optionally load) the service definition`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  process.umask(0o077); // state.db, logs, vault: owner-only
  const cmd = process.argv[2];
  const configPath = arg('--config') ?? join(homedir(), '.cred-keeper', 'config.json');
  switch (cmd) {
    case 'serve': {
      const svc = new Service(configPath);
      await startApi(svc);
      process.on('SIGHUP', () => svc.reload());
      // Give in-flight alerts a short grace period, not their whole retry/backoff schedule.
      const stop = () => {
        svc.stop();
        void Promise.race([svc.alerter.drain(), new Promise((r) => setTimeout(r, 10_000))]).finally(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      await svc.start();
      return new Promise(() => {}); // run forever
    }
    case 'status': {
      const cfg = loadConfig(configPath);
      const id = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
      const res = await fetch(`http://${cfg.listen.host}:${cfg.listen.port}/v1/accounts${id ? '/' + id : ''}`);
      console.log(JSON.stringify(await res.json(), null, 2));
      return res.ok ? 0 : 1;
    }
    case 'refresh': {
      const id = process.argv[3];
      if (!id || !process.argv.includes('--force') || arg('--confirm') !== id) {
        console.error('refusing: a forced refresh rotates the RT and revokes the current AT for every consumer.\n'
          + `re-run as: cred-keeper refresh ${id ?? '<id>'} --force --confirm ${id ?? '<id>'}`);
        return 2;
      }
      const svc = new Service(configPath);
      const a = svc.accounts.get(id);
      if (!a) { console.error(`unknown account ${id}`); return 2; }
      const r = await a.refresh(true);
      await svc.alerter.drain();
      console.log(JSON.stringify({ result: r, status: a.status() }, null, 2));
      return r === 'refreshed' ? 0 : 1;
    }
    case 'pending': {
      const id = process.argv[3];
      const action = process.argv[4];
      if (!id || (action !== 'apply' && action !== 'discard') || arg('--confirm') !== id) {
        console.error('usage: cred-keeper pending <id> apply|discard --confirm <id>\n'
          + '  apply   — force-apply the saved refresh response onto the current credential\n'
          + '  discard — delete it (only if you are sure it holds no live refresh token)');
        return 2;
      }
      const svc = new Service(configPath);
      const a = svc.accounts.get(id);
      if (!a) { console.error(`unknown account ${id}`); return 2; }
      const r = await a.resolvePending(action, arg('--replace'));
      await svc.alerter.drain();
      if (r === 'base_mismatch') {
        const info = a.lastMismatch!;
        console.error(`the saved response was made from credential ${info.base}, but the vault now holds ${info.vault}.\n`
          + `applying it replaces ${info.vault} (kept aside as a .displaced file). To proceed, add: --replace ${info.vault}`);
        return 1;
      }
      console.log(r);
      return r === 'applied' || r === 'discarded' ? 0 : 1;
    }
    case 'doctor': {
      const checks = await doctor(loadConfig(configPath));
      for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}  ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case 'alert-test': {
      const svc = new Service(configPath);
      if (!svc.alerter.enabled) { console.error('alert.script is not configured'); return 2; }
      const id = svc.store.addEvent(null, 'alert_test', 'critical', {});
      svc.alerter.offer({ eventId: id, type: 'alert_test', level: 'critical', account: null, title: 'cred-keeper 告警通路测试',
        message: '如果收到这条消息，告警脚本工作正常', dedupKey: String(id), data: {} });
      await svc.alerter.drain();
      const failed = svc.store.events({ type: 'alert_undelivered', limit: 1 }).some((e) => e.data.forEvent === id);
      console.log(failed ? 'alert script failed; see logs/scripts.log' : 'delivered');
      return failed ? 1 : 0;
    }
    case 'install-service': {
      const cfg = loadConfig(configPath);
      const r = installService(configPath, paths(cfg).logDir, process.argv.includes('--load'));
      console.log(`${r.path}\n${r.next}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return cmd ? 2 : 0;
  }
}

main().then((code) => { if (typeof code === 'number') process.exitCode = code; }, (e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
