#!/bin/bash
# onRefreshed hook for the machine's shared (default) Claude account on a botmux host.
# Equivalent to the legacy bot-cred-refresh-oauth.sh with SEED=1 SUSPEND=1:
#   1. seed per-bot credential copies (and other known consumers) from $CK_CREDENTIAL_PATH
#   2. suspend running botmux sessions so they cold-start with the new token
# cred-keeper runs hooks with a minimal PATH: use absolute paths.
set -u
BOTMUX_BIN="${BOTMUX_BIN:-$HOME/.botmux/bin/botmux}"
SRC="$CK_CREDENTIAL_PATH"
rc=0
for d in "$HOME"/.botmux/bots/*/claude/.credentials.json \
         "$HOME"/.cc-connect/claude/.credentials.json \
         "$HOME"/.lark-channel/claude/.credentials.json; do
  [ -e "$d" ] || continue
  tmp="$d.tmp.$$"
  if cp "$SRC" "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$d"; then
    echo "seeded ${d#$HOME/}"
  else
    rm -f "$tmp"; echo "seed failed: ${d#$HOME/}" >&2; rc=1
  fi
done
# The old AT was revoked at rotation: running sessions must cold-start now.
# `suspend all` returns non-zero when some sessions are merely inactive; that is not a failure.
"$BOTMUX_BIN" suspend all >/dev/null 2>&1 || echo "botmux suspend all returned non-zero (often session_not_active)"
exit $rc
