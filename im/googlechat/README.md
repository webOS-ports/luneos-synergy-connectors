# googlechat — Google Chat IM for webOS (TouchPad 3.0.5) via libpurple

Rides the same libpurple 2.14 + ssl-openssl backend as the other IM connectors. The prpl is
**EionRobb/purple-googlechat** (`prpl-googlechat`), vendored under `plugin/purple-googlechat/`.

## Build the prpl
```bash
cd messaging/googlechat
./build-googlechat.sh    # -> plugin/purple-googlechat/build-arm/libgooglechat.stripped.so (+ libprotobuf-c.stripped.so)
```
Google Chat's wire protocol is **protobuf**, so this connector adds a protobuf-c dependency
beyond Facebook's (json-glib + zlib, both already on-device):
- `googlechat.pb-c.{c,h}` are **pre-generated** (protoc-c 1.4.1) and vendored, so no host
  `protoc-c` is needed to build.
- the small **libprotobuf-c runtime** (v1.4.1, `protobuf-c-runtime/`) is cross-compiled to
  `libprotobuf-c.so.1` and linked; it is staged on-device alongside the plugin.

Verify: `readelf -h` → ARM DYN; `nm -D … | grep purple_init_plugin` → 1; the generic
`type_googlechat → prpl-googlechat` mapping works with no LibpurpleAdapter override.

## Install (device connected via novacom)
```bash
BACKEND_PURPLE2=/media/cryptofs/apps/.../backend/lib/purple-2 ./deploy-googlechat.sh
```
Then Settings → Accounts → Add account → Google Chat.

## Auth — five cookies
purple-googlechat has no username/password or webview-OAuth flow; it authenticates with five
browser cookies. Sign in to **chat.google.com** in a private window, extract **COMPASS, SSID,
SID, OSID, HSID** (see upstream's
[Authentication](https://github.com/EionRobb/purple-googlechat#Authentication)), and paste them
into the setup app. They are stored as the prpl's protocol string options (`COMPASS_token`, …)
via imlibpurple's `config` → `purple_account_set_string` passthrough
(`Util::createPurpleAccount`), and the prpl reads them on connect.

## Notes
- Backend (libpurple 2.14 + ssl-openssl TLS 1.3) must already be live from teams-port.
- **Reliability**: upstream login breaks periodically as Google changes endpoints (recurring
  upstream issues). Best-effort, not a stable protocol.
