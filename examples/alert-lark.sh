#!/bin/bash
# Minimal alert script: deliver cred-keeper alerts as a Feishu/Lark DM via lark-cli (bot identity),
# same channel as the legacy cron script. Independent of the Claude credentials being alerted on.
# Fill in the three values below. No defaults on purpose: a wrong default once sent alerts to the wrong person.
# cred-keeper passes only CK_* variables (plus PATH/HOME) to scripts, so configure here, not in the environment.
set -u
ALERT_APP=""   # bot appId whose lark-cli config (~/.lark-cli-bots/<appId>) sends the message
ALERT_TO=""    # recipient open_id
LARK_CLI=""    # absolute path to lark-cli (a node script)
NODE="${NODE:-$(command -v node)}"   # lark-cli has a `#!/usr/bin/env node` shebang: run it with node explicitly
if [ -z "$ALERT_APP" ] || [ -z "$ALERT_TO" ] || [ -z "$LARK_CLI" ]; then
  echo "alert-lark.sh is not configured (ALERT_APP / ALERT_TO / LARK_CLI)" >&2; exit 2
fi
HOSTTAG="${HOSTTAG:-$(/bin/hostname -s 2>/dev/null || echo host)}"
payload="$(cat)"
# Pretty message: title line + the event data, trimmed.
case "$CK_LEVEL" in critical) icon="🔴";; error) icon="🟠";; warn) icon="🟡";; *) icon="🟢";; esac
text="${icon}【${HOSTTAG}】${CK_TITLE}
${payload:0:1500}"
LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-bots/$ALERT_APP" \
  /usr/bin/perl -e 'alarm 30; exec @ARGV' "$NODE" "$LARK_CLI" im +messages-send --as bot --user-id "$ALERT_TO" --text "$text" >/dev/null
