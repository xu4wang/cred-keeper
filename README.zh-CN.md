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
- **覆盖之前一定留底。** 收编更新的文件时，被替换的副本另存为 `vault/<id>.displaced-*.json`；重新发布覆盖损坏的文件时，把损坏的文件另存为 `vault/<id>.quarantine-*.json`。
- **旧 cron 的锁。** 配置了 `legacyLockDir` 的账号（迁移期间的 default 账号），每次刷新时也会按旧脚本的协议（mkdir + pid）持有旧锁。所以即使 cron 还没停，两边也不可能同时刷新同一个 RT。服务只在锁目录不存在时才去拿锁；遇到陈旧的锁也绝不自己清理或接管，因为这会和旧脚本自己的清理逻辑产生竞态。陈旧的锁会阻止刷新，并触发 `legacy_lock_stale` 告警（每小时最多一次），由人工删除。
- **keychain 分裂闸门（macOS）。** 刷新之前先检查 claude 在 keychain 里有没有这份凭证的条目：`~/.claude` 对应 `Claude Code-credentials`，其他目录对应 `Claude Code-credentials-<目录 sha256 前 8 位>`。如果条目存在，claude 读的是 keychain 而不是我们刷新的文件，所以拒绝刷新并告警。只检查是否存在，而且总是在明确指定的 login keychain 里查。LaunchDaemon 不一定看得到这个 keychain，所以服务启动时会查找一个哨兵条目（用 `cred-keeper keychain-sentinel` 创建），并在 `/healthz` 的 `keychainGate` 里报告结果：`active`，或者 `unavailable`（同时告警）。只有 `active` 时闸门才生效，绝不会假装在检查。这是有意选择的 fail-open：哨兵不可见期间（例如开机后还没人登录时），刷新照常进行但跳过分裂检查，每次都会触发 `keychain_gate_unavailable` 告警。如果改成 fail-closed，在有人登录之前服务将完全无法刷新，AT 会过期。所以 `keychain_gate_unavailable` 持续出现时，必须有人去处理。

## 配置（`~/.cred-keeper/config.json`）

完整示例见 `examples/config.json`。

| 字段 | 含义 |
|-|-|
| `listen` | 只允许回环地址（例如 `127.0.0.1:8790`）；对外访问请经反向代理 |
| `network.proxy` | 可选的 HTTP 代理。服务不读取 `*_proxy` 环境变量 |
| `claudeBinary` | 要审计的 claude 二进制；服务会检查其中 client_id、接口路径和请求头是否还在 |
| `accounts[].credentialPath` | 发布的凭证文件 |
| `accounts[].onRefreshed` | 每次刷新后执行的脚本，见下文 |
| `accounts[].legacyLockDir` | 刷新这个账号时，同时持有旧 cron 的锁（mkdir + pid） |
| `alert.script` | 告警投递脚本；不配置就不发告警 |
| `alert.minLevel` | `info` / `warn` / `error` / `critical`，默认 `error` |
| `alert.heartbeat` | 每日汇总的时间，格式 `HH:MM`；不配置就不发心跳 |

收到 SIGHUP，或配置文件的 mtime 变化时会热加载配置。如果有刷新正在进行，热加载会推迟到刷新结束。

## 脚本

两类脚本都直接执行（不经过 shell），各自运行在独立的进程组里。服务的 `PATH` 是 node 所在目录加上系统目录。botmux 和 lark-cli 都是 node 脚本，所以示例里用 `"$NODE" <脚本>` 的方式调用。你自己写脚本时也请用绝对路径。

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

- `on-refreshed-botmux-default.sh` — 播种各 bot 的凭证副本，然后 `botmux suspend all`（与旧 cron 脚本的行为一致）。bots.json 里配了 `credentialsSourceDir` 的 bot 会被跳过。botmux 本身跑不起来（退出码 126/127）时，脚本失败，触发 `hook_failed`；其他非 0 退出码（部分会话不活跃）照旧容忍。注意：旧脚本每次运行都发心跳，cred-keeper 改为每天一次汇总（`alert.heartbeat`）
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
cred-keeper keychain-sentinel                       # macOS：创建哨兵条目，服务用它来确认自己能看到 keychain
cred-keeper install-service [--load]                # macOS：生成 LaunchDaemon 的 plist，并打印需要 sudo 执行的命令；Linux：systemd --user
```

## 安装为服务（macOS）

服务以 **LaunchDaemon** 运行：属于 system 域，`UserName` 是你本人，并显式设置 `HOME`、`USER` 和 `PATH`。所以开机后即使没有任何人登录也会启动，而用户级的 LaunchAgent 做不到这一点。

```sh
cred-keeper keychain-sentinel --config …     # 在普通登录会话里执行一次
cred-keeper install-service --config …       # 生成 <dataDir>/com.cred-keeper.plist，并打印下面的命令：
sudo install -o root -g wheel -m 644 <plist> /Library/LaunchDaemons/com.cred-keeper.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cred-keeper.plist
curl -s 127.0.0.1:<port>/healthz              # keychainGate 应为 "active"
```

在 daemon 自己的上下文里正向验证 keychain 闸门：

1. 用该账号对应的服务名创建一个测试条目，例如 `security add-generic-password -s "Claude Code-credentials-<hash>" -a test -w x`
2. 让该账号进入到期状态，例如临时调大它的 `marginMin`
3. 确认出现了 `keychain_split` 事件，并且没有发出刷新请求
4. 删除测试条目，恢复配置，然后确认不带后缀的条目仍然不存在：`security find-generic-password -s "Claude Code-credentials" ~/Library/Keychains/login.keychain-db` 必须返回 44

**测试时绝不能创建不带后缀的 `Claude Code-credentials` 条目**（在共享账号正在使用的机器上）：否则所有使用 `~/.claude` 的消费者都会立刻改读 keychain。

闸门在每次刷新前现场探测：先查哨兵，再查分裂条目。所以 login keychain 一旦变得可见，闸门会自动恢复；手动执行 `cred-keeper refresh` 也会经过同一道闸门。`/healthz` 报告的是最近一次的探测结果。

## 从旧 cron 迁移（default 账号）

1. 选一个刚刷新完的闲时窗口，备份 crontab，然后删除其中的刷新行和契约审计行
2. default 账号配置 `legacyLockDir`，指向旧锁（`~/.botmux/logs/.cred-refresh.lock`）。这样在 cron 可能还会运行的期间，服务和旧脚本是互斥的
3. `cred-keeper doctor` 确认 cron 行已经删除之后，**从配置里去掉 `legacyLockDir`**。否则，服务如果在刷新过程中被重启，留下的旧锁会永远卡住刷新。这种情况虽然会触发 `legacy_lock_stale`（AT 快过期时升级为 critical），但没有人会去清理它

## 测试

```sh
npm test                                        # node:test + 假 OAuth 服务器，不访问网络
CK_CLAUDE_BINARY=/path/to/claude.exe npm test   # 另外检查真实二进制里的契约字符串（只读）
```

对真实接口只能用垃圾 refresh token 做测试。复制一份真实凭证去刷新，**就是**一次真刷新：它会轮换 RT，并吊销所有持有者手上的 AT。
