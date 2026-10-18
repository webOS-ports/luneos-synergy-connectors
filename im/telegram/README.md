# telegram-port — Telegram IM for webOS (TouchPad 3.0.5) via libpurple

Rides the same libpurple 2.14 + ssl-openssl backend as the Teams port. See
`doctor305/TELEGRAM-DISCORD-SYNERGY-PORT-PLAN.md` for the full rationale, incl. the
tdlib-purple vs telegram-purple connectivity tradeoff.

## Build the prpl — primary: tdlib-purple (connects with current Telegram)
```bash
source ~/webos/wpe/env-glibc-gcc125.sh
export PKG_CONFIG_PATH=~/webos/teams-port/deploy/purple/lib/pkgconfig:~/webos/wpe/staging-glibc-252/lib/pkgconfig
# tdlib-purple needs TDLib cross-compiled for ARM first (large C++ build):
#   git clone https://github.com/tdlib/td && cross-build per its README against the gcc125 sysroot
#   then: git clone https://github.com/ars3niy/tdlib-purple && cmake against Td + purple 2.14
# Patch plugin id to prpl-telegram, output libtelegram.so.
```

## Fallback — telegram-purple (builds easily; may NOT log in, deprecated MTProto layer)
```bash
cd ~/webos/telegram-port/src
git clone --recursive https://github.com/majn/telegram-purple
cd telegram-purple
./configure --host=arm-unknown-linux-gnueabi --prefix=/usr \
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH"     # needs libgcrypt, zlib for the target
make
# plugin id is already prpl-telegram; output telegram-purple.so -> rename libtelegram.so
```
Verify: `file libtelegram.so` → ARM shared object; exports `purple_init_plugin`.

## Install (device connected via novacom)
```bash
BACKEND_PURPLE2=/media/cryptofs/apps/.../backend/lib/purple-2 ./deploy-telegram.sh
```
Then Settings → Accounts → Add account → Telegram (phone number).

## Notes
- Backend (libpurple 2.14 + ssl-openssl TLS 1.3) must already be live from teams-port.
- **Login code**: Telegram's SMS/app code is an interactive prompt during connect; the generic
  validator does not surface it. Needs an imlibpurple `request_input` hook or a small setup scene.
  Documented gap, not built. See PORT-PLAN §4.
