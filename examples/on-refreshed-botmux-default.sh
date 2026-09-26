#!/bin/bash
# onRefreshed hook for the machine's shared (default) Claude account on a botmux host.
# Equivalent to the legacy bot-cred-refresh-oauth.sh with SEED=1 SUSPEND=1:
#   1. seed per-bot credential copies (and other known consumers) from $CK_CREDENTIAL_PATH
#   2. suspend running botmux sessions so they cold-start with the new token
# Bots that have their own account (bots.json `credentialsSourceDir`, botmux PR #1575)
# are neither seeded nor suspended: their credential comes from their source dir, and
# their own account's hook suspends them.
#
# cred-keeper runs hooks with a minimal PATH. Everything here is called by absolute path;
# NODE defaults to the node running cred-keeper's service (its dir is first on PATH).
set -u
NODE="${NODE:-$(command -v node)}"
# botmux's entry point: the `…/cli.js` path in ~/.botmux/bin/botmux (quoted or not — the wrapper's
# format changes between botmux versions). Machine-specific; override with BOTMUX_CLI.
BOTMUX_CLI="${BOTMUX_CLI:-$(grep -oE '"[^"]*/cli\.js"|'"'"'[^'"'"']*/cli\.js'"'"'|[^[:space:]"'"'"']+/cli\.js' "$HOME/.botmux/bin/botmux" 2>/dev/null | head -1 | tr -d "\"'")}"
BOTS_JSON="${BOTS_JSON:-$HOME/.botmux/bots.json}"
SRC="$CK_CREDENTIAL_PATH"
rc=0

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then echo "node not found (set NODE)" >&2; exit 127; fi
if [ -z "$BOTMUX_CLI" ] || [ ! -f "$BOTMUX_CLI" ]; then echo "botmux cli not found: '$BOTMUX_CLI' (set BOTMUX_CLI)" >&2; exit 127; fi

# Every bot as "own <appId>" (has its own account) or "shared <appId>" (uses this one).
bots_list="$("$NODE" -e '
  try {
    const bots = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
    for (const b of Array.isArray(bots) ? bots : []) if (b && b.larkAppId) console.log((b.credentialsSourceDir ? "own " : "shared ") + b.larkAppId);
  } catch (e) { console.error("cannot read bots.json: " + e.message); process.exit(3); }
' "$BOTS_JSON")" || { echo "refusing to seed: bots.json unreadable" >&2; exit 3; }
own_account="$(printf '%s\n' "$bots_list" | sed -n 's/^own //p')"
shared_bots="$(printf '%s\n' "$bots_list" | sed -n 's/^shared //p')"

seed() {
  local d="$1" tmp="$1.tmp.$$"
  if cp "$SRC" "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$d"; then
    echo "seeded ${d#$HOME/}"
  else
    rm -f "$tmp"; echo "seed failed: ${d#$HOME/}" >&2; rc=1
  fi
}

for d in "$HOME"/.botmux/bots/*/claude/.credentials.json; do
  [ -e "$d" ] || continue
  app="${d#$HOME/.botmux/bots/}"; app="${app%%/*}"
  if printf '%s\n' "$own_account" | grep -qxF "$app"; then echo "skip $app (own account)"; continue; fi
  seed "$d"
done
for d in "$HOME"/.cc-connect/claude/.credentials.json "$HOME"/.lark-channel/claude/.credentials.json; do
  [ -e "$d" ] && seed "$d"
done

# The old AT was revoked at rotation: running sessions must cold-start now.
# No bot has its own account → `suspend all` (also covers sessions of bots missing from
# bots.json). Otherwise suspend only the bots on this shared account, one by one.
# A non-zero exit usually means some sessions were merely inactive;
# but 126/127 means botmux itself could not run — that must fail the hook (→ hook_failed alert).
suspend() {
  local out s
  out="$("$NODE" "$BOTMUX_CLI" suspend "$@" 2>&1)"; s=$?
  if [ $s -eq 126 ] || [ $s -eq 127 ]; then
    echo "botmux suspend could not run (rc=$s): $out" >&2; exit $s
  fi
  [ $s -ne 0 ] && echo "botmux suspend $* rc=$s (usually session_not_active): ${out:0:300}"
  return 0
}
if [ -z "$own_account" ]; then
  suspend all
else
  for app in $shared_bots; do suspend --bot "$app"; done
fi
exit $rc
