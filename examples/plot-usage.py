#!/usr/bin/env python3
"""Plot each account's 5-hour and 7-day usage (%) over time from cred-keeper's REST API.

    python3 plot-usage.py [--base http://127.0.0.1:8790] [--since 7d] [--out usage.png]
                          [--extra-db other/state.db ...]

Only the read-only API is used (/v1/accounts, /v1/accounts/<id>/usage/history), so it
works against a remote instance too (e.g. behind the nginx reverse proxy).
`--extra-db` merges usage rows from another cred-keeper data dir's state.db (read-only),
e.g. a test instance that ran before the service took over.
Needs matplotlib (pip install matplotlib).
"""
import argparse
import json
import os
import sqlite3
import urllib.request
from datetime import datetime, timezone

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

# Categorical slots in fixed order (entity → color never depends on rank).
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
TEXT, MUTED, GRID = "#1a1a19", "#6b6a63", "#e6e5df"
CJK_FONTS = ["PingFang SC", "Hiragino Sans GB", "STHeiti", "Noto Sans CJK SC", "WenQuanYi Zen Hei"]


def get_json(base, path):
    # Local instances must not go through a system proxy (e.g. Clash returns 502 for 127.0.0.1).
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(base.rstrip("/") + path, timeout=15) as r:
        return json.load(r)


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def since_to_iso(s):
    """Same grammar as the API's `since`: <n>m / <n>h / <n>d, or an ISO timestamp."""
    import re
    from datetime import timedelta
    m = re.fullmatch(r"(\d+)([mhd])", s)
    if m:
        unit = {"m": "minutes", "h": "hours", "d": "days"}[m.group(2)]
        t = datetime.now(timezone.utc) - timedelta(**{unit: int(m.group(1))})
    else:
        t = parse_ts(s).astimezone(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def account_label(acc):
    """Display name: local part of the logged-in email, from the claude config next to the
    account's credential file (same resolution as claude: ~/.claude → ~/.claude.json,
    CLAUDE_CONFIG_DIR=<d> → <d>/.claude.json). Falls back to the account id."""
    cred = acc.get("credentialPath") or ""
    d = os.path.dirname(cred)
    cfg = os.path.expanduser("~/.claude.json") if d == os.path.expanduser("~/.claude") else os.path.join(d, ".claude.json")
    try:
        with open(cfg) as f:
            email = (json.load(f).get("oauthAccount") or {}).get("emailAddress") or ""
        return email.split("@")[0] or acc["id"]
    except (OSError, ValueError):
        return acc["id"]


def minute(ts):
    return parse_ts(ts).replace(second=0, microsecond=0) if ts else None


def rows_from_db(path, since_iso):
    con = sqlite3.connect(f"file:{os.path.expanduser(path)}?mode=ro", uri=True)
    try:
        for account, at, payload in con.execute(
                "SELECT account, at, payload FROM usage WHERE at >= ? ORDER BY at", (since_iso,)):
            yield account, at, json.loads(payload)
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("CK_BASE", "http://127.0.0.1:8790"))
    ap.add_argument("--since", default="7d", help="e.g. 24h / 7d / an ISO timestamp")
    ap.add_argument("--out", default="usage.png")
    ap.add_argument("--extra-db", action="append", default=[])
    ap.add_argument("--label", action="append", default=[], metavar="ID=NAME",
                    help="display name for an account (default: email local part when readable locally)")
    a = ap.parse_args()

    acc_info = get_json(a.base, "/v1/accounts")
    accounts = [x["id"] for x in acc_info]
    labels = {x["id"]: account_label(x) for x in acc_info}
    labels.update(dict(kv.split("=", 1) for kv in a.label))
    series = {acc: {} for acc in accounts}  # acc -> {at: payload}; keyed by time to dedupe merges
    for acc in accounts:
        for row in get_json(a.base, f"/v1/accounts/{acc}/usage/history?since={a.since}"):
            series[acc][row["at"]] = row["payload"]
    cutoff = since_to_iso(a.since)
    for db in a.extra_db:
        for acc, at, payload in rows_from_db(db, cutoff):
            if acc in series:
                series[acc].setdefault(at, payload)

    installed = {f.name for f in font_manager.fontManager.ttflist}
    plt.rcParams["font.sans-serif"] = [f for f in CJK_FONTS if f in installed] + ["DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False

    local_tz = datetime.now().astimezone().tzinfo
    now = datetime.now(timezone.utc)
    fmt = lambda t: t.astimezone(local_tz).strftime("%m-%d %H:%M")  # noqa: E731
    fig, axes = plt.subplots(2, 1, figsize=(12, 7.5), sharex=True, dpi=150)
    panels = [("fiveHour", "5 小时窗口用量"), ("sevenDay", "7 天窗口用量")]
    x_min, x_max = None, now
    # Resets seen in the data (resetsAt values already in the past) and the next one per account/window.
    resets = {}
    for key, _ in panels:
        for acc in accounts:
            seen = sorted({minute(p[key].get("resetsAt")) for p in series[acc].values()
                           if p.get(key) and p[key].get("resetsAt")})
            past = [t for t in seen if t <= now]
            future = [t for t in seen if t > now]
            resets[(key, acc)] = (past, future[-1] if future else None)
            if key == "fiveHour" and future:  # 5h resets are near: extend the axis to show the next one
                x_max = max(x_max, future[-1])
    for acc in accounts:
        for at in series[acc]:
            x_min = min(x_min or parse_ts(at), parse_ts(at))

    for ax, (key, title) in zip(axes, panels):
        ax.set_ylim(0, 100)
        ends = []  # (y, x, text) for the end-of-line labels, de-overlapped below
        notes = []
        for i, acc in enumerate(accounts):
            color = SERIES[i % len(SERIES)]
            name = labels.get(acc, acc)
            pts = sorted(series[acc].items())
            xs = [parse_ts(at).astimezone(local_tz) for at, p in pts if p.get(key)]
            ys = [p[key]["utilization"] for at, p in pts if p.get(key)]
            past, nxt = resets[(key, acc)]
            for t in past:  # past resets inside the plotted range: thin dotted line in the series color
                if x_min and t >= x_min:
                    ax.axvline(t, color=color, linewidth=1, linestyle=":", alpha=0.8)
                    ax.text(t, 97 - 7 * i, f"重置 {t.astimezone(local_tz):%H:%M}", color=TEXT, fontsize=8,
                            ha="right", va="top", rotation=0,
                            bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.8))
            if nxt and nxt <= x_max:
                ax.axvline(nxt, color=color, linewidth=1.2, linestyle="--")
                ax.text(nxt, 97 - 7 * i, f"下次重置 {fmt(nxt)}", color=TEXT, fontsize=8, ha="right", va="top",
                        bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.8))
            label = name + (f"（下次重置 {fmt(nxt)}）" if nxt else "")
            if not xs:
                continue
            ax.plot(xs, ys, color=color, linewidth=2, label=label, solid_capstyle="round")
            ends.append([ys[-1], xs[-1], f"{name} {ys[-1]:.0f}%"])
        # Spread labels that would collide: keep at least MIN_GAP (in %) between neighbours.
        MIN_GAP = 6
        ends.sort(key=lambda e: e[0])
        placed = []
        for y, x, text in ends:
            placed.append(max(y, placed[-1] + MIN_GAP) if placed else y)
        for (y, x, text), ly in zip(ends, placed):
            dy = (ax.transData.transform((0, ly))[1] - ax.transData.transform((0, y))[1]) * 72 / fig.dpi
            ax.annotate(text, (x, y), xytext=(6, dy), textcoords="offset points", va="center",
                        fontsize=9, color=TEXT, annotation_clip=False,
                        bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.85))
        ax.set_title(title, loc="left", fontsize=12, color=TEXT)
        ax.set_ylabel("用量 %", color=MUTED)
        ax.grid(axis="y", color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        for side in ("left", "bottom"):
            ax.spines[side].set_color(GRID)
        ax.tick_params(colors=MUTED, labelsize=9)
        # Legend sits on the title line (outside the plot) so it never covers reset markers.
        ax.legend(loc="lower right", bbox_to_anchor=(1.0, 1.0), ncol=len(accounts), frameon=False,
                  fontsize=9, borderaxespad=0.2)
    if x_min:
        axes[-1].set_xlim(x_min.astimezone(local_tz), (x_max + (x_max - x_min) * 0.02).astimezone(local_tz))
    axes[-1].xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M", tz=local_tz))
    fig.autofmt_xdate()
    tzname = datetime.now().astimezone().strftime("UTC%z")
    fig.suptitle(f"Claude 账号用量（cred-keeper，每 10 分钟采样，时间为本机 {tzname}）",
                 x=0.01, ha="left", fontsize=13, color=TEXT)
    fig.tight_layout(rect=(0, 0, 0.97, 0.96))
    fig.savefig(a.out)
    print(a.out)


if __name__ == "__main__":
    main()
