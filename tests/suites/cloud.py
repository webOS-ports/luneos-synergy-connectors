"""Cloud/file connectors: one node service per provider, a plain node module (package.json)
on the shared _cloudcore/node runtime.

Method names, arguments and ACL behaviour are from cloud/cloudcore/service/
_cloudcore (commands/*.js, acl.js). Gated methods check the caller's app id,
which `luna-send -a` sets, so each call goes out as an app the connector's
own Config allows -- the same identity the real consumer uses.
"""

import json
import posixpath
import uuid

from harness import accounts
from harness.device import q
from harness.runner import Fail, Skip, test

SERVICES_DIR = "/usr/palm/services"
# LuneOS consumers of DOCUMENTS / PHOTO.UPLOAD accounts. Config.FILE_APP_IDS must
# name these or the stock LuneOS apps are refused by Acl.enforce.
LUNEOS_FILE_APPS = ("org.webosports.app.documents",)
BOGUS = {"accessToken": "harness-invalid-token", "refreshToken": "harness-invalid-token",
         "expiresAt": 1}


def _svc_dir(conn):
    return "%s/%s" % (SERVICES_DIR, conn.own_service)


def _config(ctx, conn):
    """The installed service's Config object, evaluated by the device's node."""
    path = _svc_dir(conn) + "/config.js"
    if not ctx.dev.exists(path):
        raise Fail("%s not installed" % path)
    js = "process.stdout.write(JSON.stringify(require(%s).Config))" % json.dumps(path)
    rc, out = ctx.dev.shell("node -e %s" % q(js))
    if rc != 0:
        raise Fail("config.js does not evaluate under node: %s" % out.strip()[-300:])
    return json.loads(out)


def _call(ctx, conn, method, payload, app_id=None, timeout_ms=40000):
    """One service call. The services' own commandTimeout is 30 s, so 40 s
    without a reply means the command is stuck, not slow; after the first
    such hang every later call to that service fails at once instead of
    waiting again."""
    hung = ctx.opts.setdefault("cloud_hung", {})
    if conn.own_service in hung:
        raise Fail("%s hung earlier (%s); not called" % (conn.own_service, hung[conn.own_service]))
    r = ctx.dev.luna("luna://%s/%s" % (conn.own_service, method), payload,
                     app_id=app_id, timeout_ms=timeout_ms)
    if r is None:
        hung[conn.own_service] = method
        raise Fail("%s/%s: no reply in %d ms%s" % (conn.own_service, method, timeout_ms,
                                                    _denials(ctx, conn)))
    return r


def _denials(ctx, conn):
    """Recent ACG denials logged by this service: the usual reason for a hang."""
    svc = conn.own_service.split(".")[-1]
    _, out = ctx.dev.shell("journalctl -b --no-pager --since -2min | grep -a 'service.%s\\[' "
                           "| grep -aoE 'palm://[^ ]+ .*Denied method call \"[^\"]+\"' | sort -u | head -n 4"
                           % svc, timeout=60)
    calls = sorted({l.split(" ", 1)[0] for l in out.splitlines() if l.strip()})
    return "; ACG denied: " + ", ".join(calls) if calls else ""


def _file_app(cfg):
    ids = cfg.get("FILE_APP_IDS") or []
    for a in LUNEOS_FILE_APPS:
        if a in ids:
            return a
    return ids[0] if ids else None


# -- L0 ----------------------------------------------------------------------

def _node_service(ctx, base):
    """The connector's package.json (run-js-service require()s a directory that has one)."""
    return ctx.dev.read_json(base + "/package.json")


@test(0, ("cloud",))
def service_sources(ctx, conn):
    """The service is a node module: its package.json, its main and the _cloudcore/node
    runtime it requires are installed."""
    base = _svc_dir(conn)
    pkg = _node_service(ctx, base)
    if pkg is None:
        raise Fail("%s/package.json not installed" % base)
    missing = [p for p in (posixpath.join(base, pkg.get("main") or "index.js"),
                           posixpath.join(SERVICES_DIR, "_cloudcore/node/index.js"))
               if not ctx.dev.exists(p)]
    if missing:
        raise Fail("not installed: " + ", ".join(missing))


@test(0, ("cloud",))
def service_syntax(ctx, conn):
    """The service loads on node 22: require() of its directory, which starts nothing
    until run()."""
    base = _svc_dir(conn)
    if _node_service(ctx, base) is None:
        raise Skip("not installed")
    js = "var s = require(%s); if (typeof s.run !== 'function') { throw new Error('no run()'); }" % json.dumps(base)
    rc, out = ctx.dev.shell("node -e %s 2>&1" % q(js))
    if rc != 0:
        raise Fail("require(%s): %s" % (base, out.strip()[-300:]))


@test(0, ("cloud",))
def service_up(ctx, conn):
    st = ctx.dev.service_state(conn.own_service, timeout_ms=20000)
    if st != "up":
        raise Fail("%s: %s" % (conn.own_service, st))


@test(0, ("cloud",))
def acl_luneos_apps(ctx, conn):
    """The connector lets its sign-in app and the LuneOS file app call it."""
    cfg = _config(ctx, conn)
    probs = []
    if conn.validator_app and conn.validator_app not in (cfg.get("AUTH_APP_IDS") or [conn.validator_app]):
        probs.append("AUTH_APP_IDS %s lacks %s" % (cfg.get("AUTH_APP_IDS"), conn.validator_app))
    if conn.extra.get("documents", True):
        ids = cfg.get("FILE_APP_IDS") or []
        if not any(a in ids for a in LUNEOS_FILE_APPS):
            probs.append("FILE_APP_IDS %s has no LuneOS file app (%s)" % (ids, ", ".join(LUNEOS_FILE_APPS)))
    if probs:
        raise Fail("; ".join(probs))


@test(0, ("cloud",))
def tls_reachable(ctx, conn):
    """The service's curl + CA bundle complete a TLS handshake with the provider."""
    cfg = _config(ctx, conn)
    curl, ca = cfg.get("CURL", "/usr/bin/curl"), cfg.get("CURL_CAINFO")
    if ca and not ctx.dev.exists(ca):
        raise Fail("CURL_CAINFO %s missing" % ca)
    url = cfg.get("API_BASE") or cfg.get("TOKEN_URL") or cfg.get("AUTHORIZE_URL")
    if not url:
        raise Skip("no endpoint in Config (endpoint is user-supplied, e.g. S3)")
    cmd = "%s -sS -o /dev/null -w '%%{http_code}' --max-time 20 %s %s" % (
        q(curl), "--cacert %s" % q(ca) if ca else "", q(url))
    rc, out = ctx.dev.shell(cmd, timeout=40)
    code = out.strip()[-3:]
    if rc != 0 or not code.isdigit() or code == "000":
        raise Fail("curl %s failed (rc=%d): %s" % (url, rc, out.strip()[-200:]))
    ctx.note("%s -> HTTP %s" % (url, code))


# -- L1 ----------------------------------------------------------------------

@test(1, ("cloud",))
def authorize_url(ctx, conn):
    """getAuthorizeUrl builds a consent URL the provider actually serves.

    A provider answering 4xx here usually means the app key in config.js was
    revoked or the redirect URI is no longer registered.
    """
    if conn.extra["auth"] not in ("oauth2", "oauth1"):
        raise Skip("%s signs in with %s, not a consent URL" % (conn.name, conn.extra["auth"]))
    cfg = _config(ctx, conn)
    r = _call(ctx, conn, "getAuthorizeUrl", {}, app_id=conn.validator_app)
    if not r.get("returnValue"):
        raise Fail("getAuthorizeUrl: %r" % r)
    url = r["url"]
    if cfg.get("AUTHORIZE_URL") and not url.startswith(cfg["AUTHORIZE_URL"]):
        raise Fail("URL %s does not start with AUTHORIZE_URL %s" % (url[:120], cfg["AUTHORIZE_URL"]))
    for part in ("client_id=", "redirect_uri="):
        if conn.extra["auth"] == "oauth2" and part not in url:
            raise Fail("authorize URL lacks %s" % part)
    if r.get("codeVerifier") and "code_challenge=" not in url:
        raise Fail("PKCE verifier returned but no code_challenge in URL")
    cmd = "curl -sS -o /dev/null -w '%%{http_code}' --max-time 20 %s" % q(url)
    _, out = ctx.dev.shell(cmd, timeout=40)
    code = out.strip()[-3:]
    if not code.isdigit() or int(code) >= 400:
        raise Fail("provider answered HTTP %s to the consent URL" % code)
    ctx.note("consent page HTTP %s" % code)


@test(1, ("cloud",))
def bogus_credentials(ctx, conn):
    """Invalid tokens give a clean returnValue:false, not a hang or a crash."""
    r = _call(ctx, conn, "checkCredentials", {"credentials": {"common": BOGUS}})
    if r.get("returnValue") is not False:
        raise Fail("checkCredentials accepted a bogus token: %r" % r)
    if not r.get("errorCode"):
        raise Fail("rejection carries no errorCode: %r" % r)
    ctx.note("errorCode=%s" % r["errorCode"])


@test(1, ("cloud",))
def bogus_list_folder(ctx, conn):
    if not conn.extra.get("documents", True):
        raise Skip("no DOCUMENTS capability")
    app = _file_app(_config(ctx, conn))
    r = _call(ctx, conn, "listFolder", {"credentials": {"common": BOGUS}, "path": ""}, app_id=app)
    if r.get("returnValue") is not False or not r.get("errorCode"):
        raise Fail("listFolder with a bogus token: %r" % r)


@test(1, ("cloud",))
def acl_rejects_strangers(ctx, conn):
    """Gated file methods refuse a caller that is not on FILE_APP_IDS."""
    if not conn.extra.get("documents", True):
        raise Skip("no DOCUMENTS capability")
    r = _call(ctx, conn, "listFolder", {"credentials": {"common": BOGUS}, "path": ""},
              app_id="org.webosports.harness.stranger")
    # acl.js rejects with errorCode PERMISSION_DENIED; any other error (a 401
    # from the provider) means the call got past the ACL.
    if json.dumps(r).find("PERMISSION_DENIED") < 0:
        raise Fail("stranger caller was not refused by the ACL: %r" % r)


# -- L2 ----------------------------------------------------------------------
#
# creds.local.json entry for a cloud connector, one of:
#   "dropbox": {"account": "existing"}                       # use the signed-in account
#   "dropbox": {"credentials": {"common": {...}}}            # tokens from a real sign-in
# optional: "folder": "<locator>"  where the harness may write luneos-harness.bin

def _who(ctx, conn):
    c = ctx.creds_for(conn)
    if "credentials" in c:
        return {"credentials": c["credentials"]}, c
    accts = accounts.accounts_for(ctx.dev, conn)
    if not accts:
        raise Skip("no %s account on the device and no credentials in creds file" % conn.name)
    return {"accountId": accts[0]["_id"]}, c


@test(2, ("cloud",))
def live_credentials(ctx, conn):
    who, _ = _who(ctx, conn)
    if "credentials" not in who:
        raise Skip("account mode: credentials are not readable by the harness")
    r = _call(ctx, conn, "checkCredentials", who)
    if not r.get("returnValue"):
        raise Fail("checkCredentials: %r" % r)


@test(2, ("cloud",))
def live_list_root(ctx, conn):
    if not conn.extra.get("documents", True):
        raise Skip("no DOCUMENTS capability")
    who, c = _who(ctx, conn)
    app = _file_app(_config(ctx, conn))
    r = _call(ctx, conn, "listFolder", dict(who, path=c.get("folder", "")), app_id=app, timeout_ms=120000)
    if not r.get("returnValue"):
        raise Fail("listFolder root: %r" % r)
    ctx.note("%d entries" % len(r.get("entries", [])))


HARNESS_FILE = "luneos-harness.bin"


@test(2, ("cloud",))
def live_upload_download(ctx, conn):
    """Upload random bytes, download them back, compare sha256; then overwrite."""
    if not conn.extra.get("documents", True):
        raise Skip("no DOCUMENTS capability")
    who, c = _who(ctx, conn)
    app = _file_app(_config(ctx, conn))
    folder = c.get("folder", "")
    tmp = "/media/internal/.harness-%s" % uuid.uuid4().hex[:8]
    ctx.dev.out("mkdir -p %s" % q(tmp))
    ctx.defer(ctx.dev.shell, "rm -rf %s" % q(tmp))

    listing = _call(ctx, conn, "listFolder", dict(who, path=folder), app_id=app, timeout_ms=120000)
    if not listing.get("returnValue"):
        raise Fail("listFolder: %r" % listing)
    existing = [e for e in listing.get("entries", []) if e.get("name") == HARNESS_FILE]

    for rnd in (1, 2):
        src = "%s/up%d.bin" % (tmp, rnd)
        ctx.dev.out("dd if=/dev/urandom of=%s bs=1024 count=%d 2>/dev/null" % (q(src), 96 + rnd * 37))
        want = ctx.dev.out("sha256sum %s" % q(src)).split()[0]
        if existing:
            args = dict(who, fileId=existing[0]["path"] or existing[0]["id"], localPath=src, replace=True)
        else:
            args = dict(who, path=folder, folderId=folder, localPath=src, name=HARNESS_FILE)
        up = _call(ctx, conn, "uploadFile", args, app_id=app, timeout_ms=300000)
        if not up.get("returnValue"):
            raise Fail("upload round %d: %r" % (rnd, up))
        locator = up.get("id") or up.get("path")
        dst = "%s/down%d.bin" % (tmp, rnd)
        down = _call(ctx, conn, "downloadFile", dict(who, fileId=locator, path=locator, localPath=dst),
                     app_id=app, timeout_ms=300000)
        if not down.get("returnValue"):
            raise Fail("download round %d: %r" % (rnd, down))
        got = ctx.dev.out("sha256sum %s" % q(down.get("path", dst))).split()[0]
        if got != want:
            raise Fail("round %d: downloaded bytes differ (sha256 %s != %s)" % (rnd, got[:12], want[:12]))
        existing = [{"id": up.get("id"), "path": up.get("path") or up.get("id")}]


@test(2, ("cloud",))
def live_photos(ctx, conn):
    """listAlbums/listPhotos, and every src_big fetches with no auth header."""
    if conn.extra.get("photos") is False or not any(
            c.get("capability") == "PHOTO.UPLOAD" for c in conn.capabilities):
        raise Skip("no PHOTO.UPLOAD capability")
    who, _ = _who(ctx, conn)
    if "accountId" not in who:
        raise Skip("photo methods take an accountId; use account mode")
    al = _call(ctx, conn, "listAlbums", who, timeout_ms=300000)
    if not al.get("returnValue", True) or not al.get("albums"):
        raise Fail("listAlbums: %r" % al)
    alb = al["albums"][0]
    ph = _call(ctx, conn, "listPhotos", dict(who, aid=alb["aid"]), timeout_ms=300000)
    photos = ph.get("photos") or []
    if not photos:
        ctx.note("album %r is empty; src_big not checked" % alb.get("name"))
        return
    for p in photos[:3]:
        cmd = "curl -sSL -o /dev/null -w '%%{http_code} %%{content_type}' --max-time 40 %s" % q(p["src_big"])
        _, out = ctx.dev.shell(cmd, timeout=60)
        code, _, ctype = out.strip().partition(" ")
        if code != "200" or not (ctype.startswith("image/") or p["src_big"].startswith("file://")):
            raise Fail("photo %s: HTTP %s %s" % (p.get("fileName"), code, ctype))
