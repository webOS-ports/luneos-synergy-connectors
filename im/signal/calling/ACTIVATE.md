# Signal calling (signaling-only v1) — on-device activation

Implements: incoming Signal calls **ring the stock Phone app** with the caller's name; **decline** works;
**missed calls** land in the Signal thread. No media yet (RingRTC audio is a separate, larger effort — see
the IM-voice-calling dossier / memory). Mirrors the Telegram M2 `call-luna` pattern.

## Already done (in repo + on device)
- Code: `src/rust/src/receive.rs` (CallMessage → `handle_call_state`), `src/rust/src/bridge.rs`
  (FFI + `CALL_STATE_*`), `src/c/call.c` (LS2 service `com.palm.signal.call`, main-thread-marshalled),
  `src/c/connection.c` (`callLunaInit` on login), `src/c/presage.h`.
- Build: `messaging/signal/build-presage.sh` (adds `call.c` + links luna-service2). Rebuilt & symbol-verified
  (`callLunaInit`, `presage_handle_call_state`, `com.palm.signal.call`). Output md5 `67e281976e...`.
- Device (staged, non-disruptive — running Signal untouched):
  - `libpresage.so` (with call service) in place at `com.palm.app.teams/backend/lib/purple-2/`
    (backup `libpresage.so.b4call`).
  - Transport role `/usr/share/ls2/roles/prv/com.palm.imlibpurple.json` → `com.palm.signal.call` allowed.
  - `com.palm.signal.call` pub role + `.service` file staged (`messaging/signal/calling/...`).

## Remaining — run ATTENDED, after a REBOOT (the device was memory-pressured: ~37 MB free, load ~4)

1. **Reboot** the TouchPad to clear the imlibpurpletransport memory bloat, then reconnect novacom.

2. **Add the PHONE capability** to the Signal account (db8 is cached, so edit the record, like Telegram).
   With a healthy device (`listAccounts` returns data):
   ```sh
   luna-send -n 1 palm://com.palm.service.accounts/listAccounts '{}' > /tmp/acc.json
   # get the Signal account _id + its current capabilityProviders array, append this PHONE provider:
   #   {"capability":"PHONE","id":"com.palm.signal.call","alwaysOn":true,
   #    "implementation":"palm://com.palm.signal.call/","serviceName":"type_signal"}
   # then merge the full (existing + PHONE) array back by _id:
   luna-send -a com.palm.service.accounts -n 1 palm://com.palm.db/merge \
     '{"objects":[{"_id":"<SIGNAL_ID>","capabilityProviders":[ <MESSAGING>, <CONTACTS>, <PHONE> ]}]}'
   ```
   (Same recipe that made Telegram PHONE-capable. `-a com.palm.service.accounts` is the write identity.)

3. **Load the new role/.service + restart the plugin host:**
   ```sh
   ls-control scan-services            # picks up the role + .service without a full hub restart
   kill $(pidof imlibpurpletransport)  # respawns via activation, loads the new libpresage.so
   ```

4. **Verify:**
   ```sh
   ls-monitor -l | grep com.palm.signal.call            # service registered (after Signal logs in)
   luna-send -n 1 -f palm://com.palm.signal.call/callStateQuery '{}'   # {returnValue:true, lines:[]}
   ```

5. **Test:** have someone place a Signal voice call to this account → the stock Phone app should ring with
   the caller's name; Decline should dismiss it; a missed call should appear in the Signal thread.

## Known limits of v1
- **No audio** (signaling only). `answer` intentionally returns false (declines) — accepting without media
  would fake a connected call with silence.
- **Decline is local** (dismisses the ring). Sending a Signal `Hangup` back so the caller's phone stops
  ringing is v2 (needs a Rust send path: `presage_rust_send_call_hangup`).
- **No outgoing** calls (`dial` returns false).
