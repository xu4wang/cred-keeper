#!/bin/bash
# Minimal alert script: deliver cred-keeper alerts as a Feishu/Lark DM via lark-cli (bot identity),
# same channel as the legacy cron script. Independent of the Claude credentials being alerted on.
# Fill in the three values below. No defaults on purpose: a wrong default once sent alerts to the wrong person.
# cred-keeper passes only CK_* variables (plus PATH/HOME) to scripts, so configure here, not in the environment.
set -u
ALERT_APP=""   # bot appId whose lark-cli config (~/.lark-cli-bots/<appId>) sends the message
ALERT_TO=""    # recipient open_id
LARK_CLI=""    # absolute path to lark-cli (a node script)
NODE="${NODE:-$(command -v node)}"   # renders the message; lark-cli is also run with node explicitly
if [ -z "$ALERT_APP" ] || [ -z "$ALERT_TO" ] || [ -z "$LARK_CLI" ] || [ -z "$NODE" ]; then
  echo "alert-lark.sh is not configured (ALERT_APP / ALERT_TO / LARK_CLI / node)" >&2; exit 2
fi
HOSTTAG="${HOSTTAG:-$(/bin/hostname -s 2>/dev/null || echo host)}"

# Event JSON on stdin → a human-readable message (no JSON dump).
text="$(HOSTTAG="$HOSTTAG" "$NODE" -e '
let raw = ""; process.stdin.on("data", (c) => raw += c).on("end", () => {
  let ev = {}; try { ev = JSON.parse(raw); } catch {}
  const icon = { critical: "🔴", error: "🟠", warn: "🟡" }[ev.level] ?? "🟢";
  const d = ev.data ?? {};
  const lines = [`${icon}【${process.env.HOSTTAG}】${ev.title ?? ev.type ?? "cred-keeper"}`];
  const pct = (v) => (v === null || v === undefined ? "–" : `${v}%`);
  const fmtMin = (m) => (m === null || m === undefined ? "–" : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`);
  if (ev.type === "heartbeat" && Array.isArray(d.accounts)) {
    for (const a of d.accounts) {
      const mark = a.state === "ok" ? "✅" : "⚠️";
      lines.push(`${mark} ${a.id}  ${a.state} · AT 剩 ${fmtMin(a.atLeftMin)} · RT 剩 ${a.rtLeftDays ?? "–"} 天 · 用量 5h ${pct(a.fiveHour)} / 7d ${pct(a.sevenDay)}`);
    }
  } else {
    if (ev.account) lines.push(`账号：${ev.account}`);
    const labels = { reason: "原因", leftMin: "AT 剩余(分钟)", leftDays: "剩余天数", rtExpiresAt: "RT 截止", status: "HTTP", errorKind: "错误类型",
      error: "错误", service: "keychain 条目", hint: "处理", likelyCause: "可能原因", window: "窗口", value: "用量", projected: "预测",
      resetsAt: "重置时间", from: "恢复自", code: "退出码", timedOut: "超时", attempts: "尝试次数", missing: "缺失", binary: "二进制",
      failures: "连续失败", pendingPath: "pending 文件", dir: "目录", fingerprint: "指纹" };
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || v === "") continue;
      lines.push(`${labels[k] ?? k}：${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  }
  lines.push(`事件 ${ev.type ?? "?"} · #${ev.eventId ?? "?"}`);
  process.stdout.write(lines.join("\n").slice(0, 3000));
});')"
[ -n "$text" ] || text="【${HOSTTAG}】${CK_TITLE:-cred-keeper alert} (${CK_EVENT:-?})"

LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$ALERT_APP" \
  /usr/bin/perl -e 'alarm 30; exec @ARGV' "$NODE" "$LARK_CLI" im +messages-send --as bot --user-id "$ALERT_TO" --text "$text" >/dev/null
