# Teams NGC voice calling — status & morning runway

## ⭐ 2026-08-05 session: video RTP fix, ICE-storm fix, and the real blocker (dual-instance launch race)

Picked up from the 08-01 checkpoint (MediaError-410 fixed, video SDP shape matches a real capture).
Five real, evidenced fixes this session, plus one still-open gap.

### 1. Video RTP wire-format bug (`voipkit.cpp`) — same class of bug already fixed in
WhatsApp/Telegram this marathon, ported over: `kRtpPacketReceivedCmdId` was `20`, should be `19`
(ProcessCall's real dispatch key, traced via VideoHost's ELF-relocation vtable — see
`messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md` Part 36 for the full trace), and
`send_one_packet()`'s `wr_call_lst` call used the broken `(&cmdId, "RtpPacketReceived")` calling
convention (writes the literal debug string onto the wire, never a real protocol header) instead of
the real `[0x5a]['R'][2 LEB128 varints]` header. Both fixed, built, deployed.

### 2. ICE-restart storm from un-deduplicated renegotiation pushes (`teams_calling.c`)
Teams' trouter can redeliver the *identical* renegotiation push (confirmed live: 4 of 5
renegotiation frames in one real call shared the exact same remote ICE ufrag within ~2 seconds).
`teams_calling_handle_renegotiation()` unconditionally sent a fresh `RESTART` to the media engine
for every push, tearing down and rebuilding the ICE agent every time — no single ICE session ever
got long enough uninterrupted to finish connectivity checks before being restarted again. Fixed:
track `mp->last_restarted_ufrag`, skip the `RESTART` (but still update `video_active`/answer) when
the ufrag hasn't actually changed. Verified live in a real call: two duplicate pushes correctly
logged `"same ufrag as last RESTART... skipping"` instead of restarting; the call held stably
through multiple genuine renegotiations and ended on a normal user hangup.

### 3. Stale call-registration renewal (`teams_trouter.c`)
`teams_trouter_register()`'s periodic renewal timer was `TEAMS_TROUTER_TTL - 10` (~24h, based on
the `ttl:86400` value *we* send in the registration body). Real-world evidence: a call placed ~30
minutes after the last successful registration, with zero renewal in between (the 24h timer never
gets remotely close to firing in any real session), failed in ~2s on the caller's side with
*nothing* reaching our trouter at all — the SkypeSpacesWeb/TFL calling registration goes stale well
under 24h regardless of what TTL we request. Renewal interval changed to 5 minutes.

### 4. Outgoing offer SDP — hardcoded placeholder address + unfiltered ICE-TCP candidates
(`media_send_offer()`, `teams_calling.c`). This path was always the least-validated one (no HAR
capture of an outgoing-with-video offer existed before this session). Two bugs, both ported from
the already-validated `build_answer_sdp()`: (a) `m=`/`c=` hardcoded `0.0.0.0:3480` instead of a
real address derived from the first gathered UDP host candidate; (b) all candidates were emitted
unfiltered, including ICE-TCP ones — `build_answer_sdp()` already had a comment explaining Teams'
NGC parser can reject the *whole* blob over ICE-TCP lines, but the offer never got the same fix.
Both fixed. Confirmed real improvement live: before, outgoing calls got an instant/silent
`code=408 "no signaling after attach from callee endpoints"` every time; after, the callee's
client now actually parses the offer and answers (`mediaAnswer` received, call goes active with
audio) — never happened before this fix.

### 5. THE REAL BLOCKER: dual-instance transport launch race (found + fixed, cross-connector)
Most of a night's remaining flakiness (calls "registered" but never receiving `dial`, hours of
total log silence, a call that seemed to work but the callee never got the signaling) traced to an
infrastructure bug, not application code: `ls-hubd`'s on-demand activation races independently
against the upstart-managed resident daemon, and — because all four connectors' own
`com.palm.<x>.call.service` files bypassed the launch wrapper (`Exec=/usr/bin/imlibpurpletransport`
directly, skipping the PmLog semaphore self-heal, SSLFIX, and log redirection `imwrap.sh` provides)
— the losing instance in that race could be a fully-alive, fully-logged-in, permanently
unresponsive ghost process for hours. Full writeup, fix, and verification steps:
`files/var/README-device-launch.md` in the imlibpurpleservice repo ("Dual-instance
launch race"). Two-part fix: route all four `.call.service` files through `imwrap.sh`; add a
`mkdir`-based singleton lock in `imwrap.sh` itself. Both deployed and verified live (single clean
process tree + clean single registration sequence, confirmed after this fix by killing the
transport and checking `ps` + the log for the rejected-duplicate-launch message).

### Still open
- **Outgoing calls: `408 "Call Controller timed out while waiting for acknowledgement"`.** Now
  gets much further (mediaAnswer received, active with audio — fix #4 above) but still fails after
  the callee's `acceptance` push. Ruled out: a missing HTTP ack (mined a real outgoing-call HAR's
  decoded trouter WebSocket frames — `/home/herrie/Downloads/teams.live.com-outgoing.har` has a
  `_webSocketMessages` array with the full real signaling sequence — the real client does nothing
  beyond the same generic trouter-level `3:::{id,status:200}` push-ack our code already sends
  unconditionally for every frame). Current best guess: a genuine ICE/media end-to-end connectivity
  gap on the callee's side against our offered candidates (`teams-media.log` does show `ICE state
  connected`/`ready` reachable in general, but the specific failing call went silent for 32s with
  no further renegotiation after `acceptance`, unlike working calls). Not yet root-caused with a
  clean, isolated test (every outgoing attempt this session was confounded by either the
  dual-instance bug or overlapping-call testing artifacts — see below).
- **Video over a real, clean single call**: not yet cleanly confirmed either direction. Every test
  that showed "connects then drops in ~7s, no video" this session turned out to have a confounding
  factor once traced: either (a) a trouter reconnect landing mid-call (self-inflicted, from a
  redeploy moments earlier), (b) two overlapping calls racing on the same account (our code only
  tracks one `TeamsCall` per account — a second call's teardown can collaterally kill state a first,
  still-active call was relying on), or (c) a one-off network I/O error on the `attach` POST
  (`Error reading from api.flightproxy.skype.com: Input/output error`, trouter's own WebSocket
  dropped within the same second) — not an application bug. A genuinely clean, single, isolated
  call (no recent redeploy, no second call anywhere near it) hasn't been tested since the
  dual-instance fix landed. That's the highest-value next test.
- **Real HAR captures now available** for future digging: `~/Downloads/teams.live.com.har`,
  `teams.live.com-outgoing.har`, `teams.live.com-incoming.har`, `teams.live.com-incoming-video.har`
  — each has a decoded `_webSocketMessages` array with the real trouter push/ack sequence, not just
  WebRTC-level SDP/ICE stats (which `calling/captures/rtcstats_dump` +`webrtc_internals_dump`
  already cover). Use these before guessing at any further signaling-shape questions.


## ⭐ 2026-07-29 overnight: FULL PATH BUILT + DEPLOYED (signaling verified, media = first attempt)

**Verified working on device:** incoming personal-Teams call is delivered → parsed → **rings the
stock Phone app → answers → shows connected**. The registration fix (SkypeSpacesWeb @
teams.microsoft.com, TFL context — see below) made delivery work; a **single** transport instance
is required (respawn storms break delivery). Full offer captured (`scratchpad/teams-offer.json`):
`application/sdp`, RTP/SAVP, **SDES `a=crypto` AEAD_AES_256_GCM** (key inline), codecs **opus(102)+
G722(9)**, real **ICE + MS-TURN relay**, answer→`links.attach`.

**Built + deployed (this is the "build everything" drop):**
- `teams_media` engine (`calling/media/teams_media.c`) — fork of Signal's gst-1.20 engine; GCM SRTP
  + Opus + libnice ICE, SDES keying. **`--loopback` PASSES on device.** Deployed patchelf'd at
  `/media/internal/teams_media`.
- `teams_calling.c` integration: on answer it parses the offer, spawns `teams_media --answer`, feeds
  START + peer candidates, reads back our ICE creds + TX key + candidates, builds an SDP answer and
  POSTs it to `links.attach`. Deployed in the plugin.

**MORNING TEST (device must be at ONE transport instance — check `pidof imlibpurpletransport | wc -w`):**
1. From Android/another Teams client, **call the test Teams account the device is signed in with**. It should ring on webOS; answer it.
2. Watch: `tail -f /media/internal/teams-call.log` (signaling + integration) and
   `tail -f /media/internal/teams-media.log` (ICE/pipeline). Look for: `INCOMING call` → `answer:` →
   `media_start: spawned teams_media` → `media engine READY` → `ICE state ...` → `ANSWER SDP built,
   posting to attach` → `post_answer -> ...`.
3. **What likely needs iteration (this is a first, un-live-tested attempt):**
   - the **answer-SDP shape** (currently a best-effort mirror of the offer — `media_send_answer()`),
   - the **attach POST body/auth** (currently `{"mediaContent":{contentType,blob,mediaLegId}}` — may
     need the exact web-client shape / a specific token; `teams_calling_post_answer()`),
   - **ICE**: whether libnice pairs with Teams' MS-ICE candidates, or needs the MS-TURN relay (the
     `udpTransport` + `udpKey.ticket`) added via a `RELAY turn` line to the engine,
   - the caller connecting = answer accepted + ICE connected + SRTP flowing.
   The captured offer in `scratchpad/teams-offer.json` (and a fresh capture) is the reference for all four.
4. Debug the engine alone: `teams_media --loopback` (env in `calling/media/`); it already passes.
5. Commits: `fd8a147` (signaling+reg fix), `258725d` (engine), `368d212` (integration).

---



Overnight build of native Microsoft Teams 1:1 voice calling for the webOS Teams connector
(`purple-teams`). This is the "Option A" full-native path. Everything that does **not** need a
live-call capture is built, compiling for ARM, and ready to deploy. The remaining work is the
media engine, which is a **bounded diff** once we have one real call captured.

---

## TL;DR

- **Protocol (settled by research):** Teams calls use **NGC** (NextGenCalling / legacy Skype
  media), NOT WebRTC. SDES-SRTP (`AES_CM_128_HMAC_SHA1_80`), master key delivered out-of-band in
  `udpKey.sessionKey`; **no DTLS**. Media via a single **MS-TURN** relay (`:3478`) authed by
  `udpKey.ticket` (MRAS). Codecs SILK / Satin / G.722 (**not** Opus). No open-source engine exists
  to lift wholesale, but every piece is documented/standard except MS-TURN's ticket auth.
- **Built tonight (all compile for ARM):** capture harness, full NGC signaling module, the webOS
  LS2 Phone-app bridge (`com.palm.teams.call`), the account PHONE capability + LS2 role/service
  grants, and the media-engine base + adaptation spec.
- **Blocking unknowns (need ONE captured call):** exact SDP dialect + codec list, whether the SRTP
  key is in the SDP `a=crypto` or only `udpKey.sessionKey`, and the MS-TURN allocate/auth shape.
- **Morning step 1:** deploy, place/receive a real Teams call, read
  `/media/internal/teams-call-capture.log`.

---

## Architecture (two layers)

**Layer 1 — webOS bridge (DONE, reused pattern).** Stock Phone app ⇄ `com.palm.teams.call`
(LS2: `dial/answer/disconnect/callStateQuery`) ⇄ `teams_calling.c`. Copied from the working
Telegram/WhatsApp mediators.

**Layer 2 — network media (signaling DONE, media = the remaining work).** `teams_calling.c` parses
the NGC offer and drives the control plane; `teams_media` (a fork of Signal's on-device-proven
gst-1.20 nice+srtp+alsa engine) will move the audio.

```
Stock Phone app (CallSynergizer)
        │  LS2 com.palm.teams.call  (dial/answer/disconnect/callStateQuery)
        ▼
teams_call_luna.c ──registers state cb──► teams_calling.c
        ▲                                        │ parses NGC offer (sdp/udpKey/links)
        │ push state (incoming/active/…)         │ reject/answer/hangup over the control links
        │                                        ▼
   audiod (phone scenario)              teams_media  (RX/TX SRTP+codec via MS-TURN relay)  ← TODO
                                          alsasink=voip / alsasrc=voipsource
```

## What's built (files)

| File | What | Status |
|---|---|---|
| `plugin/purple-teams/teams_calling.{c,h}` | Capture + NGC parse + state machine + reject/answer/hangup/dial | **compiles** |
| `plugin/purple-teams/teams_call_luna.{c,h}` | LS2 `com.palm.teams.call` bridge (dial/answer/disconnect/callStateQuery + audiod) | **compiles + links LS2** |
| `plugin/purple-teams/teams_trouter.c` | NGC handler now hands off to `teams_calling_handle_trouter()` (was: printed "Incoming call") | **compiles** |
| `plugin/purple-teams/libteams.{c,h}` | `active_call` field; `teams_call_luna_init()` on login (guarded `TEAMS_WEBOS_CALL`) | **compiles** |
| `account/com.palm.teams/com.palm.teams.json` | + PHONE capabilityProvider → `palm://com.palm.teams.call/` | done |
| `imlibpurpleservice/.../ls2/roles/{pub,prv}/com.palm.imlibpurple.json` | grant `com.palm.teams.call` bus name | done |
| `teams/calling/ls2/roles/pub/com.palm.teams.call.json`, `teams/calling/dbus-1/.../com.palm.teams.call.service` | call-service role + registration | done |
| `build-teams.sh` | builds the calling files + links luna-service2 + `-DTEAMS_WEBOS_CALL` | **builds `libteams-personal.stripped.so`** |
| `teams/calling/media/` | Signal engine seeded as reference + `TEAMS_MEDIA_ADAPTATION.md` (Δ1-4) + `build-teams-media.sh` | spec ready |

Build: `cd messaging/teams && bash build-teams.sh` → `libteams-personal.stripped.so` (deploy as
`libteams.so`). Verified to compile & link for ARM (only the pre-existing `PURPLE_PLUGINS` warning).

## The three unknowns that need a captured call

1. **Codec + SDP dialect** — which `a=rtpmap` payloads NGC actually offers (want G.722; avoid
   Satin). Decides Δ3.
2. **Key placement** — is the SRTP master in the SDP `a=crypto` line, only in `udpKey.sessionKey`,
   or both? Decides the Δ1 parse.
3. **MS-TURN auth** — does stock libnice TURN allocate against the `:3478` relay with the MRAS
   `ticket`, or do we need a small MS-TURN client? The single biggest risk; decides Δ4.

All three are answered by one real call — the capture harness already logs everything needed.

## Morning runway

**0. Already staged on device:** the built calling plugin is at
`/media/internal/libteams-calling.so` (md5 `d6e0f557…`), ready to swap in. To activate WITH the
user (so messaging is re-verified immediately):
```
BP=/media/cryptofs/apps/usr/palm/applications/com.palm.app.teams/backend/lib/purple-2
cp $BP/libteams.so /media/internal/libteams-messaging.bak   # back up the working plugin
cp /media/internal/libteams-calling.so $BP/libteams.so      # swap in the calling build
# restart imlibpurpletransport (it respawns) -> Teams re-logs in; then place/receive a Teams call
tail -f /media/internal/teams-call-capture.log
```
The live plugin + LS2 roles were deliberately NOT swapped/restarted overnight (unattended runtime
risk to working messaging; test calls need a person anyway).

**1. Deploy** (see `deploy-teams.sh` for the plugin; the role/service/manifest files deploy with the
account bits). Push `libteams-personal.stripped.so` → device `libteams.so`, install the two role
JSONs + the `.call.service`, merge the PHONE cap (already in the source manifest), restart
`imlibpurpletransport`.

**2. Capture a call.** With Teams logged in on the device, place a call **from another Teams client
to this account** (and, separately, try placing one from the device once outgoing is modeled). Then:
```
cat /media/internal/teams-call-capture.log   # the full raw callNotification: SDP blob, udpKey, links
cat /media/internal/teams-call.log           # the parsed summary + state transitions
```
Expected today: the call **rings the stock Phone app** (state pushed via the LS2 bridge), `reject`
works (POSTs the reject link), `answer` transitions state but has **no audio yet** (media is a stub).

**3. Finish media** using the capture + `media/TEAMS_MEDIA_ADAPTATION.md`:
   - Δ1 keying (base64 `sessionKey` → 30-byte AES-CM master) + Δ2 cipher (`aes-128-icm`/`hmac-sha1-80`)
     — mechanical, do first.
   - Δ3 codec (G.722 if offered) and Δ4 MS-TURN allocate — per what the capture shows.
   - Wire `teams_calling.c`'s `teams_media_start/stop` stubs to the `teams_media` process (IPC), and
     POST the produced SDP answer to `call->link_media_answer`.

## Not done / caveats

- **Media = no audio yet** (stubbed) — the honest state; it's the post-capture work.
- **Outgoing dial** is a documented stub — the NGC *create* flow isn't in the reverse-engineered
  data; capture an outgoing call to model it. Incoming answer/reject is wired.
- **The reject/answer HTTP POST shape + auth headers** are best-effort from Eion Robb's comments;
  confirm against the capture (marked `CONFIRM WITH CAPTURE` in `teams_calling.c`).
- Satin (the default 1:1 codec) is closed — we must get the answer to select G.722 or SILK.
