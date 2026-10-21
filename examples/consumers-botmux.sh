#!/bin/bash
# consumers.script for a botmux host: which bot uses which credential file.
# A claude-code bot with `credentialsSourceDir` <d> uses <d>/claude/.credentials.json; one
# without it uses the machine's login (~/.claude/.credentials.json). Other CLIs are skipped.
# Prints only appId, bot name and path (bots.json also holds app secrets: never print it whole).
# Absolute paths only: cred-keeper runs scripts with a minimal PATH.
set -u
NODE="${NODE:-$(command -v node)}"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found (set NODE)" >&2; exit 127; }
exec "$NODE" -e '
  const fs = require("fs"), path = require("path"), home = process.env.HOME;
  const dir = process.env.BOTMUX_HOME || path.join(home, ".botmux");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
  const raw = read("bots.json");
  const bots = Array.isArray(raw) ? raw : (raw.bots ?? Object.values(raw));
  let names = {};
  try { for (const b of read("data/bots-info.json")) names[b.larkAppId] = b.botName; } catch {}
  const norm = (p) => path.resolve(p.replace(/^~(?=\/|$)/, home));
  const out = [];
  for (const b of bots) {
    const id = b && (b.larkAppId ?? b.appId);
    if (!id || (b.cliId && b.cliId !== "claude-code")) continue;
    const src = typeof b.credentialsSourceDir === "string" && b.credentialsSourceDir
      ? path.join(norm(b.credentialsSourceDir), "claude", ".credentials.json")
      : path.join(home, ".claude", ".credentials.json");
    out.push({ id, name: names[id] || b.name || id, credentialPath: src });
  }
  process.stdout.write(JSON.stringify(out));
'
