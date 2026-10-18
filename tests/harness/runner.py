"""Test registration, execution and reporting.

A test is a function `fn(ctx, conn)` registered with @test(...). It passes by
returning, fails by raising Fail (or any exception -> ERROR) and opts out with
Skip. Every test runs inside a journal window: any process that dies with a
signal while it runs turns the result into FAIL, whatever the test itself
concluded, because a connector that "works" by crashing the shared transport is
not working.

Known, tracked defects live in known-issues.json. A failing test listed there
is reported XFAIL; one that starts passing is reported XPASS so the entry gets
removed rather than lingering.
"""

import json
import os
import time
import traceback
import xml.etree.ElementTree as ET

from .device import DeviceError, DeviceLost

LEVEL_NAMES = {0: "install", 1: "provision", 2: "live", 3: "ui"}

_REGISTRY = []


class Fail(Exception):
    pass


class Skip(Exception):
    pass


def test(level, families, name=None, once=False):
    """once=True: run a single time per family (shared pieces such as the IM
    transport), with the family's first selected connector as `conn`."""
    def deco(fn):
        _REGISTRY.append({
            "fn": fn, "level": level, "families": tuple(families),
            "name": name or fn.__name__, "once": once,
        })
        return fn
    return deco


def registry():
    return list(_REGISTRY)


class Result:
    def __init__(self, test_id, conn, level, status, detail="", duration=0.0, crashes=None):
        self.test_id = test_id
        self.conn = conn
        self.level = level
        self.status = status
        self.detail = detail
        self.duration = duration
        self.crashes = crashes or []

    def as_dict(self):
        return {
            "id": self.test_id, "connector": self.conn, "level": self.level,
            "status": self.status, "detail": self.detail,
            "duration": round(self.duration, 2), "crashes": self.crashes,
        }


class Context:
    """What a test gets besides its connector."""

    def __init__(self, dev, creds, opts, artifacts_dir):
        self.dev = dev
        self.creds = creds
        self.opts = opts
        self.artifacts = artifacts_dir
        self.cleanups = []
        self.notes = []

    def creds_for(self, conn):
        c = self.creds.get(conn.key)
        if not c:
            raise Skip("no credentials for %s in creds file" % conn.key)
        return c

    def defer(self, fn, *args):
        """Run fn(*args) after the test, pass or fail (LIFO)."""
        self.cleanups.append((fn, args))

    def note(self, msg):
        self.notes.append(msg)

    def run_cleanups(self):
        errs = []
        while self.cleanups:
            fn, args = self.cleanups.pop()
            try:
                fn(*args)
            except Exception as e:  # cleanup must not mask the result
                errs.append("%s: %s" % (getattr(fn, "__name__", fn), e))
        return errs


def load_known_issues(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith("__")}


def match_known(known, test_id):
    """Exact id, or a 'name/*' or '*/connector' wildcard entry."""
    if test_id in known:
        return known[test_id]
    name, _, conn = test_id.partition("/")
    return known.get(name + "/*") or known.get("*/" + conn)


def run(ctx, connectors, levels, known, log=print, crash_watch=True):
    results = []
    for t in sorted(registry(), key=lambda t: t["level"]):
        if t["level"] not in levels:
            continue
        done_families = set()
        for conn in connectors:
            if conn.family not in t["families"]:
                continue
            if t["once"]:
                if conn.family in done_families:
                    continue
                done_families.add(conn.family)
                tid = "%s/%s" % (t["name"], conn.family)
            else:
                tid = "%s/%s" % (t["name"], conn.key)
            r = _run_one(ctx, t, conn, tid, known, log, crash_watch)
            if r.status == "LOST":
                log("  [!] device lost during %s; waiting up to 180 s" % tid)
                if not ctx.dev.wait_back(180):
                    log("  [!] device did not come back; aborting the run. Pending cleanups NOT run: %s"
                        % [getattr(fn, "__name__", fn) for fn, _ in ctx.cleanups])
                    r.status = "ERROR"
                    results.append(r)
                    return results
                for err in ctx.run_cleanups():
                    log("  [warn] cleanup after reconnect: %s" % err)
                r = _run_one(ctx, t, conn, tid, known, log, crash_watch)
                if r.status == "LOST":
                    r.status = "ERROR"
            results.append(r)
    return results


def _run_one(ctx, t, conn, tid, known, log, crash_watch):
    start = time.time()
    cursor = None
    if crash_watch:
        try:
            cursor = ctx.dev.journal_cursor()
        except DeviceLost as e:
            return Result(tid, conn.key, t["level"], "LOST", str(e))
        except DeviceError as e:
            log("  [warn] no journal cursor: %s" % e)
    ctx.notes = []
    status, detail = "PASS", ""
    try:
        t["fn"](ctx, conn)
    except Skip as e:
        status, detail = "SKIP", str(e)
    except DeviceLost as e:
        # cleanups stay queued; run() replays them once the device is back
        return Result(tid, conn.key, t["level"], "LOST", str(e))
    except Fail as e:
        status, detail = "FAIL", str(e)
    except Exception as e:
        status, detail = "ERROR", "%s: %s\n%s" % (type(e).__name__, e, traceback.format_exc(limit=4))
    cleanup_errs = ctx.run_cleanups()
    if cleanup_errs and status == "PASS":
        status, detail = "FAIL", "cleanup failed: " + "; ".join(cleanup_errs)

    crashes = []
    if cursor:
        try:
            crashes = ctx.dev.crashes_since(cursor)
        except DeviceError as e:
            log("  [warn] crash scan failed: %s" % e)
    if crashes and status in ("PASS", "SKIP"):
        status = "FAIL"
        detail = (detail + "; " if detail else "") + "process crashed during test: " + \
            ", ".join("%s(%s) %s" % (c["comm"], c["pid"], c["signal"]) for c in crashes)
    if ctx.notes:
        detail = (detail + " | " if detail else "") + " | ".join(ctx.notes)

    ki = match_known(known, tid)
    if ki:
        reason = ki.get("reason", "") if isinstance(ki, dict) else str(ki)
        if status in ("FAIL", "ERROR"):
            status, detail = "XFAIL", "%s [known: %s]" % (detail, reason)
        elif status == "PASS":
            status, detail = "XPASS", "listed in known-issues.json but passed: " + reason

    r = Result(tid, conn.family if t["once"] else conn.key, t["level"], status, detail, time.time() - start, crashes)
    log("  %-6s %-42s %s" % (status, tid, _one_line(detail)))
    return r


def _one_line(s, n=150):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n - 3] + "..."


# -- reports ------------------------------------------------------------------

def summarize(results):
    counts = {}
    for r in results:
        counts[r.status] = counts.get(r.status, 0) + 1
    return counts


def write_reports(results, outdir, meta):
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "results.json"), "w") as f:
        json.dump({"meta": meta, "summary": summarize(results),
                   "results": [r.as_dict() for r in results]}, f, indent=1)

    suites = ET.Element("testsuites", name="synergy-luneos")
    by_conn = {}
    for r in results:
        by_conn.setdefault(r.conn, []).append(r)
    for conn, rs in by_conn.items():
        s = ET.SubElement(suites, "testsuite", name=conn, tests=str(len(rs)))
        for r in rs:
            tc = ET.SubElement(s, "testcase", classname="L%d.%s" % (r.level, conn),
                               name=r.test_id, time="%.2f" % r.duration)
            if r.status in ("FAIL", "ERROR", "XPASS"):
                ET.SubElement(tc, "failure", message=_one_line(r.detail, 300)).text = r.detail
            elif r.status in ("SKIP", "XFAIL"):
                ET.SubElement(tc, "skipped", message=_one_line(r.detail, 300))
    ET.ElementTree(suites).write(os.path.join(outdir, "junit.xml"),
                                 encoding="utf-8", xml_declaration=True)

    lines = ["Synergy LuneOS test run  %s" % meta.get("started", ""),
             "device: %s  (%s)" % (meta.get("serial"), meta.get("device")), ""]
    for conn, rs in by_conn.items():
        lines.append("== %s" % conn)
        for r in rs:
            lines.append("  %-6s L%d %-40s %s" % (r.status, r.level, r.test_id, _one_line(r.detail, 200)))
    lines += ["", "summary: " + ", ".join("%s=%d" % kv for kv in sorted(summarize(results).items()))]
    with open(os.path.join(outdir, "report.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    return outdir


def exit_code(results):
    bad = [r for r in results if r.status in ("FAIL", "ERROR", "XPASS")]
    return 1 if bad else 0
