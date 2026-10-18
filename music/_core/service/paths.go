package main

// spotifyDataDir is where this backend keeps ALL of its own on-device state: the
// spotify-webos-service + librespot binaries, librespot's log + cache, and every
// credential/token file (the Spotify token + client id, and the per-provider secrets
// for Deezer/Qobuz/Jamendo/YouTube/Tidal/Apple Music).
//
// It MUST live under /media/cryptofs, never /media/internal. /media/internal is the
// vfat partition exported in USB "drive mode": storaged has to unmount it, and its
// force-unmount.sh refuses to kill any holder whose executable lives on cryptofs — so
// a running librespot/backend, or an open librespot.log, sitting on /media/internal
// makes the unmount fail with "USB drive Connection failed". cryptofs is only
// SUSPENDED (not unmounted) for Mass Storage Mode, exactly like every other app, and
// it persists across reboots — so everything under here is both USB-mode-safe and
// durable.
//
// Genuinely user-facing files stay on /media/internal so they remain visible over USB:
// the Downloads dir (downloaded tracks) and the user-supplied device.wvd — see
// lossless.go / applemusic.go.
const spotifyDataDir = "/media/cryptofs/spotify-webos"
