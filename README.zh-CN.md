# cred-keeper

[English](README.md) | **简体中文**

让本机多个 Claude 账号的 OAuth 凭证保持有效，监控各账号的用量，并对外提供**只读**的 REST 接口。它独立运行，不认识 botmux 或任何其他消费者。每次刷新后会执行该账号配置的脚本，消费者（botmux、其他 agent 框架）就通过这个脚本接入。

设计文档：飞书文档《cred-keeper 设计：多账号凭证刷新与用量监控服务》。

## 运行要求

- Node.js 24 及以上。直接运行 TypeScript 源码，使用内置的 `node:sqlite`，没有原生模块
- macOS 或 Linux

```sh
npm ci --omit=dev
./bin/cred-keeper doctor --config ~/.cred-keeper/config.json
```

## 工作原理

- **权威副本（vault）。** 每个账号在 `<dataDir>/vault/<id>.json`（0600）保存一份权威副本；`credentialPath` 只是发布出去、供消费者读取的那一份。两者每分钟比对一次：
  - 发布的文件被清空、损坏、处于登出状态，或者比副本旧 → 从副本重新发布
  - 发布的文件比副本新（例如有人重新登录了）→ 收编为新的副本
- **刷新。** access token 剩余时间不超过 `marginMin` 分钟时（再加 0–5 分钟随机抖动），调用 `POST /v1/oauth/token`。收到 HTTP 200 后，先把原始响应文本原样保存到 `<dataDir>/pending/`，然后再解析。接着先更新副本，再更新发布的文件（旧文件保留为 `.prev`）。所有写入都是 0600 原子 rename，并对文件和所在目录做 fsync。最后执行该账号的 `onRefreshed` 脚本。
  - pending 文件写不进去时，改写另一个目录里的应急位置；应急位置也失败，就保留在内存里，每个周期重试写入。无论哪种情况，新凭证本身照常应用
  - 副本写不进去时，新凭证保留在内存里，每分钟重试写入
- **pending 响应绝不会被静默丢弃。** 服务启动时和每个周期都会检查 pending 响应：
  - 如果它是基于当前副本发出的 → 应用
  - 如果副本里已经带有它的 access token 或 refresh token（说明之前已经应用过）→ 删除
  - 否则保留，账号进入 `critical` 状态，同一份 pending 只报告一次。pending 未解决期间不会发起新的刷新，因为它可能持有唯一一个仍有效的 refresh token

  人工处理用 `cred-keeper pending <id> apply|discard --confirm <id>`。如果这个响应不是基于当前副本发出的，`apply` 还必须加上 `--replace <当前副本指纹>`，被替换下来的凭证会另存为 `vault/<id>.displaced-<ts>.json`。

  所有读写副本、pending 文件或发布文件的操作都在账号锁内执行，包括刷新、恢复、对账、补写和人工处理。唯一的例外是 `status()`，它只读不写。
- **刷新结果：**
  - 网络失败 → 重试，连续第 2 次失败时告警
  - `invalid_grant` → 进入 `dead`，需要人工重新登录；绝不会用同一个 refresh token 重试
  - 错误格式的 400 → 告警（很可能是接口契约变了）
  - 返回 200 但字段不认识 → 进入 `critical`，保留 pending 响应
- **用量。** 每 `usagePollMin` 分钟调用一次 `GET /api/oauth/usage`，带请求头 `anthropic-beta: oauth-2025-04-20`。保存 5 小时和 7 天两个窗口的数据，并线性外推出每个窗口结束时的用量。
- **锁。** 每个账号一把锁，只在该账号刷新期间持有。锁里记录持有者的 pid 和进程启动时间，所以持有者崩溃，或者 pid 之后被无关进程复用，都能被识别为陈旧锁。
- **秘密。** token 不会出现在命令行参数、环境变量、事件或接口响应里，出现的只有 sha256 的前 12 位十六进制指纹。脚本的 stdout/stderr 只写到 `<dataDir>/logs/scripts.log`（0600），不经过接口返回。写入之前会把该账号当前的 token，以及所有形如 token 的字符串（`sk-ant-…`）替换掉。脱敏只是兜底，脚本本身仍不应打印凭证。
- **一个凭证文件只能属于一个账号。** 配置里如果两个账号共用同一个 `credentialPath`，会直接被拒绝。

## 配置（`~/.cred-keeper/config.json`）

完整示例见 `examples/config.json`。

| 字段 | 含义 |
|-|-|
| `listen` | 只允许回环地址（例如 `127.0.0.1:8790`）；对外访问请经反向代理 |
| `network.proxy` | 可选的 HTTP 代理。服务不读取 `*_proxy` 环境变量 |
| `claudeBinary` | 要审计的 claude 二进制；服务会检查其中 client_id、接口路径和请求头是否还在 |
| `accounts[].credentialPath` | 发布的凭证文件 |
| `accounts[].onRefreshed` | 每次刷新后执行的脚本，见下文 |
| `alert.script` | 告警投递脚本；不配置就不发告警 |
| `alert.minLevel` | `info` / `warn` / `error` / `critical`，默认 `error` |
| `alert.heartbeat` | 每日汇总的时间，格式 `HH:MM`；不配置就不发心跳 |

收到 SIGHUP，或配置文件的 mtime 变化时会热加载配置。如果有刷新正在进行，热加载会推迟到刷新结束。

## 脚本

两类脚本都直接执行（不经过 shell），各自运行在独立的进程组里，`PATH` 是最小集合。脚本里请使用绝对路径。

**onRefreshed：**

| 项目 | 约定 |
|-|-|
| 环境变量 | `CK_ACCOUNT` `CK_EVENT=refreshed` `CK_CREDENTIAL_PATH` `CK_FINGERPRINT` `CK_AT_EXPIRES_AT` `CK_RT_EXPIRES_AT`。不传 token，需要时自己读文件 |
| 超时 | `hookTimeoutSec`（默认 60 秒） |
| 重试 | 在超时预算内重试 1 次；仍失败则发 `hook_failed`（critical） |

**告警：**

| 项目 | 约定 |
|-|-|
| 环境变量 | `CK_EVENT` `CK_LEVEL` `CK_ACCOUNT` `CK_TITLE` `CK_DEDUP_KEY` |
| 标准输入 | 事件的 JSON |
| 重试 | 按退避重试 3 次；之后仍失败，事件记为 `alert_undelivered` |
| 去重 | 由核心负责，脚本不需要处理 |

`examples/` 目录里的示例：

- `on-refreshed-botmux-default.sh` — 播种各 bot 的凭证副本，然后 `botmux suspend all`（与旧 cron 脚本的行为一致）
- `on-refreshed-botmux-account.sh` — 对使用独立账号的 bot 执行 `botmux suspend --bot <appId>`
- `alert-lark.sh` — 通过 `lark-cli` 发飞书/Lark 私信

## 接口（只接受 GET）

| 路径 | 说明 |
|-|-|
| `/healthz` | 存活状态、账号列表、是否启用告警 |
| `/v1/accounts`、`/v1/accounts/{id}` | 状态、指纹、AT/RT 到期时间、上次刷新、连续失败次数、用量（单个账号还带最近的事件） |
| `/v1/accounts/{id}/usage`、`/v1/accounts/{id}/usage/history?since=24h` | 用量快照 / 时间序列 |
| `/v1/usage` | 所有账号的用量 |
| `/v1/events?account=&type=&since=&limit=` | 事件日志（只含退出码和耗时，不含脚本输出） |
| `/metrics` | Prometheus 文本格式 |

## 命令行

```
cred-keeper serve [--config <path>]
cred-keeper status [id]
cred-keeper refresh <id> --force --confirm <id>   # 会轮换 RT，并吊销所有消费者手上的当前 AT
cred-keeper pending <id> apply|discard --confirm <id> [--replace <副本指纹>]  # 处理服务没能自动应用的刷新响应
cred-keeper doctor                                  # 连通性（要求返回 405）、凭证文件、keychain 分裂、脚本、契约、旧 cron
cred-keeper alert-test
cred-keeper install-service [--load]                # launchd（Background 会话）/ systemd --user
```

## 测试

```sh
npm test                                        # node:test + 假 OAuth 服务器，不访问网络
CK_CLAUDE_BINARY=/path/to/claude.exe npm test   # 另外检查真实二进制里的契约字符串（只读）
```

对真实接口只能用垃圾 refresh token 做测试。复制一份真实凭证去刷新，**就是**一次真刷新：它会轮换 RT，并吊销所有持有者手上的 AT。
