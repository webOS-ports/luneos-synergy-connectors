# messaging/discord/calling — Discord voice FOUNDATION spike (webOS / ARMv7)

> **Status: FOUNDATION only. This is NOT a working Discord call and will not be for a
> long time.** It de-risks the single hardest piece — the mandatory **DAVE** end-to-end
> encryption stack (libdave + mlspp) — by building it for the HP TouchPad and proving
> the exact API on-device. Everything else (voice gateway, UDP transport, Opus, audio)
> is still unbuilt. See **[PLAN.md](PLAN.md)** for the full architecture and milestones.
>
> ⚠ **1:1 DM calling requires a user token (self-bot), which violates Discord's ToS and
> risks an account ban. Target server voice channels with a BOT token instead.** See
> PLAN.md §1.

## Why DAVE is unavoidable

Since 2026-03 Discord voice **mandates** DAVE E2EE; a client that can't speak it is
disconnected with close code **4017**. So a Discord voice client is "transport + Opus +
a full MLS/DAVE crypto stack." DAVE is open (discord/libdave, C++/mlspp; whitepaper at
daveprotocol.com; Trail-of-Bits audited). This spike builds it and pins down its API.

## What's here

```
build-libdave-arm.sh     reproduce the GREEN ARM cross-build of libdave + mlspp
toolchain/arm-webos.cmake CMake toolchain (GCC 12.5, armv7-a neon softfp, OpenSSL 1.1.1w)
prebuilt/                 vendored ARM artifacts so M1+ work can link immediately
  lib/*.a                 libdave.a + libmlspp/hpke/tls_syntax/bytes (+mls_ds/vectors) — ARM
  include/                dave/ (public C API), dave-src/ (internal C++), mlspp/, nlohmann/
  share/                  relocatable MLSPP + nlohmann_json CMake package configs
probe/
  dave_probe.cpp          exercises the DAVE API we need; the confirmed call sequence
  build-probe.sh          cross-compile the probe against prebuilt/
  run-probe-qemu.sh       run the ARM probe on the host via qemu-arm-static
logs/                     build + run logs (provenance), and the built ARM dave_probe
PLAN.md                   end-to-end architecture, OSS-to-port map, risks, milestones
```

## Results (verified this spike)

**libdave still builds GREEN.** Rebuilt from clean against the vendored prefix + repo
toolchain file: **0 errors**, 2 benign GCC ABI notes, identical `libdave.a`. ARM sizes:

| lib             | bytes     |
|-----------------|-----------|
| libdave.a       | 443,756   |
| libmlspp.a      | 1,371,556 |
| libhpke.a       | 901,438   |
| libmls_vectors.a| 480,440   |
| libmls_ds.a     | 114,608   |
| libtls_syntax.a | 15,308    |
| libbytes.a      | 14,192    |

**The DAVE probe compiles, links, and RUNS on ARM (under qemu-arm-static) — all checks
pass, exit 0:**

- **Part A (MLS key package, C API):** `daveSessionCreate → daveSessionInit →
  daveSessionGetMarshalledKeyPackage` produced a real **393-byte MLS KeyPackage**
  beginning `00 01 00 02` → protocol **v1**, ciphersuite **0x0002**
  (P256_AES128GCM_SHA256_P256), exactly as DAVE mandates.
- **Part B (media crypto, C++ API):** `CreateEncryptor`/`CreateDecryptor` +
  `MlsKeyRatchet` sharing a base secret → a **160-byte Opus-sized audio frame encrypts
  to 172 bytes** (+12: 8-byte GCM tag + ULEB nonce + `0xFAFA` magic) and **decrypts
  back byte-identical.** AES-128-GCM DAVE framing round-trips on-device.

**Key probe finding (documented in code + PLAN.md §5):** with `PERSISTENT_KEYS=OFF`,
`daveSessionCreate` **must** be called with `authSessionId = NULL`, or no key package
is generated (a non-empty id routes to the disabled persistent-key store). For a
per-call ephemeral identity, NULL is correct.

## Build & run

```sh
# 1. (optional) reproduce the whole ARM libdave+mlspp build from clean:
./build-libdave-arm.sh                 # clones libdave --recursive + mlspp + json
#    or just rebuild libdave against the vendored prefix:
LIBDAVE_ONLY=1 ./build-libdave-arm.sh

# 2. build the DAVE API probe against the vendored ARM libs:
probe/build-probe.sh                   # -> logs/dave_probe (ARM ELF)

# 3. run it on the host via qemu (or scp logs/dave_probe to the TouchPad and run):
probe/run-probe-qemu.sh
```

Toolchain assumptions (override via env `ARM_TC` / `ARM_OSSL`):
- crosstool-NG GCC 12.5 at `/home/herrie/x-tools/arm-unknown-linux-gnueabi-gcc125`
- cross OpenSSL 1.1.1w at `.../OpenSSL-11-Update/openssl-1.1.1w` (matches device rootfs)

## Build gotchas (proven — don't "fix")

- GCC 12.5 emits **false-positive** `-Warray-bounds`/`-Wstringop-overflow` in mlspp's
  `std::vector` inlining. libdave adds `-Werror` **only for Clang/MSVC, not GNU**, so
  no source patch is needed; the toolchain file adds `-Wno-*` as belt-and-suspenders.
- **Do not** link mlspp with `ld --whole-archive` — binutils 2.34 BFD has a bug on
  those archives. Plain static linking inside a `--start-group/--end-group` works
  (see `probe/build-probe.sh`).
- `-march=armv7-a -mtune=cortex-a8 -mfpu=neon -mfloat-abi=softfp`.

## Next

M1 = voice gateway + UDP echo (bot token, test guild). See **[PLAN.md](PLAN.md) §9.**
The crypto core it will call is done and proven here.
