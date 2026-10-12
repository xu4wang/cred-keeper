#!/bin/bash
# preRefresh gate for a botmux host: defer the refresh while a bot using this
# account is in the middle of a turn. A refresh revokes the old access token at
# once, so a turn in flight at that moment fails (provider_authentication_failed).
# Exit 75 = busy, defer; exit 0 = idle, refresh now; anything else = gate failed
# (cred-keeper refreshes anyway and reports pre_refresh_failed).
# cred-keeper still refreshes when the AT is within redMin, or after
# preRefreshMaxDeferMin of deferring, whatever this script says.
#
# Busy = `botmux suspend --dry-run` would queue the session ("将排队"), i.e. the
# daemon reports it as working/analyzing. Read-only: --dry-run suspends nothing.
# Absolute paths only: cred-keeper runs scripts with a minimal PATH.
set -u
NODE="${NODE:-$(command -v node)}"
BOTMUX_CLI="${BOTMUX_CLI:-$(grep -oE '"[^"]*\.[mc]?js"|'"'"'[^'"'"']*\.[mc]?js'"'"'|[^[:space:]"'"'"']+\.[mc]?js' "$HOME/.botmux/bin/botmux" 2>/dev/null | head -1 | tr -d "\"'")}"
BOTS=()   # ← appIds using this account; empty = every session on the host (the shared default account)
if [ -z "$NODE" ] || [ ! -x "$NODE" ] || [ -z "$BOTMUX_CLI" ] || [ ! -f "$BOTMUX_CLI" ]; then echo "node/botmux not found (set NODE / BOTMUX_CLI)" >&2; exit 127; fi
check() {
  local out s
  out="$("$NODE" "$BOTMUX_CLI" suspend "$@" --dry-run 2>&1)"; s=$?
  # A dry-run exits 0 whenever it could judge the sessions; anything else is a gate
  # failure, never "idle" (cred-keeper then refreshes and reports pre_refresh_failed).
  if [ $s -ne 0 ]; then echo "dry-run failed (rc=$s): ${out:0:300}" >&2; exit 1; fi
  if printf '%s\n' "$out" | grep -q '将排队'; then
    printf '%s\n' "$out" | grep '将排队'
    return 0
  fi
  return 1
}
busy=0
if [ ${#BOTS[@]} -eq 0 ]; then
  check all && busy=1
else
  for app in "${BOTS[@]}"; do check --bot "$app" && busy=1; done
fi
[ $busy -eq 1 ] && exit 75
exit 0
