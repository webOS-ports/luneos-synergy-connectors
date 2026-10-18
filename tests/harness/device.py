"""Talk to a LuneOS device over adb: shell, luna-send, journal, files.

Facts this module is built around (all observed on a MindPhone, wrynose):
  * `adb shell` returns 0 whatever the remote command did, so every command
    is suffixed with an exit-code marker that is parsed back out.
  * adb hands the command string to the remote sh as-is, so it is passed as a
    single argv element and quoted for the *remote* shell only.
  * luna-send prints the reply as one JSON line; `-w <ms>` is its timeout and
    an unanswered call prints nothing at all.
  * systemd-coredump is not usable on halium kernels ("pipe failed"), so
    crashes are found from the kernel audit line `ANOM_ABEND ... sig=N`.
"""

import json
import re
import shlex
import subprocess
import time

RC_MARK = "__HARNESS_RC="


class DeviceError(Exception):
    pass


class DeviceLost(DeviceError):
    """adb no longer sees the device (USB reset, reboot)."""


LOST_MARKERS = ("not found", "no devices/emulators", "device offline", "closed")


def q(s):
    """Quote one word for the remote POSIX shell."""
    return shlex.quote(s)


class Device:
    def __init__(self, serial, adb="adb", verbose=False):
        self.serial = serial
        self.adb = adb
        self.verbose = verbose

    # -- raw transport ------------------------------------------------------

    def shell(self, cmd, timeout=60, check=False):
        """Run cmd on the device. Returns (rc, stdout)."""
        wrapped = "%s; echo %s$?" % (cmd, RC_MARK)
        if self.verbose:
            print("    $ " + cmd[:300])
        try:
            p = subprocess.run([self.adb, "-s", self.serial, "shell", wrapped],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               timeout=timeout)
        except subprocess.TimeoutExpired:
            raise DeviceError("timeout after %ss: %s" % (timeout, cmd[:200]))
        out = p.stdout.decode("utf-8", "replace").replace("\r\n", "\n")
        rc, out = split_rc(out)
        if rc is None:
            if p.returncode != 0 and any(m in out for m in LOST_MARKERS):
                raise DeviceLost(out.strip()[-200:])
            raise DeviceError("no exit marker: %s" % out[-300:])
        if check and rc != 0:
            raise DeviceError("rc=%d: %s\n%s" % (rc, cmd[:200], out[-500:]))
        return rc, out

    def out(self, cmd, timeout=60):
        return self.shell(cmd, timeout=timeout, check=True)[1]

    def push(self, local, remote, timeout=300):
        p = subprocess.run([self.adb, "-s", self.serial, "push", local, remote],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        if p.returncode != 0:
            raise DeviceError("push %s failed: %s" % (local, p.stdout[-300:]))

    def pull(self, remote, local, timeout=300):
        p = subprocess.run([self.adb, "-s", self.serial, "pull", remote, local],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        if p.returncode != 0:
            raise DeviceError("pull %s failed: %s" % (remote, p.stdout[-300:]))

    def wait_back(self, timeout=180):
        """Block until adb sees the device again; True if it did."""
        try:
            subprocess.run([self.adb, "-s", self.serial, "wait-for-device"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
            return self.shell("true", timeout=30)[0] == 0
        except (subprocess.TimeoutExpired, DeviceError):
            return False

    def forward(self, remote_port):
        """adb-forward a device TCP port to a free host port; returns the host port."""
        p = subprocess.run([self.adb, "-s", self.serial, "forward", "tcp:0", "tcp:%d" % remote_port],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        out = p.stdout.decode().strip()
        if p.returncode != 0 or not out.isdigit():
            raise DeviceError("adb forward tcp:%d failed: %s" % (remote_port, out))
        return int(out)

    def exists(self, path):
        return self.shell("test -e %s" % q(path))[0] == 0

    def read_json(self, path):
        rc, out = self.shell("cat %s" % q(path))
        if rc != 0:
            return None
        return json.loads(out)

    # -- luna bus -----------------------------------------------------------

    def luna(self, uri, payload=None, app_id=None, timeout_ms=10000):
        """One luna-send call. Returns the parsed reply, or None on no reply."""
        cmd = "luna-send -n 1 -w %d" % timeout_ms
        if app_id:
            cmd += " -a %s" % q(app_id)
        cmd += " %s %s" % (q(uri), q(json.dumps(payload or {})))
        _, out = self.shell(cmd, timeout=timeout_ms / 1000 + 30)
        return parse_luna_reply(out)

    def service_state(self, name, timeout_ms=8000):
        """'up', 'missing' (hub has no service file), or 'noreply'.

        Probes a method that cannot exist: a live service answers
        "Unknown method", an unknown name gives "Service does not exist", and a
        service that crashes during activation gives no reply at all.
        """
        r = self.luna("luna://%s/__harness_probe__" % name, timeout_ms=timeout_ms)
        if r is None:
            return "noreply"
        text = r.get("errorText", "")
        if "Service does not exist" in text:
            return "missing"
        return "up"

    # -- logs / crashes -----------------------------------------------------

    def journal_cursor(self):
        out = self.out("journalctl -b -n 0 --show-cursor --no-pager")
        m = re.search(r"-- cursor: (\S+)", out)
        if not m:
            raise DeviceError("no journal cursor: %s" % out[-200:])
        return m.group(1)

    def journal_since(self, cursor, grep=None, timeout=60):
        cmd = "journalctl --no-pager -o short-monotonic --after-cursor=%s" % q(cursor)
        if grep:
            cmd += " | grep -aiE %s" % q(grep)
        return self.shell(cmd, timeout=timeout)[1]

    def crashes_since(self, cursor):
        return parse_crashes(self.journal_since(cursor, grep="ANOM_ABEND"))

    def pids(self, pattern):
        _, out = self.shell("pgrep -f %s" % q(pattern))
        return [int(x) for x in out.split() if x.isdigit()]

    def wait_for(self, fn, timeout, interval=2.0):
        """Poll fn() until it returns truthy or timeout; returns last value."""
        deadline = time.time() + timeout
        val = fn()
        while not val and time.time() < deadline:
            time.sleep(interval)
            val = fn()
        return val


# -- pure parsers (unit-tested in selftest/) ---------------------------------

def split_rc(out):
    idx = out.rfind(RC_MARK)
    if idx < 0:
        return None, out
    tail = out[idx + len(RC_MARK):].strip()
    m = re.match(r"(\d+)", tail)
    if not m:
        return None, out
    return int(m.group(1)), out[:idx]


def parse_luna_reply(out):
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


SIGNALS = {4: "SIGILL", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 11: "SIGSEGV"}


def parse_crashes(journal_text):
    """[{'pid', 'comm', 'exe', 'signal'}] from audit ANOM_ABEND lines."""
    seen = {}
    for line in journal_text.splitlines():
        if "ANOM_ABEND" not in line:
            continue
        pid = re.search(r"\bpid=(\d+)", line)
        sig = re.search(r"\bsig=(\d+)", line)
        if not pid or not sig:
            continue
        comm = re.search(r'comm="([^"]*)"', line)
        exe = re.search(r'exe="([^"]*)"', line)
        seen[pid.group(1)] = {
            "pid": int(pid.group(1)),
            "comm": comm.group(1) if comm else "?",
            "exe": exe.group(1) if exe else "?",
            "signal": SIGNALS.get(int(sig.group(1)), "sig%s" % sig.group(1)),
        }
    return list(seen.values())
