# whatsapp — WhatsApp IM for webOS (TouchPad 3.0.5) via libpurple

Rides the same libpurple 2.14 + ssl-openssl backend as the other IM connectors. The prpl is
**hoehermann/purple-gowhatsapp** (`whatsmeow` branch, `prpl-hehoe-whatsmeow`), a C plugin
wrapping the pure-Go **whatsmeow** multi-device WhatsApp library, vendored under
`plugin/purple-gowhatsapp/`.

## Build the prpl
```bash
cd messaging/whatsapp
./build-whatsapp.sh    # -> plugin/purple-gowhatsapp/build-arm/libwhatsmeow.stripped.so
```
Three stages (see `BUILD-LOG.md`): cross-compile the Go backend to a `c-archive`
(`GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=1 CC=arm-…-gcc`), compile the C glue, then link
`libwhatsmeow.so`. Requires:
- **Go 1.25+** host toolchain (go.mod `go 1.25.5`) + network for the first module fetch
- ARM toolchain `arm-unknown-linux-gnueabi-gcc125`, libpurple 2.14 staging (`messaging/libpurple/`)
- opus/ogg from WPE staging + **libopusfile** (cross-built from xiph/opusfile into staging)

The whole WhatsApp/SQLite stack is **pure Go** (`modernc.org/sqlite`, not cgo sqlite), which is
why the cross-compile is clean. `gdk-pixbuf` is optional (guarded by `__has_include`).

Verify: `readelf -h` → ARM DYN; `nm -D … | grep purple_init_plugin` → 1; embeds
`prpl-hehoe-whatsmeow`. The `type_whatsapp → prpl-hehoe-whatsmeow` override is in
imlibpurpleservice `LibpurpleAdapter.cpp`.

## Install (device connected via novacom)
```bash
BACKEND_PURPLE2=/media/cryptofs/apps/.../backend/lib/purple-2 ./deploy-whatsapp.sh
```
Then Settings → Accounts → Add account → WhatsApp (phone number), and finish linking from the
Messaging app.

## Auth — multi-device link
Enter your phone number in the setup app. On connect the prpl surfaces a **QR code** (WhatsApp →
Linked Devices → Link a Device) or an **8-character pairing code**; complete it from the Messaging
app. whatsmeow persists its session afterwards, so later logins reconnect silently.

## Notes
- Backend (libpurple 2.14 + ssl-openssl TLS 1.3) must already be live from teams-port.
- **Footprint**: the plugin is ~19 MB (embedded Go runtime) and its RSS (Go GC heap + threads) is
  heavy for a 1 GB 2011 device — worth watching under real use.
