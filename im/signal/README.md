# signal — Signal IM for webOS (TouchPad 3.0.5) — **built; on-device test pending**

> **Status: fully cross-compiled.** Both hard pieces are done — a softfp ARM **OpenJDK 11**
> to host signal-cli (`build-jvm.sh`) and the pure-Rust **libsignal_jni + libzkgroup**
> natives (`build-libsignal.sh`). `deploy-signal.sh` installs the whole runtime. The
> remaining step is **end-to-end testing on the device** (first real registration/link +
> JVM footprint on 1 GB). See `BUILD-LOG.md` for the full build.

The prpl is **hoehermann/purple-signal** (`prpl-hehoe-signal`), vendored under
`plugin/purple-signal/` with its submodules. Unlike Teams/Discord/Telegram/Facebook it is
**not** a self-contained C plugin:

```
libpurple → purple-signal (C++/JNI) → embedded JVM → signal-cli (Java) → libsignal_jni (Rust)
```

## Why it doesn't run here
Two hard **runtime** walls on webOS ARMv7 / glibc 2.23 — both independent of build success:

1. ~~No suitable ARMv7 `libjvm.so`.~~ **✅ SOLVED.** The plugin calls `JNI_CreateJavaVM` to spin
   up a JVM inside the messaging process. We cross-compiled **OpenJDK 11.0.32 (Zero, headless)**
   for the exact device ABI — see `build-jvm.sh`. The resulting `libjvm.so` is ELF32 ARM,
   exports `JNI_CreateJavaVM`, and is **softfp** (so it loads into the softfp messaging process,
   unlike Temurin's hardfp arm32). A `jlink`'d **~25 MB minimal JRE** for signal-cli is staged at
   `build-output/openjdk-arm-jre/`.
2. **No ARMv7 `libsignal_jni` — but this one is *moderate*.** signal-cli 0.8.0 needs the
   native Rust libsignal (`signal-client-java 0.2.3` → `libsignal_jni`, + `zkgroup 0.7.0`).
   It's **pure-Rust** (no ring/BoringSSL), Rust ships official `std` for the exact
   `armv7-unknown-linux-gnueabi`/glibc target, and it just needs the pinned `nightly-2020-11-09`.
   Cross-buildable from source (see `BUILD-LOG.md`).

Plus: the plugin is **archived (2022)** and pinned to signal-cli 0.8.0, which may not register
against current Signal servers even with the runtime in place.

## What builds (the attempt)
```bash
cd messaging/signal
./build-signal.sh     # Stage 1: purple_signal.jar + JNI header (host JDK, downloads signal-cli)
                      # Stage 2: full ARM cross-compile -> build-arm/purple-signal.so
```
Both stages succeed: the Java jar builds on the host JDK, and all 18 C++ TUs cross-compile
and link into a valid ARM `purple-signal.so` exporting `purple_init_plugin`. It just can't
load on-device (see wall #1).

## Install (surface only)
```bash
./deploy-signal.sh    # pushes the account template + setup app; SKIPS the non-loadable .so
```
The Signal entry then appears under Settings → Accounts → Add, but sign-in cannot complete.

## The realistic path to Signal on webOS
Two routes, both large but neither fundamentally walled:
1. **Make purple-signal work** — cross-build a modern OpenJDK 11+ `libjvm.so` for armv7/webOS
   (wall #1) *and* the Rust `libsignal_jni` (wall #2), then ship both + the signal-cli jars.
   Heaviest runtime (a JVM in the messaging process on a 1 GB device).
2. **Skip the JVM** — a native, JVM-free prpl built directly on the Rust `libsignal`
   (wall #2 only). Lighter and more future-proof, but a from-scratch plugin.
The abandoned pure-C `libsignal-protocol-c` won't talk to current Signal servers, so it's not
a shortcut. Tracked here as a wired-up placeholder for that future work.
