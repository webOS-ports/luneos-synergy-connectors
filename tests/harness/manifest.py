"""Connector manifest: what the 28 connectors are, read from their own sources.

Everything that an account template already says (template id, capability
ids, validator app, every palm:// service it calls) is taken from the template
JSON in this repository (<family>/<connector>/account/), so the harness cannot
drift from the code. Only the
facts a template does not carry -- which libpurple plugin implements an IM
network, how a connector signs in, the music daemon's provider id -- come from
connectors.json next to this package.
"""

import glob
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
REPO = os.path.dirname(TESTS)

ACCOUNTS_DIR = "/usr/palm/public/accounts"
APPS_DIRS = ("/usr/palm/applications", "/media/cryptofs/apps/usr/palm/applications")

PALM_URI = re.compile(r"^(?:palm|luna)://([A-Za-z0-9_.-]+)(/.*)?$")


class Connector:
    def __init__(self, family, template_path, template, extra):
        self.family = family
        self.template_path = template_path
        self.template = template
        self.extra = extra
        self.id = template["templateId"]
        self.name = extra.get("name") or template.get("loc_name") or self.id
        self.key = extra["key"]

    @property
    def capabilities(self):
        return self.template.get("capabilityProviders", [])

    @property
    def validator_app(self):
        v = self.template.get("validator")
        if isinstance(v, dict):
            return (v.get("customUI") or {}).get("appId")
        return None

    @property
    def device_template(self):
        return "%s/%s/%s.json" % (ACCOUNTS_DIR, self.id, self.id)

    def uris(self, template=None):
        """Every (json-path, uri) in the template that names a bus endpoint.

        template: another copy to read, such as the one the Accounts service
        actually serves (which can be a per-locale file, not this one).
        """
        return template_uris(self.template if template is None else template)

    def services(self, template=None):
        return sorted({PALM_URI.match(u).group(1) for _, u in self.uris(template)})

    @property
    def own_service(self):
        """The connector's own bus service (cloud), if it has one."""
        return self.extra.get("service")

    def icons(self):
        out = set()

        def walk(node):
            if isinstance(node, dict):
                for k, v in node.items():
                    if k == "icon" and isinstance(v, dict):
                        out.update(x for x in v.values() if isinstance(x, str))
                    else:
                        walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(self.template)
        return sorted(out)

    def __repr__(self):
        return "<%s %s>" % (self.family, self.id)


def template_uris(template):
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, path + "." + k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, "%s[%d]" % (path, i))
        elif isinstance(node, str) and PALM_URI.match(node):
            found.append((path.lstrip("."), node))

    walk(template, "")
    return found


def _load_template(path):
    with open(path) as f:
        t = json.load(f)
    return t[0] if isinstance(t, list) else t


def _template_files(repo):
    for family in ("im", "cloud", "music"):
        paths = glob.glob(os.path.join(repo, family, "*/account/**/*.json"), recursive=True)
        yield family, sorted(p for p in paths if "/resources/" not in p)


def load(repo=REPO, extras_path=None):
    """All connectors, ordered by family then key.

    Raises ValueError when connectors.json and the templates disagree, so a new
    or renamed template is noticed instead of silently untested.
    """
    extras_path = extras_path or os.path.join(TESTS, "connectors.json")
    with open(extras_path) as f:
        extras = json.load(f)["connectors"]

    out, seen = [], set()
    for family, paths in _template_files(repo):
        for p in paths:
            t = _load_template(p)
            tid = t.get("templateId")
            if not tid:
                continue
            ex = extras.get(tid)
            if ex is None:
                raise ValueError("template %s (%s) has no entry in connectors.json" % (tid, p))
            if ex["family"] != family:
                raise ValueError("%s: connectors.json says family %s, found under %s"
                                 % (tid, ex["family"], family))
            seen.add(tid)
            out.append(Connector(family, p, t, ex))

    # Connectors without a template (YouTube).
    for tid, ex in extras.items():
        if tid in seen:
            continue
        if ex.get("template", True):
            raise ValueError("connectors.json lists %s but no template was found" % tid)
        out.append(Connector(ex["family"], None, {"templateId": tid}, ex))

    order = {"im": 0, "cloud": 1, "music": 2}
    out.sort(key=lambda c: (order[c.family], c.key))
    return out


def select(connectors, families=None, only=None):
    res = connectors
    if families:
        res = [c for c in res if c.family in families]
    if only:
        want = set(only)
        res = [c for c in res if c.key in want or c.id in want]
    return res
