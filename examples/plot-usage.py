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
    a = ap.parse_args()

    accounts = [x["id"] for x in get_json(a.base, "/v1/accounts")]
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
    fig, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True, dpi=150)
    panels = [("fiveHour", "5 小时窗口用量"), ("sevenDay", "7 天窗口用量")]
    for ax, (key, title) in zip(axes, panels):
        ends = []  # (y, x, text) for the end-of-line labels, de-overlapped below
        for i, acc in enumerate(accounts):
            pts = sorted(series[acc].items())
            xs = [parse_ts(at).astimezone(local_tz) for at, p in pts if p.get(key)]
            ys = [p[key]["utilization"] for at, p in pts if p.get(key)]
            if not xs:
                continue
            color = SERIES[i % len(SERIES)]
            ax.plot(xs, ys, color=color, linewidth=2, label=acc, solid_capstyle="round")
            ends.append([ys[-1], xs[-1], f"{acc} {ys[-1]:.0f}%"])
        # Spread labels that would collide: keep at least MIN_GAP (in %) between neighbours.
        MIN_GAP = 6
        ends.sort(key=lambda e: e[0])
        placed = []
        for y, x, text in ends:
            placed.append(max(y, placed[-1] + MIN_GAP) if placed else y)
        for (y, x, text), ly in zip(ends, placed):
            ax.set_ylim(0, 100)  # the data→points conversion below needs the final y-scale
            dy = (ax.transData.transform((0, ly))[1] - ax.transData.transform((0, y))[1]) * 72 / fig.dpi
            ax.annotate(text, (x, y), xytext=(6, dy), textcoords="offset points", va="center",
                        fontsize=9, color=TEXT, annotation_clip=False)
        ax.set_title(title, loc="left", fontsize=12, color=TEXT)
        ax.set_ylim(0, 100)
        ax.set_ylabel("用量 %", color=MUTED)
        ax.grid(axis="y", color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        for side in ("left", "bottom"):
            ax.spines[side].set_color(GRID)
        ax.tick_params(colors=MUTED, labelsize=9)
        ax.legend(loc="upper left", frameon=False, fontsize=9)
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
