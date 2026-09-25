/** Service definitions: launchd (macOS, background session) / systemd --user (Linux). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.cred-keeper';

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** PATH for the service and its scripts: node's own dir first (botmux / lark-cli are node scripts). */
export function servicePath(nodeBin: string): string {
  return [dirname(nodeBin), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

/**
 * LaunchDaemon (system domain, starts at boot without any login) running as
 * `user`. HOME/USER are set explicitly: every ~/ path in the config expands
 * from HOME, and launchd does not derive them from UserName for us.
 */
export function launchdPlist(nodeBin: string, cliPath: string, configPath: string, logDir: string,
  user: { name: string; home: string }): string {
  const args = [nodeBin, '--disable-warning=ExperimentalWarning', cliPath, 'serve', '--config', configPath]
    .map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>UserName</key><string>${xml(user.name)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xml(user.home)}</string>
    <key>USER</key><string>${xml(user.name)}</string>
    <key>PATH</key><string>${xml(servicePath(nodeBin))}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'service.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

/** systemd ExecStart word quoting: double quotes, backslash escapes, `%` → `%%` (specifiers). */
export function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function systemdUnit(nodeBin: string, cliPath: string, configPath: string): string {
  return `[Unit]
Description=cred-keeper: OAuth credential refresh and usage monitor
After=network-online.target

[Service]
ExecStart=${[nodeBin, cliPath, 'serve', '--config', configPath].map(systemdQuote).join(' ')}
Restart=always
RestartSec=30
Environment=PATH=${servicePath(nodeBin)}

[Install]
WantedBy=default.target
`;
}

/**
 * macOS: writes the LaunchDaemon plist next to the data dir and prints the sudo
 * commands to install it (this process cannot, and should not, write
 * /Library/LaunchDaemons itself). Linux: systemd --user unit + linger.
 */
export function installService(configPath: string, logDir: string, load: boolean): { path: string; next: string } {
  const nodeBin = process.execPath; // absolute: no PATH dependence (nvm)
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  if (process.platform === 'darwin') {
    const user = { name: userInfo().username, home: homedir() };
    const path = join(dirname(logDir), `${LABEL}.plist`);
    writeFileSync(path, launchdPlist(nodeBin, cliPath, configPath, logDir, user), { mode: 0o644 });
    const target = `/Library/LaunchDaemons/${LABEL}.plist`;
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
    const next = [
      'run in a terminal (needs sudo):',
      `  sudo install -o root -g wheel -m 644 ${q(path)} ${target}`,
      `  sudo launchctl bootstrap system ${target}`,
      'verify:',
      `  sudo launchctl print system/${LABEL} | head -20`,
      'uninstall:',
      `  sudo launchctl bootout system/${LABEL} && sudo rm ${target}`,
    ].join('\n');
    return { path, next };
  }
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cred-keeper.service');
  writeFileSync(path, systemdUnit(nodeBin, cliPath, configPath), { mode: 0o644 });
  if (load) {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'cred-keeper.service'], { stdio: 'inherit' });
    execFileSync('loginctl', ['enable-linger'], { stdio: 'inherit' });
  }
  return { path, next: load ? 'enabled' : 'run: systemctl --user daemon-reload && systemctl --user enable --now cred-keeper.service && loginctl enable-linger' };
}
