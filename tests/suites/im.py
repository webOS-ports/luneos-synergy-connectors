"""IM connectors: libpurple plugins bridged by imlibpurpleservice.

All seven networks share one transport process (com.palm.imlibpurple), one
set of db8 kinds and one plugin directory, so a plugin that crashes at load
takes every network down. Kinds and field names are from
imlibpurpleservice inc/IMDefines.h and inc/IMMessage.h.
"""

import os
import re
import subprocess
import tempfile
import time
import uuid

from harness import accounts
from harness.device import q
from harness.runner import Fail, Skip, test

TRANSPORT = "com.palm.imlibpurple"
TRANSPORT_EXE = "/usr/sbin/imlibpurpleservice"
PLUGIN_DIR = "/usr/lib/purple-2"
LOGINSTATE = "com.palm.imloginstate.libpurple:1"
IMMESSAGE = "com.palm.immessage.libpurple:1"
CONTACT = "com.palm.contact.libpurple:1"
LIB_DIRS = ("/usr/lib", "/lib", PLUGIN_DIR)

# An empty password is rejected before login (IMLoginState readCredentials), so
# every setup app stores a sentinel; L1 does the same with one that cannot work.
L1_PASSWORD = "harness-l1-not-a-credential"


# -- L0 ----------------------------------------------------------------------

@test(0, ("im",))
def plugin_present(ctx, conn):
    so = "%s/%s" % (PLUGIN_DIR, conn.extra["plugin"])
    if not ctx.dev.exists(so):
        raise Fail("%s missing (package %s not installed?)" % (so, conn.extra.get("package")))


@test(0, ("im",))
def plugin_libs(ctx, conn):
    """Every DT_NEEDED of the plugin exists on the device.

    The transport dlopens plugins; one with a missing library fails to load
    and the network vanishes without an error in the UI.
    """
    so = "%s/%s" % (PLUGIN_DIR, conn.extra["plugin"])
    if not ctx.dev.exists(so):
        raise Skip("plugin not installed")
    with tempfile.TemporaryDirectory(dir=ctx.artifacts) as td:
        local = os.path.join(td, os.path.basename(so))
        ctx.dev.pull(so, local)
        needed = elf_needed(local)
    missing = []
    for lib in needed:
        if not any(ctx.dev.exists("%s/%s" % (d, lib)) for d in LIB_DIRS):
            missing.append(lib)
    if missing:
        raise Fail("unresolved libraries: " + ", ".join(missing))


def elf_needed(path):
    out = subprocess.run(["readelf", "-d", path], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, check=True).stdout.decode()
    return re.findall(r"\(NEEDED\)\s+Shared library: \[([^\]]+)\]", out)


@test(0, ("im",), once=True)
def transport_starts(ctx, conn):
    """The hub can activate the shared transport and it stays up."""
    st = ctx.dev.service_state(TRANSPORT, timeout_ms=15000)
    if st != "up":
        raise Fail("%s activation: %s" % (TRANSPORT, st))
    time.sleep(5)
    if not ctx.dev.pids(TRANSPORT_EXE):
        raise Fail("%s answered, then exited within 5 s" % TRANSPORT_EXE)


@test(0, ("im",))
def call_service(ctx, conn):
    """A PHONE capability's call service exists (calls bridged into Phone)."""
    phone = [c for c in conn.capabilities if c.get("capability") == "PHONE"]
    if not phone:
        raise Skip("no PHONE capability")
    svc = phone[0]["implementation"].split("//", 1)[1].strip("/")
    st = ctx.dev.service_state(svc)
    if st != "up":
        raise Fail("%s %s" % (svc, st))


# -- L1 ----------------------------------------------------------------------

def _im_cap(conn):
    for c in conn.capabilities:
        if c.get("capability") == "MESSAGING":
            return c
    raise Fail("template has no MESSAGING capability")


def _loginstate(dev, account_id):
    rows = accounts.db_find(dev, LOGINSTATE, {"accountId": account_id})
    return rows[0] if rows else None


@test(1, ("im",))
def provision_and_delete(ctx, conn):
    """createAccount -> onEnabled builds the login row; deleteAccount removes it all.

    Uses a sentinel credential, so the network refuses the login: what is
    checked is the account lifecycle and that the transport survives a failed
    login, not the network.
    """
    if ctx.dev.service_state(TRANSPORT, timeout_ms=15000) != "up":
        raise Fail("transport not up; see transport_starts")
    user = "harness-l1-%s@example.invalid" % uuid.uuid4().hex[:8]
    acct = accounts.create(ctx.dev, conn, user, {"common": {"password": L1_PASSWORD}})
    aid = acct["_id"]
    if acct.get("_harness_caller"):
        ctx.note("created as %s (validator returns via CrossAppResult)" % acct["_harness_caller"])
    deleted = []

    def cleanup():
        if not deleted:
            accounts.delete(ctx.dev, conn, aid)
    ctx.defer(cleanup)

    row = ctx.dev.wait_for(lambda: _loginstate(ctx.dev, aid), 30)
    if not row:
        raise Fail("no %s row for account %s after 30 s (onEnabled not called or failed)"
                   % (LOGINSTATE, aid))
    if row.get("serviceName") != conn.extra["service_name"]:
        raise Fail("loginstate serviceName %r, template says %r"
                   % (row.get("serviceName"), conn.extra["service_name"]))

    # Give the login attempt time to run and fail.
    time.sleep(ctx.opts.get("l1_login_wait", 20))
    row = _loginstate(ctx.dev, aid) or {}
    if row.get("state") == "online":
        raise Fail("sentinel credential reached state=online")
    if ctx.dev.service_state(TRANSPORT) != "up":
        raise Fail("transport died after a failed %s login" % conn.name)
    ctx.note("login with sentinel ended in state=%s errorCode=%s"
             % (row.get("state"), row.get("errorCode")))

    accounts.delete(ctx.dev, conn, aid)
    deleted.append(True)
    svc = conn.extra["service_name"]
    if not ctx.dev.wait_for(lambda: not _leftovers(ctx.dev, aid, user, svc), 30):
        raise Fail("rows left 30 s after deleteAccount: %s" % _leftovers(ctx.dev, aid, user, svc))


def _leftovers(dev, aid, user, service_name):
    """Rows onEnabled(false) must remove. Queries use the kinds' own indexes
    (imlibpurpleservice files/etc/palm/db/kinds): loginstate byAccountId,
    immessage serviceAndUsername."""
    out = []
    if _loginstate(dev, aid):
        out.append(LOGINSTATE)
    if accounts.db_find(dev, IMMESSAGE, {"serviceName": service_name, "username": user}, limit=1):
        out.append(IMMESSAGE)
    return out


# -- L2 ----------------------------------------------------------------------
#
# creds.local.json entry for an IM network:
#   "telegram": {
#     "account": "existing",          # reuse an account linked by hand (QR/2FA networks)
#     "username": "+31...",           # or, with "account": "create", username + password
#     "peer": "<address>",            # who to message; ideally an echo bot or a 2nd account
#     "echo": true                    # peer replies with the same text -> receive is checked
#   }

def _live_account(ctx, conn, c):
    if c.get("account", "existing") == "existing":
        accts = [a for a in accounts.accounts_for(ctx.dev, conn)
                 if not c.get("username") or a.get("username") == c["username"]]
        if not accts:
            raise Skip("no linked %s account on the device; link one in Settings first" % conn.name)
        return accts[0]["_id"], accts[0]["username"]
    acct = accounts.create(ctx.dev, conn, c["username"], {"common": {"password": c["password"]}})
    ctx.defer(accounts.delete, ctx.dev, conn, acct["_id"])
    return acct["_id"], c["username"]


def _wait_online(ctx, aid, timeout):
    def online():
        row = _loginstate(ctx.dev, aid)
        return row if row and row.get("state") == "online" else None
    row = ctx.dev.wait_for(online, timeout, interval=3)
    if not row:
        last = _loginstate(ctx.dev, aid) or {}
        raise Fail("not online after %ds: state=%s errorCode=%s"
                   % (timeout, last.get("state"), last.get("errorCode")))
    return row


@test(2, ("im",))
def live_login(ctx, conn):
    c = ctx.creds_for(conn)
    aid, _ = _live_account(ctx, conn, c)
    _wait_online(ctx, aid, c.get("login_timeout", 120))


def _send(ctx, conn, user, peer, text, extra=None):
    msg = {
        "_kind": IMMESSAGE, "folder": "outbox", "status": "pending",
        # SendOneMessageHandler reads the sender from from.addr, the
        # recipient from to[0].addr, and finds the account by that pair.
        "serviceName": conn.extra["service_name"], "username": user,
        "from": {"addr": user}, "to": [{"addr": peer}], "messageText": text,
        "localTimestamp": int(time.time() * 1000),
    }
    msg.update(extra or {})
    r = ctx.dev.luna("luna://com.palm.db/put", {"objects": [msg]}, app_id="com.palm.app.messaging")
    if not r or not r.get("returnValue"):
        raise Fail("db8 put to outbox failed: %r" % (r,))
    return r["results"][0]["id"]


def _wait_status(ctx, mid, timeout=60):
    def done():
        r = ctx.dev.luna("luna://com.palm.db/get", {"ids": [mid]}, app_id="com.palm.app.messaging")
        row = (r or {}).get("results", [{}])[0]
        return row if row.get("status") in ("successful", "failed") else None
    row = ctx.dev.wait_for(done, timeout, interval=3)
    if not row:
        raise Fail("outbox message %s still pending after %ds" % (mid, timeout))
    return row


def _wait_inbox(ctx, user, token, timeout):
    def got():
        rows = accounts.db_find(ctx.dev, IMMESSAGE, {"folder": "inbox", "username": user}, limit=50)
        hits = [m for m in rows if token in (m.get("messageText") or "")]
        return hits[0] if hits else None
    return ctx.dev.wait_for(got, timeout, interval=4)


@test(2, ("im",))
def live_text_roundtrip(ctx, conn):
    c = ctx.creds_for(conn)
    if not c.get("peer"):
        raise Skip("no peer configured")
    aid, user = _live_account(ctx, conn, c)
    _wait_online(ctx, aid, c.get("login_timeout", 120))
    token = "harness-%s" % uuid.uuid4().hex[:10]
    mid = _send(ctx, conn, user, c["peer"], "LuneOS synergy test %s" % token)
    row = _wait_status(ctx, mid)
    if row["status"] != "successful":
        raise Fail("send failed: errorCode=%s errorCategory=%s"
                   % (row.get("errorCode"), row.get("errorCategory")))
    ds = row.get("deliveryStatus")
    if ds:
        ctx.note("deliveryStatus=%s" % ds)
    if c.get("echo"):
        if not _wait_inbox(ctx, user, token, c.get("echo_timeout", 60)):
            raise Fail("echo with %s not received" % token)
    else:
        ctx.note("receive not checked (no echo peer)")


@test(2, ("im",))
def live_image_send(ctx, conn):
    c = ctx.creds_for(conn)
    if not c.get("peer") or c.get("attachments") is False:
        raise Skip("no peer, or attachments disabled for this network")
    aid, user = _live_account(ctx, conn, c)
    _wait_online(ctx, aid, c.get("login_timeout", 120))
    remote = "/media/internal/harness-%s.png" % uuid.uuid4().hex[:8]
    ctx.dev.push(os.path.join(os.path.dirname(__file__), "..", "data", "test.png"), remote)
    ctx.defer(ctx.dev.shell, "rm -f %s" % q(remote))
    mid = _send(ctx, conn, user, c["peer"], "", {"filePath": remote})
    # sendFile only starts the transfer; the transport downgrades the row to
    # "failed" when the transfer does not complete (LibpurpleAdapter.h).
    time.sleep(c.get("attachment_settle", 30))
    row = _wait_status(ctx, mid)
    if row["status"] != "successful":
        raise Fail("attachment send failed: errorCode=%s" % row.get("errorCode"))
