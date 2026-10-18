# Telegram video calling — status

## Symptom

Placed a real Telegram video call (TouchPad -> phone, `luna-send dial {"address":"id8864003499",
"video":true}`, matching the exact contract `WHATSAPP_VIDEO_STATUS.md` Part 20 proved works). Call
connects (`activateCall`, audio both directions confirmed), `clonk session open` /
`videoCaptureStart` / `videoPlayerStart` all return `{"returnValue":true}`. The peer's phone shows
only its own self-view — no incoming video from the TouchPad ever arrives. This is a **first-time
test** for Telegram specifically (not a regression) — `voipkit.cpp` is proven working end-to-end
for WhatsApp (`WHATSAPP_VIDEO_STATUS.md` Parts 19-21, human-confirmed real video both directions).

## What's confirmed working

Verified via a manually-launched `mediaserver --gst-debug=4` instance (`stop mediaserver`; run
`ionice -c1 /usr/bin/mediaserver --gst-debug=4 --spawn --no-leak-hack` in the foreground,
redirected to a file; `start mediaserver` afterward to restore — same recipe
`WHATSAPP_VIDEO_STATUS.md` Part 11/16 used):

- **Camera capture**: `Camera Source` pulls real buffers continuously, steady ~65ms cadence,
  sustained for minutes — genuinely live, not a startup blip.
- **H.264 encoding**: `Palm Video Encoder` produces real, varying-size H.264 frames (500-600 bytes
  typical, occasional larger keyframes) continuously from the live camera feed.
- **GStreamer pipeline linking**: zero `busMsg_ERROR`, zero "not linked" warnings on the capture
  side. `clonkvhsink` (the sink that should hand frames to SkypeKit) receives buffer-alloc calls
  continuously and steadily for the whole call — GStreamer itself thinks everything is fine.

None of this is the problem. Note mediaserver forks a **separate `media-pipeline` process per
session** (the `--spawn` flag) — the gst-debug output above is actually process `media-pipeline`
(PID varies per run), not the `mediaserver` launcher PID itself. Check the right PID's `/proc/PID/fd`
when correlating socket ownership.

## Root cause, as far as traced

`RunVideoHost()` (inside `libpalmgstskype.so`, closed-source) has a documented strict two-phase
gate — reverse-engineered for WhatsApp in `WHATSAPP_VIDEO_STATUS.md` Part 17:

1. Loop calling `Sid::AVServer::Connect("/tmp/vidrtp_from_skypekit_key", isServer=true, 10000)`
   until something connects **inbound**. This is `voipkit.cpp`'s Thread B's job (client-connects
   to this same path).
2. **Only once phase 1 succeeds**: `Sid::AVTransportWrapper::Connect("/tmp/vidrtp_to_skypekit_key",
   isServer=false, 500)` — the outbound dial into *our* Thread A's listening socket.

Confirmed live tonight: mediaserver's `media-pipeline` process (found via `/proc/net/unix` inode
ownership) genuinely **is** listening on `vidrtp_from_skypekit_key` (phase 1 setup done), with
**zero connected peers** the entire call. Thread A's own listening socket (`vidrtp_to_skypekit_key`)
is bound (confirmed via `/proc/net/unix`) but never gets an incoming connection either — consistent
with phase 2 never being reached.

**The actual bug**: `voipkit.cpp`'s Thread B never even attempts the `connect()` syscall.
Confirmed via `strace -f -p <transport_pid> -e trace=connect,socket` attached live during an active
call — zero `connect()` calls toward any `AF_UNIX`/`vidrtp` path across ~90s of observation, despite
Thread B supposedly retrying in its own loop. `tg-call:` (voipkit.cpp's own log prefix) has **never
appeared once** in `/media/cryptofs/imstdout.log`'s full history (189919 lines checked) — neither
Thread A's "accepted a connection" nor Thread B's "connected to mediaserver" ever fired, even from a
guaranteed-fresh process (ruled out stale `g_running` state via a full transport restart + retest).

Thread A's socket being genuinely bound (not just attempted) rules out a bind-level failure for
Thread A specifically. The open question is why Thread B — a plain client `connect()` to an
already-listening socket — never fires the syscall at all. Candidates not yet checked:
- A blocking wait *before* the connect call that never releases (would show as a `futex_wait_queue_me`
  thread in `/proc/PID/task/*/wchan` — several threads were in that state during the observation
  window, plausible candidates, not individually identified).
- Something in `voipkit_video_start()`'s "wait for thread A to start" barrier logic
  (`pthread_cond_wait` on `g_start_cv`) not actually releasing before thread B's `pthread_create` is
  reached, if thread A's own broadcast doesn't fire for some Telegram-specific reason (thread A's
  *own* broadcast happens before its main retry loop, so this seems unlikely but wasn't directly
  instrumented).

## Next steps

- Attach `gdb`/`gdbserver` (both present on-device, confirmed) to the live transport process during
  an active video call and get a real backtrace of whichever thread is Thread B, to see exactly
  which call it's blocked in.
- Consider adding a temporary `fprintf` right at the top of `thread_b_main()` (before the
  `avtw_connect` loop even starts) to confirm whether the thread body is entered at all, vs. stuck
  in `voipkit_video_start()`'s own thread-A-started barrier before `pthread_create(&g_thread_b,...)`
  is ever reached.
- Worth checking whether this reproduces for **Teams** too — tonight's Teams architecture pivot
  (see the "teams calling: move H.264/skypekit video bridge into the plugin process" commit) put
  `voipkit.cpp` in-process for Teams as well, using the exact same Thread A/B mechanism. Teams'
  own test tonight only confirmed the *new* relay-socket layer (`teams_media` <-> plugin) works —
  it never separately confirmed `voipkit.cpp`'s own Thread A/B against mediaserver, so it may hit
  this exact same bug. Re-check with the same `--gst-debug=4` + `strace` recipe above before
  assuming Teams' outgoing video is any further along than Telegram's.

## Device state, verified clean

Manually-started `mediaserver --gst-debug=4` instance and the attached `strace` were both killed;
normal upstart-managed `mediaserver` restored via `start mediaserver` (new PID, confirmed alive).
Test Telegram call hung up cleanly. No leftover debug/trace processes.

## Also noted, not directly implicated here but worth knowing

`/proc/net/unix` showed **two separate socket bindings** to the identical abstract name
`vidrtp_to_skypekit_key` within the same transport process (different inodes, fds ~2 apart, same
timestamp) — most likely Thread A's own retry loop leaking a socket per failed `avtw_connect()`
attempt (a cleanup bug in `avtw_dtor()` or in how we drive it, not a cross-plugin collision — ruled
out WhatsApp/Teams both being idle at the time). Not confirmed as related to the Thread B mystery
above, but worth keeping in mind: **all three plugins (WhatsApp, Telegram, Teams) hardcode the
identical socket paths** (`/tmp/vidrtp_to_skypekit_key` / `/tmp/vidrtp_from_skypekit_key`), and all
three can be loaded into the same `imlibpurpletransport` process simultaneously. If two plugins ever
have `voipkit_video_start()` active at the same time, only one can realistically hold the real,
functioning listener — worth a real test (two simultaneous video calls, different protocols) once
the Thread B issue above is resolved.
