/** Service definitions: launchd (macOS, background session) / systemd --user (Linux). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.cred-keeper';

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchdPlist(nodeBin: string, cliPath: string, configPath: string, logDir: string): string {
  const args = [nodeBin, cliPath, 'serve', '--config', configPath].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>LimitLoadToSessionType</key><string>Background</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
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
Environment=PATH=/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

/** Writes the service definition. `load` also loads it (real side effect). */
export function installService(configPath: string, logDir: string, load: boolean): { path: string; next: string } {
  const nodeBin = process.execPath; // absolute: no PATH dependence (nvm)
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  if (process.platform === 'darwin') {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${LABEL}.plist`);
    writeFileSync(path, launchdPlist(nodeBin, cliPath, configPath, logDir), { mode: 0o644 });
    const uid = process.getuid!();
    const cmd = `launchctl bootstrap user/${uid} ${path}`;
    if (load) execFileSync('launchctl', ['bootstrap', `user/${uid}`, path], { stdio: 'inherit' });
    return { path, next: load ? 'loaded' : `run: ${cmd}` };
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
