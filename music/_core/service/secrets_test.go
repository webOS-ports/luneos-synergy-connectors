package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// No test reaches the real bus: secretCall answers as luna-send does when it is
// not there, unless a test puts fakeKeymanager in its place.
func TestMain(m *testing.M) {
	secretCall = func(string, string) (map[string]interface{}, error) {
		return nil, errors.New("no bus in the tests")
	}
	os.Exit(m.Run())
}

// fakeKeymanager answers store, fetchKey and remove as com.palm.keymanager did on
// the MindPhone (2026-10-29): store refuses a key that is there, fetchKey hands
// back keydata for a key stored nohide, and a key that is not there is an error.
type fakeKeymanager struct {
	keys  map[string]map[string]interface{}
	calls []string
}

func useFakeKeymanager(t *testing.T) *fakeKeymanager {
	t.Helper()
	km := &fakeKeymanager{keys: map[string]map[string]interface{}{}}
	old := secretCall
	secretCall = km.call
	t.Cleanup(func() { secretCall = old })
	return km
}

func (km *fakeKeymanager) call(uri, payload string) (map[string]interface{}, error) {
	method := strings.TrimPrefix(uri, keymanagerURI)
	km.calls = append(km.calls, method)
	var args map[string]interface{}
	if err := json.Unmarshal([]byte(payload), &args); err != nil {
		return nil, err
	}
	name, _ := args["keyname"].(string)
	notFound := map[string]interface{}{"returnValue": false, "errorCode": -9999.0,
		"errorText": "MojoService: no errorCode supplied Key not found"}
	switch method {
	case "store":
		if _, there := km.keys[name]; there {
			return map[string]interface{}{"returnValue": false, "errorText": "Key already exists."}, nil
		}
		km.keys[name] = args
		return map[string]interface{}{"returnValue": true}, nil
	case "fetchKey":
		k, there := km.keys[name]
		if !there {
			return notFound, nil
		}
		out := map[string]interface{}{"returnValue": true, "keyname": name, "type": k["type"], "nohide": k["nohide"]}
		if k["nohide"] == true {
			out["keydata"] = k["keydata"]
		}
		return out, nil
	case "remove":
		if _, there := km.keys[name]; !there {
			return notFound, nil
		}
		delete(km.keys, name)
		return map[string]interface{}{"returnValue": true}, nil
	}
	return nil, errors.New("unexpected method " + method)
}

func (km *fakeKeymanager) value(t *testing.T, name string) (string, bool) {
	t.Helper()
	k, there := km.keys[name]
	if !there {
		return "", false
	}
	b, err := base64.StdEncoding.DecodeString(k["keydata"].(string))
	if err != nil {
		t.Fatalf("%s: keydata is not base64: %v", name, err)
	}
	return string(b), true
}

func (km *fakeKeymanager) count(method string) int {
	n := 0
	for _, c := range km.calls {
		if c == method {
			n++
		}
	}
	return n
}

func secretTestPaths(t *testing.T, names ...string) []string {
	t.Helper()
	dir := t.TempDir()
	var paths []string
	for _, n := range names {
		paths = append(paths, filepath.Join(dir, n))
	}
	old := secretPaths
	secretPaths = func() []string { return paths }
	t.Cleanup(func() { secretPaths = old })
	return paths
}

func readBack(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestWriteSecretStoresFileAndKeymanagerCopy(t *testing.T) {
	km := useFakeKeymanager(t)
	path := secretTestPaths(t, "tidal-token")[0]

	if err := writeSecret(path, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := writeSecret(path, []byte("refreshed")); err != nil {
		t.Fatal(err)
	}
	if got := readBack(t, path); got != "refreshed" {
		t.Errorf("file = %q", got)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0600 {
		t.Errorf("file mode = %v, want 0600", fi.Mode().Perm())
	}
	// Replaced, not refused: keymanager's store will not overwrite a key.
	if got, _ := km.value(t, "tidal-token"); got != "refreshed" {
		t.Errorf("keymanager = %q, want the refreshed token", got)
	}
	if k := km.keys["tidal-token"]; k["nohide"] != true || k["type"] != "BLOB" {
		t.Errorf("stored as %v; fetchKey hands back only a key stored nohide", k)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("temporary file left behind: %v", err)
	}
}

func TestWriteSecretWithoutKeymanagerStillWritesTheFile(t *testing.T) {
	// secretCall as TestMain left it: no bus.
	path := secretTestPaths(t, "deezer-arl")[0]
	if err := writeSecret(path, []byte("arl")); err != nil {
		t.Fatalf("a missing keymanager failed the login: %v", err)
	}
	if got := readBack(t, path); got != "arl" {
		t.Errorf("file = %q", got)
	}
}

func TestRemoveSecretRemovesBoth(t *testing.T) {
	km := useFakeKeymanager(t)
	path := secretTestPaths(t, "qobuz-auth")[0]
	if err := writeSecret(path, []byte("me@example.org\npw\n")); err != nil {
		t.Fatal(err)
	}
	removeSecret(path)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("file still there: %v", err)
	}
	if _, there := km.value(t, "qobuz-auth"); there {
		t.Error("keymanager copy still there: it would come back at the next start")
	}
	// Nothing comes back from a sync either.
	syncSecrets()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("sync brought a removed secret back: %v", err)
	}
}

func TestSyncSecrets(t *testing.T) {
	km := useFakeKeymanager(t)
	paths := secretTestPaths(t, "spotify-token.json", "librespot-token.json", "tidal-token", "deezer-arl", "youtube-oauth.json")
	spotify, librespot, tidal, deezer, youtube := paths[0], paths[1], paths[2], paths[3], paths[4]

	// A login from before keymanager: only the file.
	if err := os.WriteFile(spotify, []byte(`{"refresh_token":"old-login"}`), 0600); err != nil {
		t.Fatal(err)
	}
	// A restored device: only keymanager's copy.
	if err := storeSecret("librespot-token.json", []byte(`{"refresh_token":"restored"}`)); err != nil {
		t.Fatal(err)
	}
	// Both, the same: left alone.
	if err := writeSecret(tidal, []byte("same")); err != nil {
		t.Fatal(err)
	}
	// Both, different: the file is the copy in use, and wins.
	if err := os.WriteFile(deezer, []byte("current"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := storeSecret("deezer-arl", []byte("stale")); err != nil {
		t.Fatal(err)
	}
	// youtube: neither.
	km.calls = nil

	syncSecrets()

	if got, _ := km.value(t, "spotify-token.json"); got != `{"refresh_token":"old-login"}` {
		t.Errorf("an existing login was not stored: %q", got)
	}
	if got := readBack(t, librespot); got != `{"refresh_token":"restored"}` {
		t.Errorf("restored file = %q", got)
	}
	if fi, _ := os.Stat(librespot); fi.Mode().Perm() != 0600 {
		t.Errorf("restored file mode = %v, want 0600", fi.Mode().Perm())
	}
	if got, _ := km.value(t, "deezer-arl"); got != "current" {
		t.Errorf("keymanager = %q, want the file's", got)
	}
	if got := readBack(t, deezer); got != "current" {
		t.Errorf("the file was overwritten: %q", got)
	}
	if _, err := os.Stat(youtube); !os.IsNotExist(err) {
		t.Errorf("a secret neither side had appeared: %v", err)
	}
	// Five fetches, and a store each for spotify and deezer only.
	if f, s := km.count("fetchKey"), km.count("store"); f != 5 || s != 2 {
		t.Errorf("fetchKey %d times, store %d times (calls %v); want 5 and 2", f, s, km.calls)
	}
}

func TestSyncSecretsWithoutKeymanagerLeavesFilesAlone(t *testing.T) {
	path := secretTestPaths(t, "spotify-token.json")[0]
	if err := os.WriteFile(path, []byte("tok"), 0600); err != nil {
		t.Fatal(err)
	}
	syncSecrets()
	if got := readBack(t, path); got != "tok" {
		t.Errorf("file = %q", got)
	}
}

func TestSecretPathsCoverEveryCredentialFile(t *testing.T) {
	want := map[string]bool{
		"spotify-token.json": true, "librespot-token.json": true, "qobuz-auth": true,
		"deezer-arl": true, "tidal-token": true, "youtube-oauth.json": true, "apple-music-user-token": true,
	}
	for _, p := range secretPaths() {
		if !strings.HasPrefix(p, spotifyDataDir+"/") && p != tokenPath {
			t.Errorf("%s is outside %s", p, spotifyDataDir)
		}
		delete(want, secretName(p))
	}
	for name := range want {
		t.Errorf("%s is not looked after", name)
	}
}
