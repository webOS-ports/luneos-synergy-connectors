"""Music providers: one Go daemon (spotify-webos-service) on 127.0.0.1:8730.

The providers are account types with no bus callbacks; the app and the
sign-in UI talk to the daemon over localhost HTTP. Endpoints and response
shapes are from org.webosports.app.music service/*.go (see the music
connectors write-up). The daemon port is adb-forwarded to the host.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from harness.runner import Fail, Skip, test

PORT = 8730
DAEMON = "spotify-webos-service"
STATE_DIR = "/media/cryptofs/spotify-webos"
APPS = ("org.webosports.app.music", "org.webosports.app.musicauth")
DEFAULT_QUERY = "bach cello suite"


class Http:
    def __init__(self, ctx):
        self.base = "http://127.0.0.1:%d" % ctx.dev.forward(PORT)

    def call(self, method, path, body=None, timeout=40):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                status = r.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        except (urllib.error.URLError, OSError) as e:
            raise Fail("daemon %s %s: %s" % (method, path, e))
        try:
            return status, json.loads(raw or b"null")
        except ValueError:
            return status, raw.decode("utf-8", "replace")

    def get(self, path, **kw):
        return self.call("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.call("POST", path, body if body is not None else {}, **kw)


def _http(ctx):
    h = getattr(ctx, "_music_http", None)
    if h is None:
        if not ctx.dev.pids(DAEMON):
            raise Fail("%s is not running" % DAEMON)
        h = ctx._music_http = Http(ctx)
    return h


def _providers(ctx):
    status, body = _http(ctx).get("/providers")
    if status != 200 or not isinstance(body, dict):
        raise Fail("GET /providers: HTTP %s %r" % (status, body))
    return {p["id"] for p in body.get("providers", [])}


# -- L0 ----------------------------------------------------------------------

@test(0, ("music",), once=True)
def daemon_running(ctx, conn):
    if not ctx.dev.pids(DAEMON):
        raise Fail("%s not running (no service unit, or it exited)" % DAEMON)
    _providers(ctx)


@test(0, ("music",), once=True)
def apps_installed(ctx, conn):
    from suites.common import _find_app
    missing = [a for a in APPS if not _find_app(ctx.dev, a)]
    if missing:
        raise Fail("not installed: " + ", ".join(missing))


@test(0, ("music",), once=True)
def audio_pipeline(ctx, conn):
    """The GStreamer elements the daemon's pipelines name exist on this image."""
    rc, out = ctx.dev.shell("ps -o args= -p $(pgrep -f %s | head -n 1) 2>/dev/null; "
                            "which gst-launch-1.0 gst-launch-0.10" % DAEMON)
    if "gst-launch-0.10" not in out and "gst-launch-1.0" not in out:
        raise Fail("no gst-launch on the device")
    need = ["fdsrc", "decodebin", "audioconvert", "audioresample", "pulsesink"]
    missing = []
    for el in need:
        rc, _ = ctx.dev.shell("gst-inspect-1.0 %s >/dev/null 2>&1" % el)
        if rc != 0:
            missing.append(el)
    if missing:
        raise Fail("GStreamer 1.0 elements missing: " + ", ".join(missing))


@test(0, ("music",))
def provider_registered(ctx, conn):
    if not conn.extra.get("anonymous_search"):
        raise Skip("%s registers only once signed in" % conn.name)
    if conn.extra["provider"] not in _providers(ctx):
        raise Fail("/providers lacks %s" % conn.extra["provider"])


# -- L1 ----------------------------------------------------------------------

def _search(ctx, conn, query, limit=5):
    path = "/provider/%s/search?%s" % (conn.extra["provider"],
                                       urllib.parse.urlencode({"q": query, "limit": limit}))
    status, body = _http(ctx).get(path, timeout=60)
    if status != 200 or not isinstance(body, dict):
        raise Fail("search: HTTP %s %s" % (status, str(body)[:200]))
    tracks = body.get("tracks") or []
    if not tracks:
        raise Fail("search %r returned no tracks" % query)
    for t in tracks:
        for f in ("id", "provider", "title"):
            if not t.get(f):
                raise Fail("track lacks %s: %r" % (f, t))
    return tracks


@test(1, ("music",))
def anonymous_search(ctx, conn):
    if not conn.extra.get("anonymous_search"):
        raise Skip("needs a signed-in account")
    q = (ctx.creds.get(conn.key) or {}).get("query", DEFAULT_QUERY)
    ctx.note("%d tracks" % len(_search(ctx, conn, q)))


AUTH_STATUS = {"spotify": "/auth/status", "tidal": "/tidalauth/status", "apple": "/appleauth/status"}


@test(1, ("music",))
def auth_status(ctx, conn):
    """Status endpoints answer with JSON whether or not a session exists."""
    path = AUTH_STATUS.get(conn.extra["provider"])
    if not path:
        raise Skip("no status endpoint for %s" % conn.name)
    status, body = _http(ctx).get(path)
    if status != 200 or not isinstance(body, dict) or "authenticated" not in body:
        raise Fail("GET %s: HTTP %s %r" % (path, status, body))
    ctx.note("authenticated=%s" % body["authenticated"])


BOGUS_LOGIN = {"qobuz": "/qobuzauth/login", "deezer": "/dzauth/login"}


@test(1, ("music",))
def bogus_login(ctx, conn):
    """A wrong password is refused cleanly (and not stored)."""
    path = BOGUS_LOGIN.get(conn.extra["provider"])
    if not path:
        raise Skip("no password login for %s" % conn.name)
    if ctx.creds.get(conn.key):
        raise Skip("real credentials configured; not overwriting them with a bogus login")
    status, body = _http(ctx).post(path, {"email": "harness@example.invalid", "password": "x"}, timeout=60)
    # The daemon answers a rejected upstream login with 502 and {"error": ...}
    # (service/*auth.go); that is a clean refusal. A login that "succeeds",
    # a non-JSON reply or a 500 (handler panic) is not.
    if not isinstance(body, dict) or body.get("ok") or status == 500 or not body.get("error"):
        raise Fail("bogus login: HTTP %s %r" % (status, body))
    ctx.note("refused: HTTP %s" % status)


@test(1, ("music",))
def youtube_video_resolve(ctx, conn):
    if conn.extra["provider"] != "youtube":
        raise Skip("YouTube only")
    track = _search(ctx, conn, DEFAULT_QUERY, limit=1)[0]
    status, body = _http(ctx).post("/provider/youtube/resolveVideo", {"trackId": track["id"]}, timeout=60)
    if status != 200 or not isinstance(body, dict) or not body.get("url"):
        raise Fail("resolveVideo: HTTP %s %r" % (status, body))


# -- L2 / playback -----------------------------------------------------------
#
# creds.local.json, per provider (all optional):
#   "qobuz":  {"email": "...", "password": "..."}
#   "deezer": {"arl": "..."}            or {"email": ..., "password": ...}
#   "spotify":{"account": "existing"}   (signed in through Settings; Premium)
#   "tidal":  {"account": "existing"},  "apple": {"account": "existing"}
#   any:      "query": "...", "play_seconds": 10

def _sign_in(ctx, conn, c):
    p, h = conn.extra["provider"], _http(ctx)
    if p == "qobuz" and c.get("email"):
        status, body = h.post("/qobuzauth/login", {"email": c["email"], "password": c["password"]}, timeout=60)
    elif p == "deezer" and c.get("arl"):
        status, body = h.post("/dzauth/save", {"arl": c["arl"]}, timeout=60)
    elif p == "deezer" and c.get("email"):
        status, body = h.post("/dzauth/login", {"email": c["email"], "password": c["password"]}, timeout=60)
    else:
        path = AUTH_STATUS.get(p)
        if path:
            _, body = h.get(path)
            if not (isinstance(body, dict) and body.get("authenticated")):
                raise Skip("%s not signed in on the device" % conn.name)
        return
    if status != 200 or not (isinstance(body, dict) and body.get("ok")):
        raise Fail("sign-in: HTTP %s %r" % (status, body))


def _stream_status(h):
    _, body = h.get("/stream/status")
    return body if isinstance(body, dict) else {}


@test(2, ("music",))
def live_playback(ctx, conn):
    """Search, play, and see the position advance; pause holds it; stop ends it."""
    c = ctx.creds.get(conn.key)
    if c is None and not conn.extra.get("anonymous_search"):
        raise Skip("no credentials for %s" % conn.name)
    c = c or {}
    if conn.extra["provider"] == "spotify":
        raise Skip("Spotify plays through librespot (/player/*), covered by live_spotify")
    _sign_in(ctx, conn, c)
    h = _http(ctx)
    track = _search(ctx, conn, c.get("query", DEFAULT_QUERY), limit=1)[0]
    status, body = h.post("/provider/%s/play" % conn.extra["provider"], {"trackId": track["id"]}, timeout=60)
    if status != 200:
        raise Fail("play %s: HTTP %s %r" % (track["id"], status, body))
    ctx.defer(h.post, "/stream/stop")

    first = ctx.dev.wait_for(lambda: (lambda s: s if s.get("is_playing") and s.get("position_ms", 0) > 0
                                      else None)(_stream_status(h)), 45, interval=2)
    if not first:
        raise Fail("not playing 45 s after /play: %r" % _stream_status(h))
    time.sleep(c.get("play_seconds", 8))
    later = _stream_status(h)
    if later.get("position_ms", 0) <= first["position_ms"]:
        raise Fail("position did not advance: %s -> %s" % (first["position_ms"], later.get("position_ms")))
    _check_pulse(ctx)

    h.post("/stream/pause")
    a = _stream_status(h).get("position_ms", 0)
    time.sleep(3)
    b = _stream_status(h).get("position_ms", 0)
    if b > a + 500:
        raise Fail("position moved while paused: %s -> %s" % (a, b))
    h.post("/stream/resume")
    h.post("/stream/stop")
    ctx.note("played %r, format=%s" % (track["title"], later.get("format")))


def _check_pulse(ctx):
    """A music-role stream is actually connected to PulseAudio."""
    rc, out = ctx.dev.shell("pactl list sink-inputs 2>&1")
    if rc != 0:
        ctx.note("pactl unavailable: %s" % out.strip()[-120:])
        return
    if 'media.role = "music"' not in out:
        raise Fail("playing, but no PulseAudio sink-input with media.role=music")


@test(2, ("music",))
def live_spotify(ctx, conn):
    if conn.extra["provider"] != "spotify":
        raise Skip("Spotify only")
    c = ctx.creds_for(conn)
    _sign_in(ctx, conn, c)
    if not ctx.dev.exists(STATE_DIR + "/librespot"):
        raise Fail("librespot binary missing at %s/librespot (playback disabled)" % STATE_DIR)
    h = _http(ctx)
    track = _search(ctx, conn, c.get("query", DEFAULT_QUERY), limit=1)[0]
    status, body = h.post("/player/load", {"uri": track.get("path") or track["id"], "position_ms": 0}, timeout=60)
    if status != 200:
        raise Fail("/player/load: HTTP %s %r" % (status, body))
    ctx.defer(h.post, "/player/pause")
    ok = ctx.dev.wait_for(lambda: (h.get("/player/status")[1] or {}).get("is_playing"), 45)
    if not ok:
        raise Fail("librespot not playing: %r" % (h.get("/player/status")[1],))
    _check_pulse(ctx)
