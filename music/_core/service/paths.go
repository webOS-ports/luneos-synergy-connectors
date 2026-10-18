package main

import (
	"os"
	"strings"
)

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

// packagedConfigDir holds defaults the image may ship, such as the Spotify and
// Jamendo client ids a build sets with SPOTIFY_CLIENT_ID / JAMENDO_CLIENT_ID
// (the luneos-synergy-music recipe). A file of the same name in spotifyDataDir
// overrides it on one device.
const packagedConfigDir = "/etc/spotify-webos"

// configPaths lists where the named config file is looked for, in order.
func configPaths(name string) []string {
	return []string{spotifyDataDir + "/" + name, packagedConfigDir + "/" + name}
}

// readFirstNonEmpty returns the trimmed contents of the first of paths that
// exists and is not blank, and the path it came from.
func readFirstNonEmpty(paths ...string) (string, string) {
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if s := strings.TrimSpace(string(b)); s != "" {
			return s, p
		}
	}
	return "", ""
}

// findExecutable returns the first of paths that is a regular file with an
// execute bit, or "".
func findExecutable(paths ...string) string {
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return p
		}
	}
	return ""
}
