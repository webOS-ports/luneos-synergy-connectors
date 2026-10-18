"""L0 checks shared by every connector with an account template."""

import json
import posixpath

from harness import accounts
from harness.device import q
from harness.manifest import APPS_DIRS
from harness.runner import Fail, Skip, test

FAMILIES = ("im", "cloud", "music")
LS2 = "/usr/share/luna-service2"


def _need_template(conn):
    if conn.template_path is None:
        raise Skip("%s has no account template by design" % conn.name)


def _installed(ctx, conn):
    """Device copy of the template; Fail if it is not there."""
    _need_template(conn)
    t = ctx.dev.read_json(conn.device_template)
    if t is None:
        pkg = conn.extra.get("package")
        raise Fail("%s not installed%s" % (conn.device_template,
                   "" if pkg else " (no LuneOS package for this connector yet)"))
    return t[0] if isinstance(t, list) else t


def _strip_comments(node):
    if isinstance(node, dict):
        return {k: _strip_comments(v) for k, v in node.items() if not k.startswith("__")}
    if isinstance(node, list):
        return [_strip_comments(v) for v in node]
    return node


def _diff_keys(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            out += _diff_keys(a.get(k), b.get(k), path + "." + k)
        return out
    return [] if a == b else [path.lstrip(".") or "<root>"]


@test(0, FAMILIES)
def template_installed(ctx, conn):
    dev_t = _installed(ctx, conn)
    diff = _diff_keys(_strip_comments(dev_t), _strip_comments(conn.template))
    if diff:
        raise Fail("device template differs from source at: " + ", ".join(diff[:8]))


@test(0, FAMILIES)
def template_registered(ctx, conn):
    _installed(ctx, conn)
    if conn.id not in accounts.templates(ctx.dev):
        raise Fail("installed but not returned by listAccountTemplates "
                   "(accounts service did not rescan, or rejected it)")


@test(0, FAMILIES)
def template_icons(ctx, conn):
    _installed(ctx, conn)
    base = posixpath.dirname(conn.device_template)
    missing = [i for i in conn.icons()
               if not ctx.dev.exists(i if i.startswith("/") else posixpath.join(base, i))]
    if missing:
        raise Fail("missing icons: " + ", ".join(missing))


def _find_app(dev, app_id):
    for d in APPS_DIRS:
        p = "%s/%s" % (d, app_id)
        if dev.exists(p + "/appinfo.json"):
            return p
    return None


@test(0, FAMILIES)
def validator_app(ctx, conn):
    """The sign-in UI exists and its entry page resolves inside the app.

    A main page that does not resolve is the blank-card failure: WAM loads
    about:blank and Add Account shows an empty card.
    """
    _need_template(conn)
    app = conn.validator_app
    if not app:
        raise Skip("template has no customUI validator")
    path = _find_app(ctx.dev, app)
    if not path:
        raise Fail("validator app %s not installed" % app)
    info = ctx.dev.read_json(path + "/appinfo.json")
    page = (conn.template.get("validator", {}).get("customUI") or {}).get("name") or info.get("main")
    if not ctx.dev.exists(posixpath.join(path, page)):
        raise Fail("%s: validator page %s missing" % (app, page))
    main = posixpath.normpath(posixpath.join(path, info.get("main", "index.html")))
    if not main.startswith(path + "/") or not ctx.dev.exists(main):
        raise Fail("%s: appinfo main %r does not resolve inside the app" % (app, info.get("main")))


@test(0, FAMILIES)
def validator_permissions(ctx, conn):
    """ACG: the validator app's requiredPermissions are granted on the bus.

    webos_app turns requiredPermissions into client-permissions.d at build
    time; an app installed without it gets an empty grant and every
    createAccount it makes is denied.
    """
    _need_template(conn)
    app = conn.validator_app
    path = app and _find_app(ctx.dev, app)
    if not path:
        raise Skip("no validator app installed")
    need = (ctx.dev.read_json(path + "/appinfo.json") or {}).get("requiredPermissions", [])
    if not need:
        raise Fail("%s declares no requiredPermissions; it will have no bus access under ACG" % app)
    rc, out = ctx.dev.shell("cat %s/client-permissions.d/%s*.json 2>/dev/null" % (LS2, q(app)))
    granted = set()
    try:
        for doc in _json_docs(out):
            for v in doc.values():
                granted.update(v)
    except ValueError as e:
        raise Fail("%s client-permissions unreadable: %s" % (app, e))
    missing = [g for g in need if g not in granted]
    if missing:
        raise Fail("%s: requiredPermissions not granted: %s" % (app, ", ".join(missing)))


def _json_docs(text):
    dec = json.JSONDecoder()
    i, docs = 0, []
    text = text.strip()
    while i < len(text):
        doc, j = dec.raw_decode(text, i)
        docs.append(doc)
        i = j
        while i < len(text) and text[i].isspace():
            i += 1
    return docs


@test(0, FAMILIES)
def bus_targets(ctx, conn):
    """Every palm:// service the template calls exists and answers.

    The Accounts service calls these (onEnabled, onDelete, validator.address,
    onCredentialsChanged...). A missing one makes that step fail at runtime
    with nothing visible in the UI. The template checked is the one the
    Accounts service serves: it loads resources/<locale>/<file> instead of
    the base file when that exists, so a stale locale copy is caught too.
    """
    _installed(ctx, conn)
    served = accounts.templates(ctx.dev).get(conn.id)
    if served is None:
        raise Skip("not registered; see template_registered")
    bad = []
    for svc in conn.services(served):
        st = ctx.dev.service_state(svc)
        if st != "up":
            where = [p for p, u in conn.uris(served) if "//%s" % svc in u]
            bad.append("%s %s (used by %s)" % (svc, st, ", ".join(where[:3])))
    if bad:
        raise Fail("; ".join(bad))
