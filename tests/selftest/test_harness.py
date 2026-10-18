"""Host-only tests for the harness itself: python3 -m unittest discover tests/luneos/selftest"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness import device, manifest, runner  # noqa: E402

# Real lines from a MindPhone journal (2026-10-18), kernel and audit copies of one crash.
ABEND = (
    'Oct 18 11:04:58 mindphone audit[29057]: ANOM_ABEND auid=4294967295 uid=0 gid=0 '
    'ses=4294967295 subj=kernel pid=29057 comm="imlibpurpleserv" exe="/usr/sbin/imlibpurpleservice" sig=7 res=1\n'
    'Oct 18 11:04:58 mindphone kernel: .(0)[157:kauditd]audit: type=1701 audit(1792314298.959:18): '
    'auid=4294967295 uid=0 gid=0 ses=4294967295 subj=kernel pid=29057 comm="imlibpurpleserv" '
    'exe="/usr/sbin/imlibpurpleservice" sig=7 res=1\n'
)


class Parsers(unittest.TestCase):
    def test_split_rc(self):
        self.assertEqual(device.split_rc("hello\n__HARNESS_RC=3\n"), (3, "hello\n"))
        self.assertEqual(device.split_rc("a\n__HARNESS_RC=0"), (0, "a\n"))
        self.assertEqual(device.split_rc("no marker")[0], None)

    def test_split_rc_uses_last_marker(self):
        # output that itself prints the marker text must not fool the parser
        rc, out = device.split_rc("x __HARNESS_RC=9 y\n__HARNESS_RC=1\n")
        self.assertEqual(rc, 1)
        self.assertIn("__HARNESS_RC=9", out)

    def test_luna_reply(self):
        self.assertEqual(device.parse_luna_reply('noise\n{"returnValue":true}\n'), {"returnValue": True})
        self.assertIsNone(device.parse_luna_reply(""))
        self.assertIsNone(device.parse_luna_reply("{broken\n"))

    def test_crashes_dedup_and_signal(self):
        c = device.parse_crashes(ABEND)
        self.assertEqual(len(c), 1)
        self.assertEqual(c[0]["pid"], 29057)
        self.assertEqual(c[0]["signal"], "SIGBUS")
        self.assertEqual(c[0]["exe"], "/usr/sbin/imlibpurpleservice")

    def test_crashes_ignore_other_lines(self):
        self.assertEqual(device.parse_crashes("Oct 18 ls-hubd: pid=1 sig=7 not an abend\n"), [])


class Manifest(unittest.TestCase):
    def test_all_connectors(self):
        music = os.path.expanduser("~/Documents/GitHub/org.webosports.app.music")
        if not os.path.isdir(music):
            self.skipTest("music repo not checked out")
        cs = manifest.load(music=music)
        fam = {}
        for c in cs:
            fam[c.family] = fam.get(c.family, 0) + 1
        self.assertEqual(fam, {"im": 7, "cloud": 12, "music": 9})
        self.assertEqual(len({c.key for c in cs}), 28)

    def test_uris_and_services(self):
        c = [c for c in manifest.load() if c.key == "dropbox"][0]
        self.assertIn("com.palm.service.dropbox", c.services())
        self.assertIn("com.palm.service.photos", c.services())
        self.assertEqual(c.validator_app, "com.palm.app.cloud-auth")

    def test_unknown_template_is_an_error(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"connectors": {}}')
        try:
            with self.assertRaises(ValueError):
                manifest.load(extras_path=f.name)
        finally:
            os.unlink(f.name)


class FakeDev:
    def __init__(self, journal="", lose_times=0):
        self.journal = journal
        self.lose_times = lose_times
        self.waits = 0

    def journal_cursor(self):
        if self.lose_times:
            self.lose_times -= 1
            raise device.DeviceLost("adb: device 'X' not found")
        return "c"

    def crashes_since(self, cursor):
        return device.parse_crashes(self.journal)

    def wait_back(self, timeout):
        self.waits += 1
        return True


class Conn:
    def __init__(self, key, family="im"):
        self.key, self.family, self.id = key, family, "t." + key


class Runner(unittest.TestCase):
    def setUp(self):
        self._saved = list(runner._REGISTRY)
        runner._REGISTRY[:] = []

    def tearDown(self):
        runner._REGISTRY[:] = self._saved

    def _run(self, dev, conns, known=None):
        ctx = runner.Context(dev, {}, {}, tempfile.gettempdir())
        return runner.run(ctx, conns, {0, 1}, known or {}, log=lambda *a: None)

    def test_crash_turns_pass_into_fail(self):
        runner.test(0, ("im",))(lambda ctx, conn: None)
        r = self._run(FakeDev(ABEND), [Conn("a")])
        self.assertEqual(r[0].status, "FAIL")
        self.assertIn("SIGBUS", r[0].detail)

    def test_known_issue_xfail_and_xpass(self):
        def bad(ctx, conn):
            raise runner.Fail("boom")
        runner.test(0, ("im",), name="bad")(bad)
        runner.test(0, ("im",), name="good")(lambda ctx, conn: None)
        known = {"bad/a": {"reason": "tracked"}, "good/*": "stale entry"}
        r = {x.test_id: x.status for x in self._run(FakeDev(), [Conn("a")], known)}
        self.assertEqual(r["bad/a"], "XFAIL")
        self.assertEqual(r["good/a"], "XPASS")
        self.assertEqual(runner.exit_code(self._run(FakeDev(), [Conn("a")], known)), 1)

    def test_once_per_family(self):
        seen = []
        runner.test(0, ("im", "cloud"), name="shared", once=True)(lambda ctx, conn: seen.append(conn.key))
        r = self._run(FakeDev(), [Conn("a"), Conn("b"), Conn("c", "cloud")])
        self.assertEqual(seen, ["a", "c"])
        self.assertEqual([x.test_id for x in r], ["shared/im", "shared/cloud"])

    def test_cleanup_runs_on_failure_and_failing_cleanup_fails_pass(self):
        ran = []

        def t1(ctx, conn):
            ctx.defer(ran.append, "t1")
            raise runner.Fail("x")

        def t2(ctx, conn):
            ctx.defer(lambda: 1 / 0)
        runner.test(0, ("im",), name="t1")(t1)
        runner.test(0, ("im",), name="t2")(t2)
        r = {x.test_id: x for x in self._run(FakeDev(), [Conn("a")])}
        self.assertEqual(ran, ["t1"])
        self.assertEqual(r["t2/a"].status, "FAIL")
        self.assertIn("cleanup failed", r["t2/a"].detail)

    def test_lost_device_is_retried_once(self):
        calls = []
        runner.test(0, ("im",))(lambda ctx, conn: calls.append(1))
        dev = FakeDev(lose_times=1)
        r = self._run(dev, [Conn("a")])
        self.assertEqual(dev.waits, 1)
        self.assertEqual(r[0].status, "PASS")
        self.assertEqual(len(calls), 1)

    def test_skip_and_error(self):
        def sk(ctx, conn):
            raise runner.Skip("nope")

        def er(ctx, conn):
            raise KeyError("k")
        runner.test(0, ("im",), name="sk")(sk)
        runner.test(0, ("im",), name="er")(er)
        r = {x.test_id: x.status for x in self._run(FakeDev(), [Conn("a")])}
        self.assertEqual(r, {"sk/a": "SKIP", "er/a": "ERROR"})

    def test_reports_written(self):
        runner.test(0, ("im",))(lambda ctx, conn: None)
        res = self._run(FakeDev(), [Conn("a")])
        with tempfile.TemporaryDirectory() as d:
            runner.write_reports(res, d, {"serial": "S"})
            self.assertTrue(all(os.path.exists(os.path.join(d, f))
                                for f in ("report.txt", "results.json", "junit.xml")))


if __name__ == "__main__":
    unittest.main()
