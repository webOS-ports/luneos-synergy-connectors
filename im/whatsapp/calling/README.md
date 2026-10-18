# WhatsApp calling — unified into the messaging plugin

WhatsApp voice calling now runs **inside** the messaging plugin (`purple-gowhatsapp`,
hosted by `imlibpurpletransport`), sharing the **one** whatsmeow session that messaging
uses — exactly how Signal (`purple-presage`) and Telegram (`tdlib-purple`) do calling.

This replaces the standalone **wacallm** mediator (which had its *own* WhatsApp companion +
session `/media/internal/wacall/wa-voip.db`). That separate companion could be logged out
independently (breaking calls while messaging still worked) and needed its own pairing/LID.

## Architecture

```
  Phone app ──dial──▶ com.palm.whatsapp.call (LS2, glue/call.c) ──▶ meowcaller (call.go)
                         registered in imlibpurpletransport            │ attached to the
                         on the libpurple mainloop                     ▼ MESSAGING whatsmeow
                      ◀─callStateQuery/audio───────────────────  handler.client (shared session)
```

- `call.go` — attaches `meowcaller.NewClient(handler.client)` in `startCalling()` (called from
  `login.go` before `Connect()`); exports `gowhatsapp_go_call_dial/_answer/_hangup/_hangup_all`.
- `glue/call.c` — owns the `com.palm.whatsapp.call` LS2 service (dial/answer/disconnect/
  callStateQuery) + the ALSA `voip`/`voipsource` audio bridge + audiod `phone_back_speaker`
  routing. Registered once per process via `whatsapp_call_luna_init()` from `glue/login.c`.
- Account manifest PHONE `implementation` → `palm://com.palm.whatsapp.call/`.

Result: **adding the WhatsApp account pairs once and enables both messaging and calling**; the
call session shares the messaging session's own-LID (which meowcaller needs), and there is no
second companion to get logged out.

## Deploy (on the device)

```sh
mount -o remount,rw /
# 1. plugin (.so) — the messaging prpl, now with calling
cp libwhatsmeow.so /usr/lib/purple/libwhatsmeow.so     # (device path of the prpl)
# 2. Let imtransport own the new bus name: com.palm.whatsapp.call must be in the imlibpurple
#    role's allowedNames+permissions (same as telegram.call/signal.call). A SEPARATE role file
#    does NOT work — LS2 keys the role by exeName, so the grant lives in imtransport's own role.
cp "$IMLIB_REPO"/files/ls2/roles/prv/com.palm.imlibpurple.json /usr/share/ls2/roles/prv/
cp "$IMLIB_REPO"/files/ls2/roles/pub/com.palm.imlibpurple.json /usr/share/ls2/roles/pub/
cp dbus-1/system-services/com.palm.whatsapp.call.service /usr/share/dbus-1/system-services/
# NB: ls-hubd loads roles at BOOT — reboot (or restart the LS2 hub) after changing a role file.
# 3. account manifest with the re-pointed PHONE implementation
cp com.palm.whatsapp.json /usr/palm/public/accounts/com.palm.whatsapp/com.palm.whatsapp.json

# 4. RETIRE the old wacallm mediator (it owned com.palm.whatsapp):
kill $(pidof wacallm-luna) 2>/dev/null
rm -f /usr/share/dbus-1/system-services/com.palm.whatsapp.service \
      /usr/share/ls2/roles/prv/com.palm.whatsapp.json \
      /usr/share/ls2/roles/pub/com.palm.whatsapp.json
#    (leave /media/internal/wacallm-luna + wa-voip.db in place as a fallback until verified)

# 5. reload LS2 role/service files + restart the transport so the plugin re-registers
ls-control scan-services 2>/dev/null || true
stop imlibpurpletransport; rm -f /dev/shm/sem.PmLogLib; start imlibpurpletransport
```

Then re-provision the account's PHONE capability implementation if the account was created
before this change (so it points at `com.palm.whatsapp.call`), and restart LunaSysMgr so the
Phone app re-discovers the transport.

Verify: `luna-send -n 1 -f palm://com.palm.whatsapp.call/callStateQuery '{"subscribe":true}'`
streams call state; placing a WhatsApp call from the stock dialer rings + connects using the
messaging session.
