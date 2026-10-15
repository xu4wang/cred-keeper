#!/usr/bin/env python3
"""Builds the cred-keeper docs pages (docs/*.html) from the PAGES list below.
Run: python3 docs/_build.py   — output is plain static HTML, no build step needed to serve it."""
import html, os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "https://github.com/xu4wang/cred-keeper"

NAV = [
    ("开始", [("index", "概览"), ("quickstart", "安装与上手")]),
    ("核心", [("concepts", "工作原理"), ("config", "配置参考"), ("hooks", "脚本与钩子")]),
    ("机队", [("fleet", "机队模式（跨机共享账号）")]),
    ("参考", [("api", "接口与命令行"), ("ops", "运维与排障")]),
]
ORDER = [k for _, items in NAV for k, _ in items]
TITLES = {k: t for _, items in NAV for k, t in items}

def nav(cur):
    out = []
    for grp, items in NAV:
        out.append(f'<div class="grp">{grp}</div>')
        for k, t in items:
            on = ' class="on"' if k == cur else ''
            out.append(f'<a href="{k}.html"{on}>{t}</a>')
    return "\n".join(out)

def page(key, lead, body):
    i = ORDER.index(key)
    prev = f'<a href="{ORDER[i-1]}.html">← {TITLES[ORDER[i-1]]}</a>' if i > 0 else '<span></span>'
    nxt = f'<a href="{ORDER[i+1]}.html">{TITLES[ORDER[i+1]]} →</a>' if i + 1 < len(ORDER) else '<span></span>'
    title = TITLES[key]
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} · cred-keeper 文档</title>
<meta name="description" content="cred-keeper：多账号 Claude OAuth 凭证刷新、用量监控与跨机共享。{html.escape(lead)}">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="topbar">
  <button class="menu-btn" onclick="document.body.classList.toggle('nav-open')" aria-label="目录">☰ 目录</button>
  <a class="brand" href="index.html">cred<span>-</span>keeper <span style="color:var(--muted);font-weight:500">文档</span></a>
  <span class="sp"></span>
  <a class="ext" href="../">🎬 动画讲解</a>
  <a class="ext" href="{REPO}">GitHub</a>
</header>
<div class="layout">
<nav class="side">
{nav(key)}
</nav>
<main>
<h1>{html.escape(title)}</h1>
<p class="lead">{lead}</p>
{body}
<div class="pager">{prev}{nxt}</div>
<footer>cred-keeper · MIT · 文档对应 <a href="{REPO}/tree/main">main 分支</a>；英文说明见 <a href="{REPO}#readme">README</a>。</footer>
</main>
</div>
</body>
</html>
"""

def lvl(l):
    return f'<span class="lvl {l}">{l}</span>'

# ---------------------------------------------------------------- pages

INDEX = f"""
<p>cred-keeper 让一台机器上多个 Claude 账号的 OAuth 凭证<strong>一直有效</strong>：到期前自动刷新、监控每个账号的 5 小时 / 7 天用量、对外提供只读 REST 接口。开启<a href="fleet.html">机队模式</a>后，多台机器还能通过一个 Redis 共享账号，任何机器上的使用方都能用任何一个账号。</p>

<p>它独立运行，不认识 botmux 或任何其他使用方。每次刷新后执行该账号配置的脚本，使用方就通过脚本接入。</p>

<div class="cards">
  <a class="card" href="quickstart.html"><b>安装与上手</b><span>装好、写最小配置、跑起来、装成服务</span></a>
  <a class="card" href="concepts.html"><b>工作原理</b><span>权威副本、刷新流程、pending 恢复、keychain 闸门</span></a>
  <a class="card" href="config.html"><b>配置参考</b><span>config.json 每个字段的含义与默认值</span></a>
  <a class="card" href="hooks.html"><b>脚本与钩子</b><span>onRefreshed / preRefresh / 告警的约定</span></a>
  <a class="card" href="fleet.html"><b>机队模式</b><span>多台机器通过 Redis 共享账号，bot 可以用任何机器的号</span></a>
  <a class="card" href="api.html"><b>接口与命令行</b><span>REST 接口、/metrics、CLI 子命令</span></a>
  <a class="card" href="ops.html"><b>运维与排障</b><span>事件与告警等级、常见问题、回滚</span></a>
</div>

<h2>它解决什么问题</h2>
<ul>
  <li><strong>凭证过期。</strong>Claude 的 access token（AT）约 8 小时过期，refresh token（RT）每次刷新都会轮换。多个进程各自刷新，会互相把对方的 RT 作废。cred-keeper 让<strong>每个账号只有一个刷新者</strong>。</li>
  <li><strong>刷新打断正在进行的对话。</strong>刷新会立刻作废旧 AT。<code>preRefresh</code> 闸门让刷新等到使用方空闲再做。</li>
  <li><strong>撞限流才知道。</strong>每个账号的 5h / 7d 用量定时采样、线性外推，快撞了就告警；配套的<a href="api.html#dashboard">用量看板</a>一屏看全机队。</li>
  <li><strong>账号被机器绑死。</strong>机队模式下，账号在哪台机器刷新与哪台机器上的 bot 使用它无关，换号只改使用方的一个配置项。</li>
</ul>

<h2>设计原则</h2>
<ul>
  <li><strong>秘密不出门。</strong>token 不进命令行参数、环境变量、事件或接口响应，对外只出现 sha256 前 12 位指纹。机队模式下 Redis 里只有密文。</li>
  <li><strong>不丢唯一的 RT。</strong>刷新响应先原样落盘再解析；任何「可能持有唯一有效 RT」的数据都不会被静默删除。</li>
  <li><strong>只读接口。</strong>对外只提供 GET（机队模式另有一个不带数据的本机 POST 触发同步）。</li>
  <li><strong>与使用方解耦。</strong>接入点只有脚本。不配机队段时，机队代码都不会加载。</li>
</ul>
"""

QUICK = """
<h2>运行要求</h2>
<ul>
  <li>Node.js 24 及以上。直接运行 TypeScript 源码（type stripping），使用内置的 <code>node:sqlite</code>，没有原生模块，也没有构建步骤。</li>
  <li>macOS 或 Linux。</li>
</ul>

<h2>安装</h2>
<pre><code>git clone https://github.com/xu4wang/cred-keeper.git ~/.cred-keeper/app
cd ~/.cred-keeper/app &amp;&amp; npm ci --omit=dev</code></pre>

<h2>最小配置</h2>
<p>写 <code>~/.cred-keeper/config.json</code>。下面管理一个账号：本机 claude 默认目录里的凭证。</p>
<pre><code>{
  "listen": "127.0.0.1:8790",
  "dataDir": "~/.cred-keeper",
  "accounts": [
    {
      "id": "default",
      "credentialPath": "~/.claude/.credentials.json",
      "onRefreshed": "~/.cred-keeper/hooks/on-refreshed.sh"
    }
  ],
  "alert": { "script": "~/.cred-keeper/hooks/alert.sh", "minLevel": "error", "heartbeat": "09:00" }
}</code></pre>
<p>完整示例见仓库 <code>examples/config.json</code>，每个字段的说明见<a href="config.html">配置参考</a>。</p>

<h2>检查与试跑</h2>
<pre><code>./bin/cred-keeper doctor --config ~/.cred-keeper/config.json   # 连通性、凭证文件、脚本、契约
./bin/cred-keeper serve  --config ~/.cred-keeper/config.json   # 前台运行
curl -s 127.0.0.1:8790/v1/accounts                             # 另开终端查看状态</code></pre>

<div class="callout danger"><b>别拿真凭证做实验。</b>复制一份真实凭证去刷新<strong>就是</strong>一次真刷新：它会轮换 RT，并吊销所有持有者手上的 AT。测试接口只用垃圾 refresh token。</div>

<h2>安装为服务（macOS）</h2>
<p>推荐以 <strong>LaunchDaemon</strong> 运行：属于 system 域，<code>UserName</code> 是你本人，并显式设置 <code>HOME</code>、<code>USER</code>、<code>PATH</code>。开机后即使没人登录也会启动，用户级 LaunchAgent 做不到这一点。</p>
<pre><code>cred-keeper keychain-sentinel --config …     # 在普通登录会话里执行一次
cred-keeper install-service --config …       # 生成 &lt;dataDir&gt;/com.cred-keeper.plist，并打印下面的命令
sudo install -o root -g wheel -m 644 &lt;plist&gt; /Library/LaunchDaemons/com.cred-keeper.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cred-keeper.plist
curl -s 127.0.0.1:&lt;port&gt;/healthz              # keychainGate 应为 "active"</code></pre>
<p>Linux 上 <code>install-service</code> 生成 systemd <code>--user</code> 单元。</p>

<h2>升级</h2>
<pre><code>cd ~/.cred-keeper/app &amp;&amp; git pull --ff-only &amp;&amp; npm ci --omit=dev
# 重启服务：LaunchDaemon 直接结束进程，KeepAlive 会拉起；LaunchAgent 用
launchctl kickstart -k gui/$(id -u)/com.cred-keeper</code></pre>
<p>配置文件改动不需要重启：mtime 变化或收到 SIGHUP 即热加载（有刷新进行中时推迟到刷新结束）。</p>

<h2>从旧 cron 迁移</h2>
<ol>
  <li>选一个刚刷新完的闲时窗口，备份 crontab，删除其中的刷新行和契约审计行。</li>
  <li>该账号配置 <code>legacyLockDir</code> 指向旧锁，使服务与可能还在跑的旧脚本互斥。</li>
  <li><code>cred-keeper doctor</code> 确认 cron 行已删除后，<strong>从配置里去掉 <code>legacyLockDir</code></strong>，否则服务在刷新中途被重启留下的旧锁会永远卡住刷新。</li>
</ol>
"""

CONCEPTS = """
<figure class="diagram">
<svg viewBox="0 0 860 250" role="img" aria-label="刷新流程">
  <rect class="box" x="10" y="90" width="150" height="70" rx="10"/>
  <text class="t" x="85" y="120" text-anchor="middle">到期判断</text>
  <text class="m" x="85" y="142" text-anchor="middle">AT 剩 ≤ marginMin</text>
  <rect class="box" x="200" y="90" width="150" height="70" rx="10"/>
  <text class="t" x="275" y="120" text-anchor="middle">preRefresh 闸门</text>
  <text class="m" x="275" y="142" text-anchor="middle">忙(75) → 推迟</text>
  <rect class="box hot" x="390" y="90" width="150" height="70" rx="10"/>
  <text class="t" x="465" y="120" text-anchor="middle">POST /oauth/token</text>
  <text class="m" x="465" y="142" text-anchor="middle">RT 在此轮换</text>
  <rect class="box" x="580" y="20" width="270" height="56" rx="10"/>
  <text class="t" x="715" y="45" text-anchor="middle">① 原始响应落 pending/</text>
  <text class="m" x="715" y="64" text-anchor="middle">先保存，再解析</text>
  <rect class="box" x="580" y="97" width="270" height="56" rx="10"/>
  <text class="t" x="715" y="122" text-anchor="middle">② 写 vault → 发布 credentialPath</text>
  <text class="m" x="715" y="141" text-anchor="middle">0600 原子 rename + fsync，旧文件留 .prev</text>
  <rect class="box cool" x="580" y="174" width="270" height="56" rx="10"/>
  <text class="t" x="715" y="199" text-anchor="middle">③ onRefreshed 脚本</text>
  <text class="m" x="715" y="218" text-anchor="middle">使用方接入点（如 suspend bot）</text>
  <path class="ln" d="M160 125 H200"/><path class="ln" d="M350 125 H390"/>
  <path class="ln a" d="M540 125 C560 125 560 48 580 48"/>
  <path class="ln a" d="M540 125 H580"/>
  <path class="ln a" d="M540 125 C560 125 560 202 580 202"/>
</svg>
<figcaption>一次刷新：AT 快过期 → 问使用方忙不忙 → 换 token → 先存原始响应、再更新权威副本和发布文件 → 通知使用方。</figcaption>
</figure>

<h2>权威副本（vault）与发布文件</h2>
<p>每个账号在 <code>&lt;dataDir&gt;/vault/&lt;id&gt;.json</code>（0600）保存一份权威副本；<code>credentialPath</code> 只是发布给使用方读的那一份。两者每分钟比对一次：</p>
<ul>
  <li>发布的文件被清空、损坏、处于登出状态，或者比副本旧 → 从副本<strong>重新发布</strong>（损坏的文件另存为 <code>vault/&lt;id&gt;.quarantine-*.json</code>）。</li>
  <li>发布的文件比副本新（例如有人重新登录了）→ <strong>收编</strong>为新的副本（被替换的副本另存为 <code>vault/&lt;id&gt;.displaced-*.json</code>）。</li>
</ul>
<p>一个凭证文件只能属于一个账号：两个账号配置同一个 <code>credentialPath</code> 会被直接拒绝。</p>

<h2>刷新</h2>
<p>AT 剩余时间不超过 <code>marginMin</code> 分钟（默认 120，另加 0–5 分钟随机抖动）时刷新。收到 HTTP 200 后，先把原始响应文本原样保存到 <code>&lt;dataDir&gt;/pending/</code>，再解析、更新副本、更新发布文件，最后执行 <code>onRefreshed</code>。</p>
<ul>
  <li>pending 写不进去时改写另一个目录里的应急位置；应急位置也失败就留在内存里，每个周期重试写入。新凭证本身照常应用。</li>
  <li>副本写不进去时，新凭证留在内存里，每分钟重试写入。</li>
</ul>

<h3>刷新结果</h3>
<table>
<tr><th>结果</th><th>处理</th></tr>
<tr><td>网络失败</td><td>重试；连续第 2 次失败（或 AT 已低于 <code>redMin</code>）时告警 <code>refresh_failed</code></td></tr>
<tr><td><code>invalid_grant</code></td><td>进入 <code>dead</code>，需要人工重新登录；绝不会用同一个 RT 重试</td></tr>
<tr><td>格式不对的 400</td><td>告警（很可能是接口契约变了）</td></tr>
<tr><td>200 但字段不认识</td><td>进入 <code>critical</code>，保留 pending 响应，等人处理</td></tr>
</table>

<h2>pending 响应绝不静默丢弃</h2>
<p>服务启动时和每个周期都会检查 pending 响应：</p>
<ul>
  <li>它是基于当前副本发出的 → 应用。</li>
  <li>副本里已经带有它的 AT 或 RT（之前应用过）→ 删除。</li>
  <li>否则保留，账号进入 <code>critical</code>，同一份 pending 只报告一次。pending 未解决期间<strong>不会发起新的刷新</strong>：它可能持有唯一有效的 RT。</li>
</ul>
<p>人工处理：<code>cred-keeper pending &lt;id&gt; apply|discard --confirm &lt;id&gt;</code>。响应不是基于当前副本时，<code>apply</code> 还必须加 <code>--replace &lt;当前副本指纹&gt;</code>。</p>

<h2>锁</h2>
<p>每个账号一把锁，只在该账号刷新、恢复、对账、补写期间持有。锁里记录持有者 pid 和进程启动时间，持有者崩溃或 pid 被复用都能识别为陈旧锁。<code>status()</code> 只读，不拿锁。</p>

<h2>用量</h2>
<p>每 <code>usagePollMin</code> 分钟（默认 10）调用一次 <code>GET /api/oauth/usage</code>，保存 5 小时和 7 天两个窗口的利用率与重置时间，并线性外推窗口结束时的用量（<code>projected</code>）。窗口刚开始时外推分母太小，结果只作提前预警参考。</p>

<h2>秘密</h2>
<ul>
  <li>token 不出现在命令行参数、环境变量、事件或接口响应里；对外只出现 sha256 前 12 位指纹。</li>
  <li>脚本的 stdout/stderr 只写 <code>&lt;dataDir&gt;/logs/scripts.log</code>（0600），不经接口返回；写入前把当前 token 与形如 <code>sk-ant-…</code> 的串替换掉。脱敏只是兜底，脚本本身不应打印凭证。</li>
</ul>

<h2>keychain 分裂闸门（macOS）</h2>
<p>如果 claude 在 keychain 里有这份凭证的条目（<code>~/.claude</code> 对应 <code>Claude Code-credentials</code>，其他目录对应 <code>Claude Code-credentials-&lt;目录 sha256 前 8 位&gt;</code>），它读的是 keychain 而不是我们刷新的文件。刷新会把 RT 转走、让 keychain 那份失效，所以此时<strong>拒绝刷新并告警</strong> <code>keychain_split</code>。</p>
<p>LaunchDaemon 不一定看得到 login keychain，因此服务用一个哨兵条目（<code>cred-keeper keychain-sentinel</code> 创建）确认自己的可见性，并在 <code>/healthz</code> 的 <code>keychainGate</code> 报告 <code>active</code> 或 <code>unavailable</code>。只有 <code>active</code> 时闸门才生效；<code>unavailable</code> 期间照常刷新但跳过分裂检查，并持续告警——这是有意的 fail-open，否则开机后无人登录时 AT 会过期。</p>
<div class="callout danger"><b>测试时绝不能创建不带后缀的 <code>Claude Code-credentials</code> 条目</b>（在共享账号正在使用的机器上），否则所有使用 <code>~/.claude</code> 的使用方都会立刻改读 keychain。</div>
"""

def row(*cells):
    return "<tr>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>"

CONFIG = f"""
<p>配置文件默认在 <code>~/.cred-keeper/config.json</code>（命令行 <code>--config</code> 可改）。路径字段都必须是绝对路径或以 <code>~/</code> 开头。修改后自动热加载。</p>

<h2>顶层</h2>
<table>
<tr><th>字段</th><th>默认</th><th>含义</th></tr>
{row("<code>listen</code>", "<code>127.0.0.1:8790</code>", "只允许回环地址；对外访问请经反向代理（如 nginx，只放行 GET/HEAD）")}
{row("<code>dataDir</code>", "<code>~/.cred-keeper</code>", "vault、pending、锁、state.db、日志所在目录")}
{row("<code>network.proxy</code>", "—", "可选的 HTTP 代理；服务<strong>不读</strong> <code>*_proxy</code> 环境变量")}
{row("<code>claudeBinary</code>", "—", "要审计的 claude 二进制：每小时检查其中 client_id、接口路径、请求头是否还在，漂移则告警 <code>contract_drift</code>")}
{row("<code>defaults.marginMin</code>", "120", "AT 剩余少于这么多分钟就刷新")}
{row("<code>defaults.redMin</code>", "30", "AT 剩余少于这么多分钟：不再推迟刷新，失败告警升级")}
{row("<code>defaults.rtWarnDays</code>", "7", "RT 剩余天数低于此值每天告警一次（RT 到期只能人工登录）")}
{row("<code>defaults.usagePollMin</code>", "10", "用量采样间隔（分钟）")}
{row("<code>usageThresholds.fiveHourPct</code>", "80", "5 小时窗口利用率 ≥ 此值告警 <code>usage_high</code>")}
{row("<code>usageThresholds.projectedPct</code>", "100", "5 小时窗口外推值 ≥ 此值告警 <code>usage_high</code>")}
{row("<code>alert.script</code>", "—", "告警投递脚本；不配置就不发告警")}
{row("<code>alert.minLevel</code>", "<code>error</code>", "<code>info</code> / <code>warn</code> / <code>error</code> / <code>critical</code>；低于此级别的事件只记录不投递")}
{row("<code>alert.heartbeat</code>", "—", "每日汇总时间 <code>HH:MM</code>；不配置就不发心跳")}
{row("<code>alert.timeoutSec</code>", "30", "告警脚本超时")}
{row("<code>fleet</code>", "—", "机队模式，见<a href='fleet.html#config'>机队模式</a>。不配置 = 单机模式")}
</table>
<div class="callout warn"><b>注意</b> <code>usage_high</code> 是 warn 级别。<code>alert.minLevel</code> 保持默认 <code>error</code> 时，它只会记录在事件里，不会推送。想收到用量预警，就把 <code>minLevel</code> 调到 <code>warn</code>，或者用看板查看。</div>

<h2>accounts[]</h2>
<table>
<tr><th>字段</th><th>默认</th><th>含义</th></tr>
{row("<code>id</code>", "必填", "<code>[a-z0-9][a-z0-9_-]{{0,31}}</code>，本机唯一")}
{row("<code>credentialPath</code>", "必填", "发布的凭证文件（使用方读的那份），不能与其他账号重复")}
{row("<code>label</code>", "登录邮箱 @ 前部分", "显示名。不配置时从凭证旁的 claude 配置里读登录邮箱（<code>~/.claude/…</code> 对应 <code>~/.claude.json</code>，其他目录对应 <code>&lt;目录&gt;/.claude.json</code>），取不到就用 id")}
{row("<code>onRefreshed</code>", "—", "每次刷新后执行的脚本，见<a href='hooks.html'>脚本与钩子</a>")}
{row("<code>hookTimeoutSec</code>", "60", "onRefreshed 超时（含 1 次重试）")}
{row("<code>preRefresh</code>", "—", "到期后先问使用方忙不忙，exit 75 = 忙、推迟")}
{row("<code>preRefreshTimeoutSec</code>", "20", "preRefresh 超时")}
{row("<code>preRefreshMaxDeferMin</code>", "60", "一次推迟最长持续多久；0 = 不推迟")}
{row("<code>marginMin</code> / <code>redMin</code> / <code>rtWarnDays</code> / <code>usagePollMin</code>", "取 defaults", "按账号覆盖")}
{row("<code>legacyLockDir</code>", "—", "迁移期专用：刷新时同时持有旧 cron 的锁（mkdir + pid）。迁移完必须去掉")}
</table>

<h2>完整示例</h2>
<pre><code>{{
  "listen": "127.0.0.1:8790",
  "dataDir": "~/.cred-keeper",
  "defaults": {{ "marginMin": 120, "redMin": 30, "rtWarnDays": 7, "usagePollMin": 10 }},
  "claudeBinary": "~/.local/node-v24/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  "accounts": [
    {{
      "id": "default",
      "credentialPath": "~/.claude/.credentials.json",
      "onRefreshed": "~/.cred-keeper/hooks/on-refreshed-botmux-default.sh",
      "preRefresh": "~/.cred-keeper/hooks/pre-refresh-botmux.sh"
    }},
    {{
      "id": "acct1",
      "credentialPath": "~/accounts/acct1/claude/.credentials.json",
      "onRefreshed": "~/.cred-keeper/hooks/on-refreshed-acct1.sh",
      "preRefresh": "~/.cred-keeper/hooks/pre-refresh-acct1.sh"
    }}
  ],
  "alert": {{ "script": "~/.cred-keeper/hooks/alert-lark.sh", "minLevel": "error", "heartbeat": "09:00" }}
}}</code></pre>
"""

HOOKS = f"""
<p>脚本是 cred-keeper 与使用方之间唯一的接入点。所有脚本都<strong>直接执行</strong>（不经 shell），各自运行在独立进程组里，超时整组结束。服务的 <code>PATH</code> 只有 node 所在目录加系统目录，所以脚本里请用绝对路径；botmux、lark-cli 这类 node 脚本用 <code>"$NODE" &lt;脚本&gt;</code> 调用。环境变量里<strong>从不传 token</strong>，需要时自己读文件。</p>

<h2 id="onrefreshed">onRefreshed</h2>
<table>
<tr><th>项目</th><th>约定</th></tr>
{row("何时执行", "每次成功刷新（或恢复 pending）并写好文件之后")}
{row("环境变量", "<code>CK_ACCOUNT</code> <code>CK_EVENT=refreshed</code> <code>CK_CREDENTIAL_PATH</code> <code>CK_FINGERPRINT</code> <code>CK_AT_EXPIRES_AT</code> <code>CK_RT_EXPIRES_AT</code>")}
{row("超时 / 重试", "<code>hookTimeoutSec</code>（默认 60 秒）内重试 1 次；仍失败发 <code>hook_failed</code> " + lvl("critical"))}
{row("典型用途", "让使用方换上新凭证：例如 <code>botmux suspend --bot &lt;appId&gt;</code>，下一条消息冷启动时复制新凭证")}
</table>

<h2 id="prerefresh">preRefresh</h2>
<p>刷新会立刻作废旧 AT，正在用它的请求都会失败（claude 报 <code>provider_authentication_failed</code>，还可能把它自己那份凭证清空）。这个脚本让到期的刷新等到使用方空闲再做。</p>
<table>
<tr><th>项目</th><th>约定</th></tr>
{row("何时执行", "到期待刷新期间，每次巡检（1 分钟）一次。CLI 强制刷新不执行")}
{row("环境变量", "<code>CK_ACCOUNT</code> <code>CK_EVENT=pre_refresh</code> <code>CK_CREDENTIAL_PATH</code> <code>CK_AT_LEFT_MIN</code>")}
{row("退出码", "<code>75</code> = 忙，推迟到下次巡检；<code>0</code> = 可以刷新；其他退出码 / 超时 / 起不来 → 照常刷新并记 <code>pre_refresh_failed</code> " + lvl("warn") + "：按时刷新比保住一轮对话更重要")}
{row("上限", "AT 剩余 ≤ <code>redMin</code> 时不再推迟；连续推迟满 <code>preRefreshMaxDeferMin</code> 也不再推迟。推迟计时只在内存里，重启会重新计时，真正的硬上限是 <code>redMin</code>")}
{row("事件", "<code>refresh_deferred</code>（每次推迟只记一次）、<code>refresh_defer_ended</code>（<code>reason</code>：<code>idle</code> / <code>not_due</code> 为 info，<code>floor</code> / <code>max_defer</code> / <code>gate_failed</code> 为 warn）")}
</table>
<p>机队模式下，同一道闸门还会询问<strong>其他机器</strong>上使用这个号的 bot 是否在忙，规则与上限完全相同，见<a href="fleet.html#busy">机队模式 · 查忙</a>。</p>

<h2 id="alert">告警脚本</h2>
<table>
<tr><th>项目</th><th>约定</th></tr>
{row("环境变量", "<code>CK_EVENT</code> <code>CK_LEVEL</code> <code>CK_ACCOUNT</code> <code>CK_TITLE</code> <code>CK_DEDUP_KEY</code>")}
{row("标准输入", "事件的 JSON")}
{row("重试", "按退避重试 3 次；之后仍失败，记 <code>alert_undelivered</code>")}
{row("去重", "由核心负责（同一问题一个「事件期」只告一次，恢复后重新计），脚本不用处理")}
</table>

<h2>仓库里的示例（<code>examples/</code>）</h2>
<table>
<tr><th>脚本</th><th>用途</th></tr>
{row("<code>on-refreshed-botmux-default.sh</code>", "共享默认账号：播种各 bot 的凭证副本，然后 <code>botmux suspend all</code>。配了 <code>credentialsSourceDir</code> 的 bot 会被跳过")}
{row("<code>on-refreshed-botmux-account.sh</code>", "独立账号：对列出的 bot 执行 <code>botmux suspend --bot &lt;appId&gt;</code>")}
{row("<code>pre-refresh-botmux.sh</code>", "用 <code>botmux suspend --dry-run</code> 判断：有会话会被「排队」（正在回复）就返回 75。只读")}
{row("<code>fleet-botmux-mirror.sh</code>", "机队镜像的三个钩子共用：按 bots.json 里的 <code>credentialsSourceDir</code> 自动找到使用该号的 bot")}
{row("<code>alert-lark.sh</code>", "通过 <code>lark-cli</code> 发飞书私信")}
</table>
"""

FLEET_SVG = """
<figure class="diagram">
<svg viewBox="0 0 880 330" role="img" aria-label="机队模式数据流">
  <rect class="box hot" x="20" y="30" width="220" height="120" rx="12"/>
  <text class="t" x="130" y="58" text-anchor="middle">机器 A（生产者）</text>
  <text class="m" x="130" y="82" text-anchor="middle">cred-keeper 刷新自己的号 tian</text>
  <text class="m" x="130" y="104" text-anchor="middle">publish: default → tian</text>
  <text class="m" x="130" y="126" text-anchor="middle">刷新前读 busy，有人忙就推迟</text>

  <rect class="box" x="330" y="90" width="220" height="150" rx="12"/>
  <text class="t" x="440" y="118" text-anchor="middle">Redis（只是缓存）</text>
  <text class="m" x="440" y="144" text-anchor="middle">ck:cred:&lt;号&gt;  AES-256-GCM 密文</text>
  <text class="m" x="440" y="166" text-anchor="middle">ck:events  刷新广播（stream）</text>
  <text class="m" x="440" y="188" text-anchor="middle">ck:busy:&lt;号&gt;:&lt;机器&gt;  带 TTL</text>
  <text class="m" x="440" y="214" text-anchor="middle">丢了也没事：5 分钟内重新写满</text>

  <rect class="box cool" x="640" y="30" width="220" height="120" rx="12"/>
  <text class="t" x="750" y="58" text-anchor="middle">机器 B（使用方）</text>
  <text class="m" x="750" y="82" text-anchor="middle">mirrors: tian</text>
  <text class="m" x="750" y="104" text-anchor="middle">~/accounts/tian/ 逐字节副本</text>
  <text class="m" x="750" y="126" text-anchor="middle">onUpdated → suspend 相关 bot</text>

  <rect class="box cool" x="640" y="200" width="220" height="100" rx="12"/>
  <text class="t" x="750" y="228" text-anchor="middle">bot（任何机器）</text>
  <text class="m" x="750" y="252" text-anchor="middle">credentialsSourceDir</text>
  <text class="m" x="750" y="272" text-anchor="middle">= ~/accounts/tian</text>

  <path class="ln a" d="M240 75 C290 75 290 130 330 130"/>
  <text class="m" x="250" y="66">① 刷新后发布</text>
  <path class="ln b" d="M550 130 C600 130 600 75 640 75"/>
  <text class="m" x="566" y="62">② 广播→拉取</text>
  <path class="ln b d" d="M640 120 C600 120 600 190 550 190"/>
  <text class="m" x="565" y="214">③ 报忙</text>
  <path class="ln a d" d="M330 200 C280 200 280 140 240 140"/>
  <text class="m" x="232" y="214">④ 刷新前查忙</text>
  <path class="ln b" d="M750 150 V200"/>
  <text class="m" x="758" y="180">冷启动复制</text>
</svg>
<figcaption>每台机器仍只刷新自己的号；Redis 只负责传递密文和忙碌状态；使用方的 bot 指向本机的镜像目录。</figcaption>
</figure>
"""

FLEET = f"""
<p>单机模式下，一台机器上的 bot 只能用这台机器上登录的号。机队模式让多台机器通过一个 Redis 共享账号：<strong>每台机器仍只刷新自己的号</strong>，刷新后把凭证加密发布出去；其他机器把需要的号镜像到本地，bot 指向镜像即可。换号只改 bot 的一个配置项，与号在哪台机器刷新无关。</p>
{FLEET_SVG}

<h2>三件事</h2>
<ul>
  <li><strong>发布（publish）</strong>：<code>fleet.publish</code> 里列出的本机号，每次刷新后、以及每 <code>republishMin</code> 分钟（默认 5），把凭证文件原样加密写进 <code>ck:cred:&lt;号&gt;</code>，并在 <code>ck:events</code> stream 上广播。</li>
  <li><strong>镜像（mirrors）</strong>：别的机器负责刷新的号。收到广播立即拉取（另外每分钟兜底同步一次），只有<strong>严格更新</strong>的凭证才会替换本地副本（到期时间相同也不替换），替换在文件锁内完成，然后运行 <code>onUpdated</code>。</li>
  <li id="busy"><strong>查忙（busy）</strong>：副本进入所属号的刷新窗口（AT 剩不到 180 分钟）后，每分钟运行 <code>busyCheck</code>；退出码 75 表示本机有使用这个号的 bot 正在回复，写入带 TTL 的 <code>ck:busy:&lt;号&gt;:&lt;机器&gt;</code>。所属机器刷新前读取它，有人忙就推迟——规则与本机 <code>preRefresh</code> 完全相同，同样受 <code>preRefreshMaxDeferMin</code> / <code>redMin</code> 限制。</li>
</ul>

<h2>凭证原样传输</h2>
<p>镜像副本与生产者的凭证文件<strong>逐字节一致</strong>，不改 schema；登录身份 <code>oauthAccount</code> 写进副本旁边的 <code>.claude.json</code>（该文件的其他字段保留）。所以 Claude Code 以后改凭证格式也不影响机队模式。</p>

<h2 id="config">配置</h2>
<pre><code>"fleet": {{
  "machine": "dev-prem",
  "redis": "redis://redis.example.lan:6379",
  "redisPasswordFile": "~/.cred-keeper/fleet-redis.pass",
  "keyFile": "~/.cred-keeper/fleet.key",
  "publish": {{ "default": "alpha", "acct1": "young" }},
  "mirrors": [
    {{ "name": "tian",
      "credentialPath": "~/accounts/tian/claude/.credentials.json",
      "onUpdated": "~/.cred-keeper/hooks/fleet-botmux-mirror.sh",
      "busyCheck": "~/.cred-keeper/hooks/fleet-botmux-mirror.sh",
      "onStale":   "~/.cred-keeper/hooks/fleet-botmux-mirror.sh" }}
  ]
}}</code></pre>
<table>
<tr><th>字段</th><th>默认</th><th>含义</th></tr>
{row("<code>machine</code>", "必填", "本机在机队里的名字（忙碌上报、事件来源）")}
{row("<code>redis</code>", "必填", "<code>redis://[:密码@]主机[:端口][/库]</code>")}
{row("<code>redisPasswordFile</code>", "—", "Redis 密码文件（0600），优先于 URL 里的密码")}
{row("<code>keyFile</code>", "<code>~/.cred-keeper/fleet.key</code>", "机队密钥：32 字节 base64，<strong>每台机器同一份</strong>")}
{row("<code>publish</code>", "<code>{{}}</code>", "本机账号 id → 机队统一号名")}
{row("<code>mirrors[].name</code>", "必填", "要镜像的机队号名（不能和本机发布的重名）")}
{row("<code>mirrors[].credentialPath</code>", "<code>~/accounts/&lt;name&gt;/claude/.credentials.json</code>", "副本位置；不能在 <code>~/.claude</code> 里，不能与本机账号重复")}
{row("<code>mirrors[].onUpdated</code>", "—", "副本更新后执行（环境变量同 onRefreshed，<code>CK_EVENT=mirror_updated</code>）")}
{row("<code>mirrors[].busyCheck</code>", "—", "<code>CK_EVENT=busy_check</code>；75 = 忙")}
{row("<code>mirrors[].onStale</code>", "—", "副本快过期仍未更新时执行一次（<code>CK_EVENT=mirror_stale</code>）")}
{row("<code>mirrors[].warnMin</code> / <code>errorMin</code>", "45 / 20", "副本 AT 剩余少于此分钟数且未更新 → <code>mirror_stale</code> " + lvl("warn") + " / <code>mirror_expiring</code> " + lvl("error"))}
{row("<code>republishMin</code>", "5", "未变化时也定期重写，Redis 重启清空后自动补满")}
{row("<code>busyTtlSec</code>", "150", "忙碌上报的寿命；机器宕机后最多这么久就不再挡刷新")}
</table>

<h2>安全</h2>
<ul>
  <li>写进 Redis 的每个值（凭证和忙碌上报）都用机队密钥做 <strong>AES-256-GCM</strong> 加密，并把 key 名作为附加认证数据绑定——一个号的密文不能被挪去冒充另一个号。Redis 走明文 TCP 也看不到任何 token。</li>
  <li>密钥只生成一次：<code>cred-keeper fleet-keygen &lt;路径&gt;</code>（不会覆盖已有文件），把这个文件复制到每台机器（0600）。Redis 另设密码，只监听内网。</li>
  <li>镜像副本包含 RT（为了不改 schema）。生产者每次刷新都会轮换 RT，副本里的 RT 随即作废；新鲜度检查保证同步中断时提前告警。</li>
</ul>

<h2>故障语义</h2>
<table>
<tr><th>情况</th><th>结果</th></tr>
{row("Redis 不可达", "本机刷新、本机钩子完全不受影响；记 <code>fleet_unreachable</code>（每小时最多一次）。镜像暂停更新，恢复后自动追平")}
{row("读不到忙碌状态", "<strong>不推迟</strong>刷新（不能因为 Redis 挂了就一直不刷）")}
{row("Redis 重启、数据清空", "生产者 <code>republishMin</code> 内重新写满，无需人工")}
{row("某台机器宕机", "它的忙碌上报在 <code>busyTtlSec</code> 后过期，不再挡别人刷新")}
{row("密钥不一致 / 被篡改", "解密失败，副本不更新，记 <code>mirror_unreadable</code> " + lvl("error"))}
{row("旧值重放", "只接受到期时间严格更晚的凭证，旧值被忽略")}
</table>

<h2>在 botmux 上使用</h2>
<ol>
  <li>使用方机器的 <code>fleet.mirrors</code> 加上要用的号，三个钩子都指向 <code>examples/fleet-botmux-mirror.sh</code>（它按 bots.json 自动找 bot，不需要维护名单）。</li>
  <li>等副本出现：<code>curl 127.0.0.1:8790/v1/fleet</code> 里该镜像的 <code>freshness</code> 为 <code>ok</code>。</li>
  <li>把 bot 的 <code>credentialsSourceDir</code> 改成副本的账号目录（如 <code>~/accounts/tian</code>），对这个 bot 执行 <code>botmux stop-bot</code> / <code>start-bot</code> 和 <code>botmux suspend --bot</code>。</li>
  <li>如果这个 bot 原来在别的号的钩子名单里，从名单里去掉。</li>
  <li>验证：bot 冷启动后，它自己那份凭证的 AT 指纹应与该号一致。</li>
</ol>

<h2>部署 Redis 的参考配置</h2>
<pre><code>bind 127.0.0.1 &lt;内网 IP&gt;
protected-mode yes
requirepass &lt;随机长密码&gt;
save ""              # 只是缓存，不需要持久化
appendonly no
maxmemory 64mb
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command CONFIG ""
rename-command DEBUG ""</code></pre>

<h2>回滚</h2>
<p>删掉 <code>config.json</code> 里的 <code>fleet</code> 段，热加载后立即回到单机模式；把 bot 的 <code>credentialsSourceDir</code> 改回原来的号即可。</p>
"""

API = f"""
<h2>REST 接口</h2>
<p>只监听回环地址。对外暴露请经反向代理，并只放行 GET/HEAD。响应里没有 token，也没有脚本输出。</p>
<table>
<tr><th>路径</th><th>说明</th></tr>
{row("<code>GET /healthz</code>", "存活、版本、账号列表、是否启用告警、<code>keychainGate</code>、机队摘要（未启用为 <code>null</code>）")}
{row("<code>GET /v1/accounts</code>", "全部账号：<code>label</code> / <code>labelSource</code>、状态、指纹、AT 与 RT 到期、下次刷新、推迟起点、上次刷新、连续失败次数、用量")}
{row("<code>GET /v1/accounts/{{id}}</code>", "单个账号，另带最近 20 条事件")}
{row("<code>GET /v1/accounts/{{id}}/usage</code>", "最新用量快照")}
{row("<code>GET /v1/accounts/{{id}}/usage/history?since=24h</code>", "用量时间序列；<code>since</code> 支持 <code>30m</code> / <code>6h</code> / <code>7d</code> 或 ISO 时间")}
{row("<code>GET /v1/usage</code>", "所有账号的用量")}
{row("<code>GET /v1/events?account=&amp;type=&amp;since=&amp;limit=</code>", "事件日志（只有退出码和耗时，没有脚本输出）")}
{row("<code>GET /v1/fleet</code>", "机队模式：本机发布了哪些号，以及每个镜像的指纹、AT 剩余、来源、最近同步/更新时间、<code>freshness</code>")}
{row("<code>POST /v1/fleet/sync</code>", "机队模式：立即拉取所有镜像。请求和响应都不带凭证；只能本机调用")}
{row("<code>GET /metrics</code>", "Prometheus 文本：AT 剩余分钟、RT 剩余天数、连续失败、状态、5h/7d 用量、镜像 AT 剩余")}
</table>

<h3>账号状态 <code>state</code></h3>
<table>
<tr><th>值</th><th>含义</th></tr>
{row("<code>ok</code>", "正常")}
{row("<code>refreshing</code> / <code>retrying</code>", "刷新中 / 网络失败后等待重试")}
{row("<code>dead</code>", "RT 失效（<code>invalid_grant</code>），需要人工重新登录")}
{row("<code>critical</code>", "有无法自动判断的 pending 响应或无法识别的刷新响应，需要人工处理")}
{row("<code>breaker</code>", "权威副本和发布文件都不可用，已熔断")}
</table>

<h2 id="dashboard">用量看板</h2>
<p>仓库 <code>examples/dashboard/</code> 是一个静态页面，展示一个或多个实例的全部账号：状态、5h / 7d 用量（含重置时间与预测）、AT 剩余、RT 到期日，以及 7 天曲线。每分钟自动刷新，只调用上面的 GET 接口。</p>
<ol>
  <li>把 <code>index.html</code> 放到 Web 目录，同目录放 <code>sites.json</code>：<code>[{{ "key": "&lt;路径段&gt;", "name": "&lt;显示名&gt;" }}]</code></li>
  <li>同域名下把 <code>/api/&lt;key&gt;/</code> 转发到各实例，只放行 GET/HEAD（参考 <code>nginx.example.conf</code>）。服务本身不发 CORS 头。</li>
</ol>

<h2>命令行</h2>
<pre><code>cred-keeper serve [--config &lt;path&gt;]
cred-keeper status [id]
cred-keeper refresh &lt;id&gt; --force --confirm &lt;id&gt;     # 会轮换 RT，并吊销所有使用方手上的当前 AT
cred-keeper pending &lt;id&gt; apply|discard --confirm &lt;id&gt; [--replace &lt;副本指纹&gt;]
cred-keeper doctor                                    # 连通性、凭证文件、keychain 分裂、脚本、契约、旧 cron
cred-keeper alert-test                                # 发一条测试告警
cred-keeper keychain-sentinel                         # macOS：创建哨兵条目
cred-keeper install-service [--load]                  # macOS LaunchDaemon plist / Linux systemd --user
cred-keeper fleet-keygen &lt;path&gt;                       # 生成机队密钥（不覆盖已有文件）
cred-keeper fleet-sync                                # 让运行中的服务立即同步所有镜像</code></pre>
"""

EVENTS = [
    ("refreshed", "info", "刷新成功"),
    ("refresh_retry", "warn", "网络失败，下个周期重试"),
    ("refresh_failed", "error", "刷新失败（网络连续失败 / 被拒绝）"),
    ("rt_dead", "critical", "RT 失效，需要人工重新登录"),
    ("rt_expiring", "error", "RT 将在 rtWarnDays 天内到期，需安排人工登录（每天一次）"),
    ("critical_unknown_response", "critical", "刷新响应无法识别，RT 可能已在服务端轮换"),
    ("pending_unresolved", "critical", "存在无法自动判断的 pending 响应"),
    ("persist_failed", "critical", "凭证或 pending 写盘失败（内存里保留，持续重试）"),
    ("breaker", "critical", "权威副本与发布文件都不可用"),
    ("republished", "error", "发布文件异常，已从权威副本重新发布（每小时最多一次）"),
    ("adopted", "warn", "发布文件比副本新（多为人工重新登录），已收编"),
    ("hook_failed", "critical", "onRefreshed 失败：使用方可能仍持有已吊销的 AT"),
    ("pre_refresh_failed", "warn", "preRefresh 脚本失败，照常刷新"),
    ("refresh_deferred", "info", "使用方正忙，推迟刷新"),
    ("refresh_defer_ended", "info/warn", "推迟结束；因 floor / max_defer / gate_failed 结束时为 warn"),
    ("keychain_split", "error", "keychain 里有该凭证的条目，拒绝刷新"),
    ("keychain_gate_unavailable", "error", "看不到 login keychain，分裂检查失效"),
    ("legacy_lock_stale", "error/critical", "陈旧的旧 cron 锁卡住刷新，需人工删除"),
    ("contract_drift", "error", "claude 二进制里找不到预期的 client_id / 接口 / 请求头"),
    ("usage_high", "warn", "5 小时窗口用量偏高（利用率或外推值超阈值）"),
    ("usage_locked", "error", "已被限流锁定"),
    ("alert_undelivered", "error", "告警脚本重试后仍失败"),
    ("fleet_unreachable", "warn", "Redis 不可达，跨机同步暂停（每小时最多一次）"),
    ("fleet_config_error", "error", "fleet 配置无法启用（如密钥文件缺失），只按单机运行"),
    ("fleet_published", "info", "本机号已发布到机队（指纹变化时记录）"),
    ("mirror_updated", "info", "镜像副本已更新"),
    ("mirror_stale", "warn", "镜像副本迟迟未更新"),
    ("mirror_expiring", "error", "镜像副本快过期且未更新，使用它的 bot 将失效"),
    ("mirror_unreadable", "error", "Redis 里的值解密失败（密钥不一致或被篡改）"),
    ("mirror_write_failed", "error", "镜像副本写入失败"),
    ("mirror_hook_failed", "critical", "镜像钩子（onUpdated / onStale）失败"),
    ("heartbeat", "info", "每日汇总"),
]

def lvls(s):
    return " ".join(lvl(x) for x in s.split("/"))

OPS = f"""
<h2>事件与告警等级</h2>
<p>所有事件都写进 <code>state.db</code>，可用 <code>/v1/events</code> 查询；达到 <code>alert.minLevel</code> 的才投递给告警脚本。同一问题在一个「事件期」内只告警一次，账号恢复健康后重新计。</p>
<table>
<tr><th>事件</th><th>级别</th><th>含义</th></tr>
{''.join(row(f"<code>{t}</code>", lvls(l), d) for t, l, d in EVENTS)}
</table>

<h2>常见问题</h2>
<h3>账号进入 <code>dead</code></h3>
<p>RT 已失效（过期、被别的进程用掉、或被吊销）。只能在该账号的配置目录里人工 <code>/login</code>；登录后发布文件变新，服务会自动收编并恢复。RT 有固定到期时间（刷新不顺延），<code>rt_expiring</code> 会提前 <code>rtWarnDays</code> 天每天提醒。</p>

<h3>账号进入 <code>critical</code></h3>
<p>看 <code>/v1/accounts/&lt;id&gt;</code> 的最近事件。若是 <code>pending_unresolved</code>，按提示用 <code>cred-keeper pending &lt;id&gt; apply|discard --confirm &lt;id&gt;</code> 处理；<strong>不确定时不要 discard</strong>，它可能持有唯一有效的 RT。</p>

<h3>刷新后 bot 报认证失败</h3>
<p>刷新立刻作废旧 AT。检查 <code>hook_ok</code> / <code>hook_failed</code>：钩子没成功 suspend，bot 就还拿着旧 AT。配置 <code>preRefresh</code> 可以避免在 bot 回复中途刷新。</p>

<h3>镜像 <code>freshness</code> 不是 ok</h3>
<ul>
  <li><code>missing</code>：还没同步到。查 <code>/v1/fleet</code> 的 <code>lastError</code>（<code>not published</code> = 生产者还没发布；<code>redis: …</code> = 连不上 Redis）。</li>
  <li><code>warn</code> / <code>error</code>：副本快过期但没收到更新。先看生产者那台的账号状态（是否刷新失败、是否被推迟），再看两边能否连到 Redis。可以 <code>cred-keeper fleet-sync</code> 手动拉一次。</li>
</ul>

<h3>收不到用量预警</h3>
<p><code>usage_high</code> 是 warn 级别，默认 <code>minLevel=error</code> 时不投递。调低 <code>minLevel</code>，或者看用量看板。</p>

<h2>维护注意</h2>
<ul>
  <li><strong>强制刷新会吊销当前 AT</strong>：<code>refresh --force</code> 之后，所有使用方都必须换上新凭证。</li>
  <li><strong>不要把凭证文件复制到别处「试一下」</strong>：那就是一次真刷新，会让原主机的 RT 失效。</li>
  <li>升级后看一眼 <code>/healthz</code> 与 <code>/v1/accounts</code>：指纹不变、状态 ok 即可。</li>
  <li>机队模式回滚：删掉 <code>fleet</code> 段即可回到单机；无需重启。</li>
</ul>

<h2>测试</h2>
<pre><code>npm test                                        # node:test + 假 OAuth 服务器 + 假 Redis，不访问网络
CK_CLAUDE_BINARY=/path/to/claude.exe npm test   # 另外检查真实二进制里的契约字符串（只读）</code></pre>
"""

PAGES = {
    "index": ("多账号 Claude OAuth 凭证的刷新、用量监控，以及跨机器共享。", INDEX),
    "quickstart": ("从零装好 cred-keeper，跑起来，再装成开机自启的服务。", QUICK),
    "concepts": ("一次刷新经历了什么，以及 cred-keeper 如何保证不丢唯一的 refresh token。", CONCEPTS),
    "config": ("config.json 的全部字段、默认值与示例。", CONFIG),
    "hooks": ("cred-keeper 与使用方之间唯一的接入点：三类脚本的调用约定。", HOOKS),
    "fleet": ("多台机器通过一个 Redis 共享账号：每台只刷新自己的号，bot 可以用任何机器的号。", FLEET),
    "api": ("只读 REST 接口、Prometheus 指标、用量看板与命令行。", API),
    "ops": ("事件与告警等级、常见问题的处理方法、维护注意事项。", OPS),
}

for key, (lead, body) in PAGES.items():
    with open(os.path.join(HERE, f"{key}.html"), "w", encoding="utf-8") as f:
        f.write(page(key, lead, body))
print("built", ", ".join(f"{k}.html" for k in PAGES))
