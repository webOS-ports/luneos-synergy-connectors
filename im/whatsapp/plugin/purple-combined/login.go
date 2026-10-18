package main

/*
#include "constants.h"
*/
import "C"

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"github.com/mdp/qrterminal/v3"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

/*
 * This is the go part of purple's login() function.
 */
func login(account *PurpleAccount, purple_user_dir string, username string, credentials string, proxy_address string) {
	log := PurpleLogger(account, "Handler")
	_, ok := handlers[account]
	if ok {
		purple_error(account, "This connection already exists.", ERROR_FATAL)
		return
	}

	// try to protect against concurrent connections
	// this may lead to problems on multi-user systems since the purple-supplied username not necessarily denotes the actual user JID
	for _, handler := range handlers {
		if handler.username == username {
			purple_error(account, fmt.Sprintf("A connection to this username %s already exists. Please fix your setup.", username), ERROR_FATAL)
			return
		}
	}

	// establish connection to database
	dbLog := PurpleLogger(account, "Database")
	address := purple_get_string(account, C.GOWHATSAPP_DATABASE_ADDRESS_OPTION, C.GOWHATSAPP_DATABASE_ADDRESS_DEFAULT)
	address = strings.Replace(address, "$purple_user_dir", purple_user_dir, -1)
	address = strings.Replace(address, "$username", username, -1)
	address = strings.Replace(address, "_foreign_keys=on", "_pragma=foreign_keys(1)", -1) // backwards compatibility with github.com/mattn/go-sqlite3 URI variant
	dialect := "sqlite"                                                                   // see https://pkg.go.dev/modernc.org/sqlite#hdr-Connecting_to_a_database
	max_open_conns := 1
	if strings.HasPrefix(address, "postgres:") {
		dialect = "postgres"
		max_open_conns = 0
		address = strings.Replace(address, "postgres:", "", -1)
		// } else if strings.HasPrefix(address, "mysql:") {
		// dialect = "mysql"
		// max_open_conns = 0
		// address = strings.Replace(address, "mysql:", "", -1)
		// disabled until https://github.com/tulir/whatsmeow/pull/48 has been merged
	} else {
		// nothing else, see https://github.com/tulir/whatsmeow/blob/b078a9e/store/sqlstore/container.go#L34
		// and https://github.com/tulir/whatsmeow/blob/4ea4925/mdtest/main.go#L44
	}

	dbLog.Infof("%s connecting to %s", dialect, address)
	db, err := sql.Open(dialect, address)
	if max_open_conns > 0 {
		db.SetMaxOpenConns(max_open_conns)
	}
	if err != nil {
		purple_error(account, fmt.Sprintf("Database driver %s is unable to establish connection to %s due to %v.", dialect, address, err), ERROR_FATAL)
		return
	}
	container := sqlstore.NewWithDB(db, dialect, dbLog)
	err = container.Upgrade(context.TODO())
	if err != nil {
		purple_error(account, fmt.Sprintf("Failed to upgrade database: %v", err), ERROR_FATAL)
		return
	}

	// set our name (displayed in "linked devices")
	store.DeviceProps.Os = proto.String(purple_get_device_name(account))
	// whatsmeow's own default here is DeviceProps_UNKNOWN (store/clientpayload.go) -- this is
	// the platformType a peer's client sees for us in call events (meowcaller's
	// ev.RemotePlatform, populated the same way for the peer). Live testing this session:
	// ADB logcat on a real Android phone during a webOS-dialed video call confirmed
	// com.whatsapp NEVER instantiates an H.264/AVC decoder (only AAC/vorbis for
	// ringtone/audio) even though it shows a video-capable call UI (a "video_container"
	// element gets laid out) -- i.e. it decides not to commit to real video decode for this
	// caller specifically, before ever touching MediaCodec. The same webOS device's video
	// works fine in the other direction (Android dials, we answer) and our own outgoing
	// video's bitstream/RTP/relay/signaling have all been separately verified correct this
	// session -- an UNKNOWN platformType from the offering party is a plausible thing for a
	// receiving client to gate reduced-trust capability (like real-time video) on, and
	// nothing else examined this session (bitstream, SSRC, relay allocate, RTCP CNAME,
	// caller-side sequencing vs. the reference implementation, offer/accept stanza content)
	// explains a hard, deterministic, direction-specific difference like this.
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_ANDROID_PHONE.Enum()

	// limit fetching history since we cannot even parse it
	store.DeviceProps.HistorySyncConfig = &waCompanionReg.DeviceProps_HistorySyncConfig{
		FullSyncDaysLimit:   proto.Uint32(1),
		FullSyncSizeMbLimit: proto.Uint32(1),
		StorageQuotaMb:      proto.Uint32(1),
	}

	// find device (and session) information in database
	// expects user-supplied credentials to be in the form "deviceJid|registrationId".
	// also see set_credentials
	var device *store.Device = nil
	registrationId := uint32(0)
	creds := strings.Split(credentials, "|")
	if len(creds) == 2 {
		deviceJid, err := parseJID(creds[0])
		if err != nil {
			purple_error(account, fmt.Sprintf("Supplied device ID %v is not valid: %#v", deviceJid, err), ERROR_FATAL)
			return
		}
		rId, err := strconv.ParseUint(creds[1], 16, 32)
		if err != nil {
			purple_error(account, fmt.Sprintf("Unable to parse registration ID: %#v", err), ERROR_FATAL)
			return
		}
		registrationId = uint32(rId)
		// now query database for device information
		device, err = container.GetDevice(context.TODO(), deviceJid)
		if err != nil {
			// this is in case of database errors, presumably
			purple_error(account, fmt.Sprintf("Unable to read device from database: %#v", err), ERROR_FATAL)
			return
		}
	}

	if device == nil {
		// device == nil happens in case the database contained no appropriate device
		device = container.NewDevice()
		// device.RegistrationID has been generated. sync it and continue (see next if below)
		registrationId = device.RegistrationID
	} else if device.ID.ToNonAD().String() != username {
		purple_error(account, fmt.Sprintf("Your username '%s' does not match the main device's ID '%s'. Please adjust your username.", username, device.ID.ToNonAD().String()), ERROR_FATAL)
	}

	// check user-supplied registration id against the one stored in the device
	// this is necessary for multi-user set-ups like spectrum or bitlbee
	// where we cannot universally trust all local users.
	// we must employ a mechanism that checks against some secret
	// so it is not sufficient to know a person's device ID to hijack their account
	// TODO: research if this is actually true. if not, then simplify the credential storage
	// there is nothing special about the RegistrationID. any of the fields could be used.
	if device.RegistrationID != registrationId {
		purple_error(account, "Incorrect credentials.", ERROR_FATAL)
		return
	}

	// try to protect against concurrent connections
	// look through all currently active connections
	// abort if there already is a connection with this JID
	for _, handler := range handlers {
		if handler.client.Store != nil && handler.client.Store.ID != nil && device.ID != nil && handler.client.Store.ID.ToNonAD() == device.ID.ToNonAD() {
			purple_error(account, fmt.Sprintf("A connection to this number %s already exists. Please fix your setup.", device.ID.String()), ERROR_FATAL)
			return
		}
	}

	handler := Handler{
		account:          account,
		username:         username,
		container:        container,
		log:              log,
		client:           whatsmeow.NewClient(device, PurpleLogger(account, "Client")),
		deferredReceipts: make(map[types.JID]map[types.JID][]types.MessageID),
		pictureRequests:  make(chan ProfilePictureRequest, 1000), // I hope that no user has more than 1000 contacts
	}
	handlers[account] = &handler
	handler.LoadCachedMessages(filepath.Join(purple_user_dir, username+".json"))
	handler.LoadNewsletterSeen(filepath.Join(purple_user_dir, username+".nlseen.json"))
	handler.client.AddEventHandler(handler.eventHandler)

	// webOS: attach the WhatsApp-calling engine (meowcaller) to THIS shared session so the
	// stock Phone app can place/receive calls without a separate wacallm companion. Must run
	// before Connect() so meowcaller's low-level <call> interception is in place first.
	handler.startCalling()

	if proxy_address != "" {
		handler.client.SetProxyAddress(proxy_address)
	}
	err = handler.client.Connect()
	if err != nil {
		purple_error(handler.account, fmt.Sprintf("%#v", err), ERROR_TRANSIENT)
	}
}

/*
 * Generates an pairing 8-character pairing code.
 */
func (handler *Handler) generate_pairing_code() (string, error) {
	own_jid, err := parseJID(handler.username)
	if err != nil {
		return "", fmt.Errorf("„%s“ is not a valid WhatsApp JID", handler.username)
	}
	phone := own_jid.ToNonAD().User
	showPushNotification := true
	// cannot use store.DeviceProps.Os here, since "only common browsers/OSes are allowed",
	// see https://pkg.go.dev/go.mau.fi/whatsmeow#Client.PairPhone
	// Firefox on Linux chosen arbitrarily
	clientDisplayName := "Firefox (Linux)"
	clientType := whatsmeow.PairClientFirefox
	pairing_code, err := handler.client.PairPhone(context.TODO(), phone, showPushNotification, clientType, clientDisplayName)
	return pairing_code, err
}

/*
 * After calling client.Connect() with a pristine device ID, WhatsApp servers
 * send a list of codes which can be turned into QR codes for scanning with the offical app.
 */
func (handler *Handler) handle_qrcode(qrcodes []string) {
	pairing_code, err := handler.generate_pairing_code()
	if err != nil {
		purple_error(handler.account, fmt.Sprintf("%#v", err), ERROR_FATAL)
	}
	qrcode_data := qrcodes[0] // use only first code for now
	// TODO: emit events to destroy and update the code in the ui
	var stringBuilder strings.Builder
	qrterminal.GenerateHalfBlock(qrcode_data, qrterminal.L, &stringBuilder)
	size := purple_get_int(handler.account, C.GOWHATSAPP_QRCODE_SIZE_OPTION, 256)
	var png []byte
	if size > 0 {
		png, err = qrcode.Encode(qrcode_data, qrcode.Medium, size)
		if err != nil {
			purple_error(handler.account, fmt.Sprintf("%#v", err), ERROR_FATAL)
		}
	}
	purple_display_qrcode(handler.account, pairing_code, qrcode_data, stringBuilder.String(), png)
}

/*
 * Store the credentials (deviceJID and a "password").
 * The credentials are munged into a single string for bitlbee compatibility.
 */
func set_credentials(account *PurpleAccount, deviceJid types.JID, registrationId uint32) string {
	rId := fmt.Sprintf("%x", registrationId)
	dJ := deviceJid.String()
	creds := fmt.Sprintf("%s|%s", dJ, rId)
	purple_set_credentials(account, creds)
	return creds
}

func (handler *Handler) prune_devices(deviceJid types.JID) {
	if handler.container == nil {
		purple_error(handler.account, "prune_devices called without a database connection", ERROR_FATAL)
		return
	}
	ctx := context.TODO()
	devices, err := handler.container.GetAllDevices(ctx)
	if err == nil {
		for _, device := range devices {
			if device.ID == nil {
				handler.log.Infof("Deleting bogous device %s from database...", device.ID.String())
				device.Delete(ctx) // ignores errors
			} else {
				obsolete := device.ID.ToNonAD() == deviceJid.ToNonAD() && *device.ID != deviceJid
				if obsolete {
					handler.log.Infof("Deleting obsolete device %s from database...", device.ID.String())
					device.Delete(ctx) // ignores errors
				}
			}
		}
	}
}

/*
 * whatsapp_account_removed is invoked from the libpurple "account-removed" signal (fired by
 * purple_accounts_delete) when the user DELETES a WhatsApp account on webOS. Its job is to unlink
 * this device server-side and remove ONLY this account's row from the SHARED whatsmeow.db.
 *
 * The whatsmeow store (default file:$purple_user_dir/whatsmeow.db) is shared by every WhatsApp
 * account in this transport — the default DB address has no $username in it. So we must NEVER delete
 * the whole file (that would orphan every other WhatsApp account and log them all out). Instead we
 * key strictly on THIS account's device JID and delete just that one device's rows.
 *
 * Per-account isolation:
 *   - Preferred path: if a live, connected client for this account still exists, client.Logout()
 *     sends a "remove-companion-device" IQ (unlinks server-side, clearing the "ghost linked device")
 *     and then deletes only its own device from the store.
 *   - Fallback (the usual case — libpurple disables + disconnects, and thus tears down the handler,
 *     BEFORE emitting account-removed): open the shared store, look up this account's stored device
 *     JID (from the "credentials" setting = "deviceJID|registrationId") and delete only that device's
 *     rows via whatsmeow's store (Container.DeleteDevice, per-JID). A fresh pairing QR then works on
 *     re-add. NOTE: while disconnected we cannot unlink server-side, so a stale linked device may
 *     linger on the phone until the user removes it there — hooking a connected teardown would
 *     require an earlier signal, but "account-disabled" also fires for a plain disable, which must
 *     NOT wipe the store.
 */
func whatsapp_account_removed(account *PurpleAccount, purple_user_dir string, username string, credentials string) {
	log := PurpleLogger(account, "AccountRemoved")

	// Preferred: a live, connected client can Logout() (unlink server-side + delete its own row).
	if handler, ok := handlers[account]; ok {
		if handler.client != nil && handler.client.Store != nil && handler.client.Store.ID != nil {
			deviceJid := *handler.client.Store.ID
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if err := handler.client.Logout(ctx); err != nil {
				// e.g. not actually connected: fall back to deleting just this device's row via the
				// container the handler already holds (still strictly per-JID).
				log.Warnf("Logout failed (%v); deleting device %s from shared store", err, deviceJid.String())
				whatsapp_delete_device(handler.container, deviceJid)
			} else {
				log.Infof("Logged out and removed device %s from shared whatsmeow store", deviceJid.String())
			}
		}
		return
	}

	// Usual case: no live handler. Look up THIS account's stored device JID and delete only it.
	creds := strings.Split(credentials, "|")
	if len(creds) < 1 || creds[0] == "" {
		log.Infof("No stored WhatsApp credentials for removed account; nothing to clean up.")
		return
	}
	deviceJid, err := parseJID(creds[0])
	if err != nil {
		log.Warnf("Stored device JID %q is not valid; skipping store cleanup: %v", creds[0], err)
		return
	}
	container, db, err := whatsapp_open_container(account, purple_user_dir, username)
	if err != nil {
		log.Warnf("Cannot open whatsmeow store to remove device %s: %v", deviceJid.String(), err)
		return
	}
	defer db.Close()
	whatsapp_delete_device(container, deviceJid)
	log.Infof("Removed device %s from shared whatsmeow store (server-side unlink not possible while disconnected).", deviceJid.String())
}

/*
 * whatsapp_delete_device removes exactly one device's rows (keyed by JID) from the shared store.
 * This is the per-JID delete that keeps other WhatsApp accounts in the same whatsmeow.db intact.
 */
func whatsapp_delete_device(container *sqlstore.Container, deviceJid types.JID) {
	if container == nil {
		return
	}
	ctx := context.TODO()
	device, err := container.GetDevice(ctx, deviceJid)
	if err != nil || device == nil {
		// no such device (already gone / never paired) — nothing to delete
		return
	}
	_ = device.Delete(ctx) // Device.Delete -> Container.DeleteDevice(device): removes only this JID
}

/*
 * whatsapp_open_container opens the SHARED whatsmeow store using the exact same address resolution
 * as login() (the "database-address" account option, $purple_user_dir/$username substitution and the
 * legacy _foreign_keys=on rewrite). Caller owns the returned *sql.DB and must Close() it.
 */
func whatsapp_open_container(account *PurpleAccount, purple_user_dir string, username string) (*sqlstore.Container, *sql.DB, error) {
	dbLog := PurpleLogger(account, "Database")
	address := purple_get_string(account, C.GOWHATSAPP_DATABASE_ADDRESS_OPTION, C.GOWHATSAPP_DATABASE_ADDRESS_DEFAULT)
	address = strings.Replace(address, "$purple_user_dir", purple_user_dir, -1)
	address = strings.Replace(address, "$username", username, -1)
	address = strings.Replace(address, "_foreign_keys=on", "_pragma=foreign_keys(1)", -1)
	dialect := "sqlite"
	maxOpenConns := 1
	if strings.HasPrefix(address, "postgres:") {
		dialect = "postgres"
		maxOpenConns = 0
		address = strings.Replace(address, "postgres:", "", -1)
	}
	db, err := sql.Open(dialect, address)
	if err != nil {
		return nil, nil, err
	}
	if maxOpenConns > 0 {
		db.SetMaxOpenConns(maxOpenConns)
	}
	container := sqlstore.NewWithDB(db, dialect, dbLog)
	if err := container.Upgrade(context.TODO()); err != nil {
		db.Close()
		return nil, nil, err
	}
	return container, db, nil
}

/*
 * This is the go part of purple's close() function.
 */
func (handler *Handler) close(account *PurpleAccount, purple_user_dir string, username string) {
	// tell the background downloader to terminate
	select {
	case handler.pictureRequests <- ProfilePictureRequest{}:
		// termination request sent
		// nothing to do here
	default:
		// termination request not sent
		// ignore silently and continue
	}
	handler.client.Disconnect()
	handler.SaveCachedMessages(filepath.Join(purple_user_dir, username+".json"))
	handler.SaveNewsletterSeen(filepath.Join(purple_user_dir, username+".nlseen.json"))
	delete(handlers, account)
}
