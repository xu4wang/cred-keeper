# cred-keeper

**English** | [简体中文](README.zh-CN.md)

Keeps the OAuth credentials of several local Claude accounts fresh, watches their usage, and exposes a **read-only** REST API. Standalone: it knows nothing about botmux or any other consumer. After a refresh it runs a per-account script, and consumers (botmux, other agent frameworks) plug in through that script.

Design doc (Chinese): the Feishu document "cred-keeper 设计：多账号凭证刷新与用量监控服务".

## Requirements

- Node.js 24+ (runs the TypeScript sources directly; uses the built-in `node:sqlite`, so there are no native modules)
- macOS or Linux

```sh
npm ci --omit=dev
./bin/cred-keeper doctor --config ~/.cred-keeper/config.json
```

## How it works

- **Vault.** Each account keeps an authoritative copy at `<dataDir>/vault/<id>.json` (0600). `credentialPath` is only the published copy that consumers read. Every minute the two are compared:
  - published file cleared, corrupt, logged out, or older than the vault → republish it from the vault
  - published file newer (for example, a human logged in again) → adopt it as the new vault
- **Refresh.** When the access token has `marginMin` minutes or less left (plus 0–5 minutes of jitter), it calls `POST /v1/oauth/token`. On HTTP 200 the raw response text is saved byte-for-byte to `<dataDir>/pending/` before parsing. Then the vault is updated, then the published file (the old one kept as `.prev`). Every write is an atomic 0600 rename with fsync of both the file and its directory. Finally the account's `onRefreshed` script runs. If the pending file cannot be written, an emergency location in a different directory is tried. If that also fails, the record is kept in memory and written again on every tick. Either way the credential itself is still applied. If the vault cannot be written, the credential is held in memory and written again every minute.
- **Pending responses are never silently discarded.** On startup and on every tick, a pending response is:
  - applied, if it was made from the current vault
  - removed, if the vault already carries its access or refresh token (so it was applied earlier)
  - otherwise kept, and the account goes `critical`, reported once per pending file. No new refresh is sent while a pending response is unresolved, because it may hold the only live refresh token. An operator resolves it with `cred-keeper pending <id> apply|discard --confirm <id>`. If the response was not made from the current vault, `apply` also requires `--replace <current-vault-fingerprint>`, and it keeps the displaced credential aside as `vault/<id>.displaced-<ts>.json`. Everything that reads or writes the vault, the pending file or the published file runs under the account lock: refresh, recovery, reconciliation, flushing, and manual resolution. `status()` is the one exception, and it only reads.
- **Outcomes:**
  - network failure → retry, alert on the second consecutive failure
  - `invalid_grant` → `dead` (a human must log in again); never retried with the same refresh token
  - error-shaped 400 → alert (likely contract drift)
  - 200 with unknown fields → `critical`, the pending response is kept
- **Usage.** Calls `GET /api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20` every `usagePollMin` minutes. Stores the 5-hour and 7-day windows and projects each window to its end linearly.
- **Locks.** One lock per account, held only while that account is refreshing. The lock records the holder's pid and process start time, so a crashed holder, or an unrelated process that later reuses the pid, is detected as stale.
- **Secrets.** Tokens never appear in argv, env, events, or API responses; only 12-hex-digit sha256 fingerprints do. Script stdout/stderr goes only to `<dataDir>/logs/scripts.log` (0600), never into the API. Before it is written there, the output is scrubbed of the account's current tokens and of anything token-shaped (`sk-ant-…`). Scrubbing is a safety net: scripts should still not print credentials.
- **One account per credential file.** The config refuses two accounts sharing a `credentialPath`.
- **Nothing overwritten without a copy.** Adopting a newer file keeps the replaced vault as `vault/<id>.displaced-*.json`; republishing over a corrupt file keeps that file as `vault/<id>.quarantine-*.json`.
- **Legacy cron lock.** An account with `legacyLockDir` (the default account during migration) also takes the old script's `mkdir` + `pid` lock for every refresh, so a cron that is still scheduled can never refresh the same RT concurrently. The service only ever takes this lock when the directory is absent. It never cleans or takes over a stale one, because that races with the script's own cleanup. A stale leftover blocks refreshing and raises `legacy_lock_stale` (at most once per hour) for a human to remove.
- **Keychain split gate (macOS).** Before refreshing, the service checks whether claude's keychain item for this credential exists (`Claude Code-credentials` for `~/.claude`, `Claude Code-credentials-<sha256(dir)[:8]>` otherwise). If it does, the service refuses to refresh and alerts, because claude would be reading the keychain instead of the file. Only existence is checked, always in the explicitly named login keychain. A LaunchDaemon may not be able to see that keychain, so at startup the service looks up a sentinel item (`cred-keeper keychain-sentinel` creates it) and reports the result as `keychainGate` in `/healthz`: `active`, or `unavailable`, in which case it also sends an alert. The gate only runs when it is `active`; it never pretends to check. This is deliberately fail-open: while the sentinel is invisible (for example right after boot, before anyone logs in), refreshes go ahead without the split check, and each attempt raises `keychain_gate_unavailable`. Failing closed would stop refreshing entirely until someone logs in, and the AT would expire. So treat a persisting `keychain_gate_unavailable` as something a human must handle.

## Configuration (`~/.cred-keeper/config.json`)

See `examples/config.json`.

| key | meaning |
|-|-|
| `listen` | Loopback only (for example `127.0.0.1:8790`); expose it through a reverse proxy |
| `network.proxy` | Optional HTTP proxy. The service does not read `*_proxy` environment variables |
| `claudeBinary` | Binary to audit; the service checks that client_id, endpoints and header are still inside it |
| `accounts[].credentialPath` | The published credential file |
| `accounts[].onRefreshed` | Script run after each refresh, see below |
| `accounts[].legacyLockDir` | Also hold the legacy cron lock (mkdir + pid) while refreshing this account |
| `alert.script` | Alert delivery script; if unset, no alerts are sent |
| `alert.minLevel` | `info` / `warn` / `error` / `critical`; default `error` |
| `alert.heartbeat` | `HH:MM` daily summary; if unset, no heartbeat |

Hot reload happens on SIGHUP or when the config file's mtime changes. It is deferred while any refresh is in flight.

## Scripts

Both kinds are executed directly (no shell), each in its own process group. The service's `PATH` is the node binary's directory followed by the system directories. botmux and lark-cli are node scripts, so the examples call them as `"$NODE" <script>`; use absolute paths in your own scripts too.

**onRefreshed:**

| item | contract |
|-|-|
| env | `CK_ACCOUNT` `CK_EVENT=refreshed` `CK_CREDENTIAL_PATH` `CK_FINGERPRINT` `CK_AT_EXPIRES_AT` `CK_RT_EXPIRES_AT`. No tokens; read the file if you need them |
| timeout | `hookTimeoutSec` (default 60) |
| retry | One retry within that timeout budget; still failing → `hook_failed` (critical) |

**alert:**

| item | contract |
|-|-|
| env | `CK_EVENT` `CK_LEVEL` `CK_ACCOUNT` `CK_TITLE` `CK_DEDUP_KEY` |
| stdin | The event as JSON |
| retry | 3 retries with backoff; after that the event is recorded as `alert_undelivered` |
| dedupe | Done by the core, not by the script |

Examples in `examples/`:

- `on-refreshed-botmux-default.sh` — seed per-bot copies and `botmux suspend all` (what the legacy cron script did). Bots with `credentialsSourceDir` in bots.json are skipped. If botmux cannot run (exit 126/127), the hook fails and `hook_failed` is raised; other non-zero exits (inactive sessions) are tolerated as before. Note: the legacy script sent a heartbeat on every run; cred-keeper sends one daily summary (`alert.heartbeat`)
- `on-refreshed-botmux-account.sh` — `botmux suspend --bot <appId>` for bots with their own account
- `alert-lark.sh` — Feishu/Lark DM through `lark-cli`

## API (GET only)

| path | |
|-|-|
| `/healthz` | liveness, accounts, whether alerts are enabled |
| `/v1/accounts`, `/v1/accounts/{id}` | state, fingerprints, AT/RT expiry, last refresh, failures, usage (+ recent events) |
| `/v1/accounts/{id}/usage`, `/v1/accounts/{id}/usage/history?since=24h` | usage snapshot / series |
| `/v1/usage` | usage for all accounts |
| `/v1/events?account=&type=&since=&limit=` | event log (exit codes and durations only, never script output) |
| `/metrics` | Prometheus text |

## CLI

```
cred-keeper serve [--config <path>]
cred-keeper status [id]
cred-keeper refresh <id> --force --confirm <id>   # rotates the RT and revokes the current AT for every consumer
cred-keeper pending <id> apply|discard --confirm <id> [--replace <vault-fp>]  # resolve a saved refresh response the service could not apply
cred-keeper doctor                                  # connectivity (expects 405), credential files, keychain split, scripts, contract, legacy cron
cred-keeper alert-test
cred-keeper keychain-sentinel                       # macOS: create the sentinel the service uses to verify its keychain view
cred-keeper install-service [--load]                # macOS: writes a LaunchDaemon plist and prints the sudo commands; Linux: systemd --user
```

## Installing as a service (macOS)

The service runs as a **LaunchDaemon** (system domain, `UserName` = you, with `HOME`, `USER` and `PATH` set explicitly). It therefore starts at boot even when nobody logs in, which a per-user LaunchAgent would not do.

```sh
cred-keeper keychain-sentinel --config …     # once, from a normal login session
cred-keeper install-service --config …       # writes <dataDir>/com.cred-keeper.plist and prints:
sudo install -o root -g wheel -m 644 <plist> /Library/LaunchDaemons/com.cred-keeper.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cred-keeper.plist
curl -s 127.0.0.1:<port>/healthz              # keychainGate should be "active"
```

To verify the keychain gate positively in the daemon's own context:

1. Create a dummy item with the account's service name, e.g. `security add-generic-password -s "Claude Code-credentials-<hash>" -a test -w x`
2. Make the account due, for example by temporarily raising its `marginMin`
3. Confirm a `keychain_split` event appears and no refresh is sent
4. Delete the dummy item and restore the config, then confirm the unsuffixed item is still absent: `security find-generic-password -s "Claude Code-credentials" ~/Library/Keychains/login.keychain-db` must exit 44

**Never create the unsuffixed `Claude Code-credentials` item for this test** on a machine whose shared account is in use: every consumer of `~/.claude` would switch to reading the keychain.

The gate is probed on the spot before every refresh (the sentinel first, then the split item), so it recovers by itself once the login keychain becomes visible, and a manual `cred-keeper refresh` goes through the same gate. `/healthz` reports the latest probe result.

## Migrating from the legacy cron (default account)

1. Pick a quiet window right after a refresh. Back up the crontab, then delete its refresh and contract-audit lines.
2. Configure the default account with `legacyLockDir` pointing at the old lock (`~/.botmux/logs/.cred-refresh.lock`). While the cron might still run, the service and the script are then mutually exclusive.
3. Once `cred-keeper doctor` confirms the cron lines are gone, **remove `legacyLockDir` from the config**. Otherwise a lock left behind by a restart during a refresh would block refreshing forever. That case does raise `legacy_lock_stale`, which escalates to critical when the AT is about to expire, but nothing would clean the lock up.

## Tests

```sh
npm test                                   # node:test, fake OAuth server, no network
CK_CLAUDE_BINARY=/path/to/claude.exe npm test   # also checks the contract strings in a real binary (read-only)
```

Only use garbage refresh tokens against the real endpoint. Refreshing a copy of a real credential *is* a real refresh: it rotates the RT and revokes the AT for every holder.
