#!/bin/bash
# One script for all three fleet mirror hooks on a botmux host (onUpdated / busyCheck / onStale).
# The bots it acts on are found, not listed: every bot in ~/.botmux/bots.json whose
# `credentialsSourceDir` is this mirror's account dir (the credential file's grandparent,
# e.g. ~/accounts/tian for ~/accounts/tian/claude/.credentials.json). So moving a bot to
# another account is only a bots.json change; nothing here needs editing.
#
#   CK_EVENT=busy_check     exit 75 if any of those bots is mid-turn (`suspend --dry-run` would queue), else 0
#   CK_EVENT=mirror_updated write the new credential into each of their copies
#                           (~/.botmux/bots/<appId>/claude/.credentials.json — what botmux copies on a
#                           cold start; a running Claude Code re-reads it), then suspend them as a fallback
#   CK_EVENT=mirror_stale   suspend them too (the copy is about to expire without an update; the alert says why)
#
# Absolute paths only: cred-keeper runs hooks with a minimal PATH.
set -u
NODE="${NODE:-$(command -v node)}"
BOTMUX_CLI="${BOTMUX_CLI:-$(grep -oE '"[^"]*\.[mc]?js"|'"'"'[^'"'"']*\.[mc]?js'"'"'|[^[:space:]"'"'"']+\.[mc]?js' "$HOME/.botmux/bin/botmux" 2>/dev/null | head -1 | tr -d "\"'")}"
BOTS_JSON="${BOTS_JSON:-$HOME/.botmux/bots.json}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ] || [ -z "$BOTMUX_CLI" ] || [ ! -f "$BOTMUX_CLI" ]; then echo "node/botmux not found (set NODE / BOTMUX_CLI)" >&2; exit 127; fi
ACCOUNT_DIR="$(dirname "$(dirname "$CK_CREDENTIAL_PATH")")"

BOTS=()
while IFS= read -r app; do [ -n "$app" ] && BOTS+=("$app"); done < <("$NODE" -e '
  const fs = require("fs"), path = require("path"), home = process.env.HOME;
  const [file, dir] = process.argv.slice(1);
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const bots = Array.isArray(raw) ? raw : (raw.bots ?? Object.values(raw));
  const norm = (p) => path.resolve(p.replace(/^~(?=\/|$)/, home));
  for (const b of bots) {
    const src = b && b.credentialsSourceDir;
    if (typeof src === "string" && norm(src) === norm(dir)) console.log(b.larkAppId ?? b.appId);
  }' "$BOTS_JSON" "$ACCOUNT_DIR") || { echo "cannot read $BOTS_JSON" >&2; exit 1; }

if [ ${#BOTS[@]} -eq 0 ]; then echo "no bot uses $ACCOUNT_DIR"; exit 0; fi

case "${CK_EVENT:-}" in
  busy_check)
    for app in "${BOTS[@]}"; do
      out="$("$NODE" "$BOTMUX_CLI" suspend --bot "$app" --dry-run 2>&1)"; s=$?
      # Only a judged dry-run counts; a failure is a failed check (exit 1), never "idle".
      if [ $s -ne 0 ]; then echo "dry-run failed for $app (rc=$s): ${out:0:300}" >&2; exit 1; fi
      if printf '%s\n' "$out" | grep -q '将排队'; then printf '%s\n' "$out" | grep '将排队'; exit 75; fi
    done
    exit 0 ;;
  mirror_updated|mirror_stale)
    rc=0
    # Seed first: a session stuck "replying" never takes the suspend, and its copy would keep the
    # revoked token (Claude Code then empties it → "Login expired" on every turn).
    # Never step back: a valid copy expiring no earlier than the new one is left alone.
    # A copy that is not there yet (bot never started) is left to botmux's cold-start copy.
    if [ "$CK_EVENT" = mirror_updated ]; then
      "$NODE" -e '
        const fs = require("fs"), path = require("path");
        const [src, root, ...apps] = process.argv.slice(1);
        const text = fs.readFileSync(src, "utf-8");
        const parse = (t) => { try { const o = JSON.parse(t).claudeAiOauth;
          return o && o.accessToken && o.refreshToken && Number.isFinite(o.expiresAt) ? o : null; } catch { return null; } };
        const fresh = parse(text);
        if (!fresh) { console.error("refusing to seed: " + src + " is not a usable credential"); process.exit(3); }
        let rc = 0;
        for (const app of apps) {
          const dst = path.join(root, app, "claude", ".credentials.json");
          let cur;
          try { cur = fs.readFileSync(dst, "utf-8"); } catch (e) {
            if (e.code === "ENOENT") { console.log("skip " + app + " (no copy yet)"); continue; }
            console.error("seed failed: " + app + ": " + e.message); rc = 1; continue;
          }
          if (cur === text) { console.log("skip " + app + " (already current)"); continue; }
          const c = parse(cur);
          if (c && c.expiresAt >= fresh.expiresAt) { console.log("skip " + app + " (copy is not older)"); continue; }
          const tmp = dst + ".tmp." + process.pid;
          try {
            fs.writeFileSync(tmp, text, { mode: 0o600 });
            fs.renameSync(tmp, dst);
            if (fs.readFileSync(dst, "utf-8") !== text) throw new Error("content differs after write");
            console.log("seeded " + app + (c ? "" : " (copy was empty or unusable)"));
          } catch (e) {
            try { fs.unlinkSync(tmp); } catch {}
            console.error("seed failed: " + app + ": " + e.message); rc = 1;
          }
        }
        process.exit(rc);
      ' "$CK_CREDENTIAL_PATH" "$HOME/.botmux/bots" "${BOTS[@]}" || rc=1
    fi
    for app in "${BOTS[@]}"; do
      "$NODE" "$BOTMUX_CLI" suspend --bot "$app" || { echo "suspend failed: $app" >&2; rc=1; }
    done
    exit $rc ;;
  *) echo "unexpected CK_EVENT=${CK_EVENT:-}" >&2; exit 2 ;;
esac
