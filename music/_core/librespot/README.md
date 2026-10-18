# librespot on webOS — port notes

Full-track Spotify playback on legacy webOS requires **librespot** (open-source
Rust Spotify client). The Web API only returns metadata; `preview_url`s are
deprecated and the Web Playback SDK needs Widevine/EME. librespot is the only
path to real audio on this hardware.

## Requirements & facts
- **Spotify Premium** — mandatory; librespot will not work with free accounts.
- **Rust**, cross-compiled to `arm-unknown-linux-gnueabihf` (ARMv7, matches
  TouchPad/Pre3 Cortex-A9). Upstream provides Docker-based ARM cross builds.
- Audio backend: build with an ALSA or PulseAudio sink that maps to the device's
  audio path. This is the main integration risk — verify the sink actually
  reaches the webOS media/audio stack.

## Role in this project
librespot runs as a **Spotify Connect receiver** named `webOS`. It is *not*
controlled directly by the app; the Go backend (`service/`) issues standard
Connect commands (transfer playback + play/pause/seek) via the Spotify Web API,
and librespot plays the audio. See `../docs/ARCHITECTURE.md`.

## Milestones
1. Cross-compile a bare librespot for ARMv7; run on device, log in (Premium).
2. Confirm it appears in `GET /me/player/devices` (the backend auto-selects it).
3. Get audio out of the ALSA/Pulse sink through the device speakers/headset.
4. Native launch (upstart/init) on boot, restart-on-crash, localhost only.
5. Measure command latency; decide whether to keep Connect-control (Phase 3).

## Alternatives considered
- **Connect-only remote control** (no on-device audio) — control playback on a
  phone/desktop. Falls back to this automatically if the librespot port stalls.
- **librespot direct player API** — lower latency than Connect-control but
  requires a custom control channel; revisit only if latency is a problem.
