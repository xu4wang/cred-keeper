#!/bin/bash
# onRefreshed hook for a dedicated account used by specific botmux bots
# (bots configured with `credentialsSourceDir`, botmux PR #1575).
# No seeding needed: the worker copies the source on every cold spawn.
# Absolute paths only: cred-keeper runs hooks with a minimal PATH.
set -u
NODE="${NODE:-$(command -v node)}"
# botmux's entry point: the `…/cli.js` path in ~/.botmux/bin/botmux (quoted or not — the wrapper's
# format changes between botmux versions). Machine-specific; override with BOTMUX_CLI.
BOTMUX_CLI="${BOTMUX_CLI:-$(grep -oE '"[^"]*/cli\.js"|'"'"'[^'"'"']*/cli\.js'"'"'|[^[:space:]"'"'"']+/cli\.js' "$HOME/.botmux/bin/botmux" 2>/dev/null | head -1 | tr -d "\"'")}"
BOTS=(cli_aaaa cli_bbbb)   # ← the appIds using this account
if [ -z "$NODE" ] || [ ! -x "$NODE" ] || [ -z "$BOTMUX_CLI" ] || [ ! -f "$BOTMUX_CLI" ]; then echo "node/botmux not found (set NODE / BOTMUX_CLI)" >&2; exit 127; fi
rc=0
for app in "${BOTS[@]}"; do
  "$NODE" "$BOTMUX_CLI" suspend --bot "$app" || { echo "suspend failed: $app" >&2; rc=1; }
done
exit $rc
