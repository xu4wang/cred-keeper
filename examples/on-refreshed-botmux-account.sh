#!/bin/bash
# onRefreshed hook for a dedicated account used by specific botmux bots
# (bots configured with `credentialsSourceDir`, botmux PR #1575).
# No seeding needed: the worker copies the source on every cold spawn.
set -u
BOTMUX_BIN="${BOTMUX_BIN:-$HOME/.botmux/bin/botmux}"
BOTS=(cli_aaaa cli_bbbb)   # ← the appIds using this account
rc=0
for app in "${BOTS[@]}"; do
  "$BOTMUX_BIN" suspend --bot "$app" || { echo "suspend failed: $app" >&2; rc=1; }
done
exit $rc
