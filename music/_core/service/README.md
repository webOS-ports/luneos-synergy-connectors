# spotify-webos-service (Go backend)

Localhost HTTP/JSON backend for the Music+Spotify app: Spotify search/browse
(`github.com/zmb3/spotify`) + librespot playback control. See
`../docs/ARCHITECTURE.md`.

## Build

Uses Herrie's Go toolchain (`/home/herrie/webos/gotool/go125`).

```bash
export PATH=/home/herrie/webos/gotool/go125/bin:$PATH
export GOROOT=/home/herrie/webos/gotool/go125
export GOPATH=/home/herrie/webos/gotool/gopath
export GOMODCACHE=/home/herrie/webos/gotool/gomod
export GOCACHE=/home/herrie/webos/gotool/gocache

go mod tidy                      # resolves zmb3/spotify + oauth2 (done; go.sum committed)
go build .                       # host build — VERIFIED OK against zmb3/spotify v2

# device build (TouchPad / ARMv7):
GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -ldflags="-s -w" \
    -o spotify-webos-service-arm .
```

Status: **compiles clean for host and ARMv7**; the ARM binary runs and binds on
the topaz TouchPad. API usage (`Search`, `PlayOpt`, `SeekOpt`, `VolumeOpt`,
`PlayerCurrentlyPlaying`, `spotifyauth`) validated by the compiler.

## ⚠️ Runtime prerequisite: `accept4` syscall (kernel one-liner)

On the stock `2.6.35-palm-tenderloin` kernel the service starts, logs
`listening on http://127.0.0.1:8730`, then dies with:

```
accept tcp 127.0.0.1:8730: accept4: function not implemented
```

Cause: Go 1.25 assumes `accept4` (present since kernel 2.6.28) and does **not**
fall back to `accept`. The kernel *binary* exports `sys_accept4`
(`80493aa8 T sys_accept4` in kallsyms), but the ARM **syscall table** never wires
it: `arch/arm/kernel/calls.S` ends at `/* 365 */ CALL(sys_recvmmsg)`, so
number 366 (accept4) falls through to `sys_ni_syscall` → ENOSYS.

**Fix (running kernel — `webos-linux-kernel-touchpad/arch/arm/kernel/calls.S`, after line 377):**
```diff
 /* 365 */	CALL(sys_recvmmsg)
+/* 366 */	CALL(sys_accept4)
```
Rebuild the kernel (Herrie's `linux-upstream-prep` tree already includes it).
Alternative if a kernel rebuild isn't desired: build this service with an older
Go (≤1.20) that still falls back to `accept` on ENOSYS, or run it inside the
bundled modern-rootfs container the other ports (Telegram/Signal) use.

## Run (on device, after the kernel fix)

```bash
/media/internal/spotify-webos-service -addr 127.0.0.1:8730 -librespot-name webOS
```

Then the app POSTs its OAuth token to `/session` and calls `/search`, `/player/*`.
Probe without a session (should be HTTP 401 "no session"):
```bash
curl 'http://127.0.0.1:8730/search?q=daft+punk&type=track'
```
