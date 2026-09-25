# cred-keeper

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
- **Refresh.** When the access token has `marginMin` minutes or less left (plus 0–5 minutes of jitter), it calls `POST /v1/oauth/token`. On HTTP 200 the raw response text is saved byte-for-byte to `<dataDir>/pending/` before parsing. Then the vault is updated, then the published file (the old one kept as `.prev`). Every write is an atomic 0600 rename with fsync of both the file and its directory. Finally the account's `onRefreshed` script runs. If the pending file cannot be written, the credential is still applied. If the vault cannot be written, the credential is held in memory and written again every minute.
- **Pending responses are never silently discarded.** On startup and on every tick, a pending response is:
  - applied, if it was made from the current vault
  - removed, if the vault already carries its access token, or holds a credential that expires later than the response would
  - otherwise kept, and the account goes `critical`. No new refresh is sent while a pending response is unresolved, because it may hold the only live refresh token.
- **Outcomes:**
  - network failure → retry, alert on the second consecutive failure
  - `invalid_grant` → `dead` (a human must log in again); never retried with the same refresh token
  - error-shaped 400 → alert (likely contract drift)
  - 200 with unknown fields → `critical`, the pending response is kept
- **Usage.** Calls `GET /api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20` every `usagePollMin` minutes. Stores the 5-hour and 7-day windows and projects each window to its end linearly.
- **Locks.** One lock per account, held only while that account is refreshing. The lock records the holder's pid and process start time, so a crashed holder, or an unrelated process that later reuses the pid, is detected as stale.
- **Secrets.** Tokens never appear in argv, env, events, or API responses; only 12-hex-digit sha256 fingerprints do. Script stdout/stderr goes only to `<dataDir>/logs/scripts.log` (0600), never into the API. Before it is written there, the output is scrubbed of the account's current tokens and of anything token-shaped (`sk-ant-…`). Scrubbing is a safety net: scripts should still not print credentials.
- **One account per credential file.** The config refuses two accounts sharing a `credentialPath`.

## Configuration (`~/.cred-keeper/config.json`)

See `examples/config.json`.

| key | meaning |
|-|-|
| `listen` | Loopback only (for example `127.0.0.1:8790`); expose it through a reverse proxy |
| `network.proxy` | Optional HTTP proxy. The service does not read `*_proxy` environment variables |
| `claudeBinary` | Binary to audit; the service checks that client_id, endpoints and header are still inside it |
| `accounts[].credentialPath` | The published credential file |
| `accounts[].onRefreshed` | Script run after each refresh, see below |
| `alert.script` | Alert delivery script; if unset, no alerts are sent |
| `alert.minLevel` | `info` / `warn` / `error` / `critical`; default `error` |
| `alert.heartbeat` | `HH:MM` daily summary; if unset, no heartbeat |

Hot reload happens on SIGHUP or when the config file's mtime changes. It is deferred while any refresh is in flight.

## Scripts

Both kinds are executed directly (no shell), each in its own process group, with a minimal `PATH`. Use absolute paths inside scripts.

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

- `on-refreshed-botmux-default.sh` — seed per-bot copies and `botmux suspend all` (what the legacy cron script did)
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
cred-keeper doctor                                  # connectivity (expects 405), credential files, keychain split, scripts, contract, legacy cron
cred-keeper alert-test
cred-keeper install-service [--load]                # launchd (Background session) / systemd --user
```

## Tests

```sh
npm test                                   # node:test, fake OAuth server, no network
CK_CLAUDE_BINARY=/path/to/claude.exe npm test   # also checks the contract strings in a real binary (read-only)
```

Only use garbage refresh tokens against the real endpoint. Refreshing a copy of a real credential *is* a real refresh: it rotates the RT and revokes the AT for every holder.
