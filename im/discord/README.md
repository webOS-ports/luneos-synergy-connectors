# discord-port — Discord IM for webOS (TouchPad 3.0.5) via libpurple

Rides the same libpurple 2.14 + ssl-openssl backend as the Teams port. See
`doctor305/TELEGRAM-DISCORD-SYNERGY-PORT-PLAN.md` for the full rationale.

## Build the prpl
```bash
source ~/webos/wpe/env-glibc-gcc125.sh
export PKG_CONFIG_PATH=~/webos/teams-port/deploy/purple/lib/pkgconfig:~/webos/wpe/staging-glibc-252/lib/pkgconfig
pkg-config --exists purple glib-2.0 json-glib-1.0 zlib && echo DEPS-OK

cd ~/webos/discord-port/src
git clone https://github.com/EionRobb/purple-discord
cd purple-discord
# match the transport's generic type_discord -> prpl-discord mapping:
sed -i 's/#define DISCORD_PLUGIN_ID .*/#define DISCORD_PLUGIN_ID "prpl-discord"/' libdiscord.c
make CC="$CC" libdiscord.so
arm-unknown-linux-gnueabi-strip libdiscord.so   # optional
```
Verify: `file libdiscord.so` → ARM shared object; `arm-...-nm -D libdiscord.so | grep purple_init_plugin`.

## Install (device connected via novacom)
```bash
BACKEND_PURPLE2=/media/cryptofs/apps/.../backend/lib/purple-2 ./deploy-discord.sh
```
Then Settings → Accounts → Add account → Discord (email + password).

## Notes
- Backend (libpurple 2.14 + ssl-openssl TLS 1.3) must already be live from teams-port.
- 2FA: code arrives as an in-chat `request_input`; or use a Discord user token as the password.
