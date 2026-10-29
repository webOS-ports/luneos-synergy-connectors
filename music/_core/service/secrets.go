package main

// Secrets: every token and credential file this backend keeps in spotifyDataDir
// is also stored in com.palm.keymanager, under our service id, one key per file
// named after it. The Backup app's keystore export (under the passphrase the user
// gives it) carries keymanager to another device; the files themselves are never
// in a backup, which is unencrypted and lies on /media/internal.
//
// The file stays the copy everything reads, so a slow or missing bus costs a
// backup, never a login. syncSecrets, at startup, stores what keymanager does not
// have yet (a login from before this) and writes back what only keymanager has (a
// device restored from a backup: the Backup app offers a restart afterwards).

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"
)

const keymanagerURI = "palm://com.palm.keymanager/"

// secretCall is the bus call to keymanager, replaceable by the tests.
var secretCall = lunaCall

// secretMu keeps one file's remove-then-store from interleaving with another's:
// keymanager's store will not replace a key that is there.
var secretMu sync.Mutex

// secretPaths lists every file syncSecrets looks after. A function, not a list,
// because -token-file moves tokenPath after start; a variable, for the tests.
var secretPaths = func() []string {
	return []string{
		tokenPath,
		librespotTokenPath,
		qobuzAuthFile,
		deezerArlFile,
		tidalTokenFile,
		ytTokenFile,
		appleUserTokenFile,
	}
}

func secretName(path string) string { return filepath.Base(path) }

// fetchSecret returns keymanager's copy of the named secret, if it has one.
func fetchSecret(name string) ([]byte, bool) {
	payload, _ := json.Marshal(map[string]string{"keyname": name})
	m, err := secretCall(keymanagerURI+"fetchKey", string(payload))
	if err != nil || m["returnValue"] != true {
		return nil, false
	}
	s, _ := m["keydata"].(string)
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil, false
	}
	return b, true
}

// storeSecret puts data into keymanager under name, replacing what is there.
func storeSecret(name string, data []byte) error {
	secretMu.Lock()
	defer secretMu.Unlock()
	payload, _ := json.Marshal(map[string]string{"keyname": name})
	_, _ = secretCall(keymanagerURI+"remove", string(payload)) // none there is fine
	payload, _ = json.Marshal(map[string]interface{}{
		"keyname": name,
		"keydata": base64.StdEncoding.EncodeToString(data),
		"type":    "BLOB",
		"nohide":  true, // fetchKey hands back only a key stored nohide
	})
	m, err := secretCall(keymanagerURI+"store", string(payload))
	if err != nil {
		return err
	}
	if m["returnValue"] != true {
		text, _ := m["errorText"].(string)
		return errors.New("keymanager store refused: " + text)
	}
	return nil
}

func removeStoredSecret(name string) {
	secretMu.Lock()
	defer secretMu.Unlock()
	payload, _ := json.Marshal(map[string]string{"keyname": name})
	_, _ = secretCall(keymanagerURI+"remove", string(payload))
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// writeSecret writes a secret file and stores the same bytes in keymanager. Only
// the file failing is an error: without keymanager the login still works, it is
// only left out of the next backup (and stored by the next syncSecrets).
func writeSecret(path string, data []byte) error {
	if err := writeFileAtomic(path, data); err != nil {
		return err
	}
	if err := storeSecret(secretName(path), data); err != nil {
		log.Printf("secrets: %s not in the keymanager: %v", secretName(path), err)
	}
	return nil
}

// removeSecret removes a secret file and keymanager's copy, so a sign-out (or a
// login that did not validate) does not come back from it.
func removeSecret(path string) {
	_ = os.Remove(path)
	removeStoredSecret(secretName(path))
}

// syncSecrets brings each secret file and keymanager's copy of it together: a
// file keymanager lacks (or holds otherwise) is stored, a file only keymanager has
// is written back.
func syncSecrets() {
	for _, path := range secretPaths() {
		name := secretName(path)
		stored, have := fetchSecret(name)
		data, err := os.ReadFile(path)
		switch {
		case err == nil && len(data) > 0:
			if have && bytes.Equal(stored, data) {
				continue
			}
			if err := storeSecret(name, data); err != nil {
				log.Printf("secrets: %s not in the keymanager: %v", name, err)
				continue
			}
			log.Printf("secrets: stored %s in the keymanager", name)
		case errors.Is(err, os.ErrNotExist) && have:
			if err := writeFileAtomic(path, stored); err != nil {
				log.Printf("secrets: could not restore %s: %v", path, err)
				continue
			}
			log.Printf("secrets: restored %s from the keymanager", path)
		}
	}
}
