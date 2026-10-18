#!/usr/bin/env python3
"""Synergy connector tests for LuneOS, driven from the host over adb.

  tests/run.py --serial MST0000022 --level 0,1
  tests/run.py --serial MST0000022 --family im --only telegram,signal --level 2
  tests/run.py --list

Levels: 0 install (static checks, no state change)  1 provision (accounts and
calls with no real credentials, cleaned up)  2 live (real accounts from
creds.local.json)  3 ui (not yet). Results go to build-output/luneos/<stamp>/
as report.txt, results.json and junit.xml. Exit status is non-zero on any
FAIL, ERROR or XPASS.
"""

import argparse
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from harness import manifest, runner  # noqa: E402
from harness.device import Device, DeviceError  # noqa: E402
import suites.common  # noqa: E402,F401  (registers tests)
import suites.im  # noqa: E402,F401
import suites.cloud  # noqa: E402,F401
import suites.music  # noqa: E402,F401


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"), help="adb serial")
    ap.add_argument("--level", default="0,1", help="comma list of levels (default 0,1)")
    ap.add_argument("--family", default="", help="im,cloud,music (default all)")
    ap.add_argument("--only", default="", help="connector keys or template ids")
    ap.add_argument("--creds", default=os.path.join(HERE, "creds.local.json"))
    ap.add_argument("--known", default=os.path.join(HERE, "known-issues.json"))
    ap.add_argument("--out", default=None, help="report directory")
    ap.add_argument("--no-crash-watch", action="store_true")
    ap.add_argument("--list", action="store_true", help="list connectors and tests, then exit")
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


def main(argv=None):
    a = parse_args(argv)
    conns = manifest.load()
    conns = manifest.select(conns, [f for f in a.family.split(",") if f], [o for o in a.only.split(",") if o])
    levels = {int(x) for x in a.level.split(",") if x != ""}

    if a.list:
        for c in conns:
            print("%-6s %-11s %-40s %s" % (c.family, c.key, c.id, c.name))
        print()
        for t in sorted(runner.registry(), key=lambda t: (t["level"], t["name"])):
            print("L%d %-26s %s%s" % (t["level"], t["name"], ",".join(t["families"]),
                                      "  (once per family)" if t["once"] else ""))
        return 0
    if not a.serial:
        print("--serial (or ANDROID_SERIAL) is required", file=sys.stderr)
        return 2

    creds = {}
    if os.path.exists(a.creds):
        with open(a.creds) as f:
            creds = {k: v for k, v in json.load(f).items() if not k.startswith("__")}
    elif 2 in levels:
        print("[warn] %s not found: every L2 test will SKIP" % a.creds)

    dev = Device(a.serial, verbose=a.verbose)
    try:
        ident = dev.out("cat /etc/hostname; getprop ro.product.device 2>/dev/null; uname -m").split()
    except DeviceError as e:
        print("device %s unreachable: %s" % (a.serial, e), file=sys.stderr)
        return 2

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = a.out or os.path.join(manifest.REPO, "build-output", stamp)
    os.makedirs(out, exist_ok=True)
    ctx = runner.Context(dev, creds, {}, out)
    known = runner.load_known_issues(a.known)

    print("device %s: %s | %d connectors | levels %s | report %s"
          % (a.serial, " ".join(ident), len(conns), sorted(levels), out))
    results = runner.run(ctx, conns, levels, known, crash_watch=not a.no_crash_watch)
    meta = {"serial": a.serial, "device": " ".join(ident), "started": stamp,
            "levels": sorted(levels), "connectors": [c.key for c in conns]}
    runner.write_reports(results, out, meta)
    print("\nsummary: " + ", ".join("%s=%d" % kv for kv in sorted(runner.summarize(results).items())))
    print("report:  %s/report.txt" % out)
    return runner.exit_code(results)


if __name__ == "__main__":
    sys.exit(main())
