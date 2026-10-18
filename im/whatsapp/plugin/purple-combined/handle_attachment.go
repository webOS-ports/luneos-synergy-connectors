package main

/*
#include "bridge.h"
*/
import "C"

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"image/png"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/image/webp"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waConsumerApplication"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waMediaTransport"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// fbTrace appends a line to a dedicated file and fsyncs it, so the marker SURVIVES a hard native crash
// (unlike purple_debug -> block-buffered stdout, whose buffer is lost on SIGSEGV). Temporary: used to
// pin down where incoming FB media downloads crash the transport.
func fbTrace(msg string) {
	f, err := os.OpenFile("/media/internal/fbtrace.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	f.WriteString(msg + "\n")
	f.Sync()
	f.Close()
}

func extension_from_mimetype(mimeType *string) string {
	extension := ".data"
	if mimeType != nil {
		// use the most poplular default for some common mimetypes
		if *mimeType == "image/jpeg" {
			return ".jpg"
		}
		if *mimeType == "image/png" {
			return ".png"
		}
		if *mimeType == "video/mp4" {
			return ".mp4"
		}
		// anything else is looked up
		extensions, _ := mime.ExtensionsByType(*mimeType)
		if extensions != nil {
			extension = extensions[0]
		}
	}
	return extension
}

// based on https://github.com/FKLC/WhatsAppToDiscord/blob/master/WA2DC.go
func (handler *Handler) handle_attachment(message *waE2E.Message, id string, source types.MessageSource, timestamp time.Time) {
	var (
		caption                                    = ""
		length       uint64                        = 0
		hash                                       = ""
		filename                                   = ""
		extension                                  = ""
		data_type    C.int                         = C.gowhatsapp_attachment_type_none
		downloadable whatsmeow.DownloadableMessage = nil
		mimetype                                   = ""
	)
	{
		im := message.GetImageMessage()
		if im != nil {
			downloadable = im
			hash = hex.EncodeToString(im.GetFileSHA256())
			extension = extension_from_mimetype(im.Mimetype)
			data_type = C.gowhatsapp_attachment_type_image
			mimetype = im.GetMimetype()
			length = im.GetFileLength()
			caption = im.GetCaption()
		}
	}
	{
		vm := message.GetVideoMessage()
		if vm != nil {
			downloadable = vm
			hash = hex.EncodeToString(vm.GetFileSHA256())
			extension = extension_from_mimetype(vm.Mimetype)
			data_type = C.gowhatsapp_attachment_type_video
			mimetype = vm.GetMimetype()
			length = vm.GetFileLength()
			caption = vm.GetCaption()
		}
	}
	{
		ptv := message.GetPtvMessage()
		if ptv != nil {
			downloadable = ptv
			hash = hex.EncodeToString(ptv.GetFileSHA256())
			extension = extension_from_mimetype(ptv.Mimetype)
			data_type = C.gowhatsapp_attachment_type_video
			mimetype = ptv.GetMimetype()
			length = ptv.GetFileLength()
			caption = ptv.GetCaption()
		}
	}
	{
		am := message.GetAudioMessage()
		if am != nil {
			downloadable = am
			hash = hex.EncodeToString(am.GetFileSHA256())
			extension = extension_from_mimetype(am.Mimetype)
			data_type = C.gowhatsapp_attachment_type_audio
			mimetype = am.GetMimetype()
			length = am.GetFileLength()
		}
	}
	{
		sm := message.GetStickerMessage()
		if sm != nil {
			downloadable = sm
			hash = hex.EncodeToString(sm.GetFileSHA256())
			// webOS: a sticker is WhatsApp's own .webp - this device's WebKit predates WebP (2010) and
			// has no decoder for it, and the fallback pixbuf-mimetype gate (pixbuf.c, built without GDK
			// pixbuf loader detection) only allow-lists jpeg/png, so a sticker attachment posted no
			// message body at all ("stickers don't display"). download_attachment transcodes the
			// downloaded bytes to PNG (golang.org/x/image/webp decode -> image/png encode) before
			// writing the file, so always claim PNG here regardless of the source's real mimetype.
			extension = ".png"
			data_type = C.gowhatsapp_attachment_type_sticker
			mimetype = "image/png"
			length = sm.GetFileLength()
		}
	}
	{
		dm := message.GetDocumentMessage()
		if dm != nil {
			downloadable = dm
			hash = hex.EncodeToString(dm.GetFileSHA256())
			filename = dm.GetFileName() // TODO: sanitize filename
			extension = filepath.Ext(filename)
			if extension != "" {
				// remove extension from filename for consistency when using file-naming template
				filename = strings.TrimSuffix(filename, extension)
			} else {
				extension = extension_from_mimetype(dm.Mimetype)
			}
			data_type = C.gowhatsapp_attachment_type_document
			mimetype = dm.GetMimetype()
			length = dm.GetFileLength()
			caption = dm.GetCaption()
			// webOS: name the downloaded document by its REAL filename (not the content hash) so the
			// Messaging app's attachment chip shows e.g. "Q3-Report.pdf" instead of a hash / generic
			// label. The path template uses $hash, so put the sanitized real name there; keep the
			// content hash as a fallback when the document has no filename.
			if safe := sanitize_attachment_name(filename); safe != "" {
				hash = safe
			}
		}
	}
	if data_type != C.gowhatsapp_attachment_type_none {
		chat := source.Chat.ToNonAD().String()
		sender := source.Sender.ToNonAD().String()
		purple_handle_attachment(handler.account, chat, source.IsGroup, sender, caption, id, timestamp, data_type, filename, extension, mimetype, hash, length, downloadable)
	}
}

// sanitize_attachment_name makes a document's real filename safe to use as a single path component AND
// to survive the Messaging app's media-URL regex (which stops at whitespace): directory separators,
// control chars, spaces and characters that break a URL/path all map to "_".
func sanitize_attachment_name(name string) string {
	name = strings.TrimSpace(name)
	return strings.Map(func(r rune) rune {
		if r <= 0x20 || strings.ContainsRune("/\\?#\"'<>|:*&", r) {
			return '_'
		}
		return r
	}, name)
}

func (handler *Handler) download_attachment(local_file_path string, message whatsmeow.DownloadableMessage) (retErr error) {
	// webOS: FB E2EE media receive was CRASHING the whole transport (~15s after arrival, during the
	// download, with no error and no file). This function is invoked across the cgo boundary
	// (C download_to_templated_destination -> gowhatsapp_go_download_attachment), where an UNRECOVERED Go
	// panic aborts the entire process (no usable trace). Recover here so a bad FB download degrades to a
	// failed attachment instead of taking every account offline -- and the recovered value finally tells
	// us WHERE it dies (e.g. inside whatsmeow DownloadFB / refreshMediaConn for the FB e2ee client).
	defer func() {
		if r := recover(); r != nil {
			fbTrace(fmt.Sprintf("download_attachment PANIC: %v", r))
			purple_debug(4, fmt.Sprintf("gometa: download_attachment PANIC recovered: %v", r))
			retErr = fmt.Errorf("download panic: %v", r)
		}
	}()
	_, isFB := message.(*fbDownloadable)
	if isFB {
		fbTrace(fmt.Sprintf("download_attachment ENTER path=%s", local_file_path))
	}
	os.MkdirAll(filepath.Dir(local_file_path), 0o755)
	// Download to memory then write the file ourselves. whatsmeow's DownloadToFile streams to an
	// *os.File and unconditionally calls fallocate(2), which webOS filesystems (tmpfs/vfat) reject
	// with EOPNOTSUPP; that gets misclassified as a network error, retried across hosts, and the
	// reused-but-not-truncated file corrupts the payload into an "invalid media hmac" failure.
	// The in-memory Download() path does io.ReadAll (no fallocate, no *os.File) and verifies the HMAC.
	var data []byte
	var err error
	// This runs SYNCHRONOUSLY on the whatsmeow read-loop goroutine (purple_handle_attachment ->
	// download_to_templated_destination -> gowhatsapp_go_download_attachment is a blocking cgo call).
	// context.TODO() has no deadline, so a failing/stalled download (esp. FB E2EE, whose retry-across-
	// hosts can spin) blocked the read loop for minutes: no pings went out, the transport was declared
	// dead and got killed + respawned - wedging ALL accounts. Bound every download so a bad media fetch
	// surfaces as a per-message error instead of taking the whole transport down.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if fb, ok := message.(*fbDownloadable); ok {
		// Facebook E2EE (armadillo) media: download via the FB e2ee whatsmeow client with the explicit
		// media type (a different client + endpoint than WhatsApp's handler.client).
		g, gok := gometaHandlers[handler.account]
		if !gok || g.e2ee == nil {
			return fmt.Errorf("facebook e2ee not connected")
		}
		fbTrace(fmt.Sprintf("DownloadFB START type=%d directPathLen=%d path=%s", fb.mediaType, len(fb.integral.GetDirectPath()), local_file_path))
		purple_debug(2, fmt.Sprintf("gometa: DownloadFB start (type=%d directPathLen=%d)", fb.mediaType, len(fb.integral.GetDirectPath())))
		data, err = g.e2ee.DownloadFB(ctx, fb.integral, fb.mediaType)
		fbTrace(fmt.Sprintf("DownloadFB RETURNED %d bytes err=%v", len(data), err))
		purple_debug(2, fmt.Sprintf("gometa: DownloadFB returned %d bytes err=%v", len(data), err))
		if err != nil {
			// Log (do NOT purple_error - that disconnects the account); the caller renders the failure
			// as a per-message error. directPath/key lengths help distinguish a bad-integral extraction
			// (wrong nesting) from a genuine network/HMAC failure.
			purple_debug(4, fmt.Sprintf("gometa: DownloadFB failed (type=%d directPathLen=%d keyLen=%d fileSHA=%d encSHA=%d): %v",
				fb.mediaType, len(fb.integral.GetDirectPath()), len(fb.integral.GetMediaKey()),
				len(fb.integral.GetFileSHA256()), len(fb.integral.GetFileEncSHA256()), err))
		}
	} else {
		data, err = handler.client.Download(ctx, message)
	}
	if err != nil {
		return err
	}
	// webOS stickers: this device's WebKit has no WebP decoder, so transcode a sticker's native .webp
	// to PNG before writing (see the extension=".png"/mimetype="image/png" override in the caller's
	// StickerMessage branch, which already chose a .png local_file_path to match). x/image/webp only
	// decodes the first frame of an animated sticker - animated stickers show as a static image.
	if _, isSticker := message.(*waE2E.StickerMessage); isSticker {
		img, decErr := webp.Decode(bytes.NewReader(data))
		if decErr != nil {
			return fmt.Errorf("sticker webp decode failed: %v", decErr)
		}
		var pngBuf bytes.Buffer
		if encErr := png.Encode(&pngBuf, img); encErr != nil {
			return fmt.Errorf("sticker png encode failed: %v", encErr)
		}
		data = pngBuf.Bytes()
	}
	if err := os.WriteFile(local_file_path, data, 0o644); err != nil {
		return err
	}
	if _, ok := message.(*fbDownloadable); ok {
		fbTrace(fmt.Sprintf("WROTE %d bytes -> %s", len(data), local_file_path))
	}
	purple_debug(2, fmt.Sprintf("gometa: wrote attachment %d bytes -> %s", len(data), local_file_path))
	// For videos, also drop the sender's embedded JPEG thumbnail next to the file as "<base>.jpg".
	// The Messaging app uses it as a <video poster> — a first-view preview that loads as a plain
	// image (independent of the clip's own data), which lets the player stay preload="none". The old
	// webOS WebKit can't paint a poster frame from an unplayed <video> otherwise, so without this the
	// preview box is black until the clip has been played once. Best-effort: a missing poster is fine.
	if vm, ok := message.(*waE2E.VideoMessage); ok {
		if thumb := vm.GetJPEGThumbnail(); len(thumb) > 0 {
			poster := strings.TrimSuffix(local_file_path, filepath.Ext(local_file_path)) + ".jpg"
			os.WriteFile(poster, thumb, 0o644)
		}
	}
	return nil
}

// fbDownloadable adapts a Facebook E2EE (armadillo) media transport to whatsmeow.DownloadableMessage so
// an incoming FB image/video/audio/document flows through the SAME attachment display path as WhatsApp
// media (purple_handle_attachment -> lazy download -> inline render). download_attachment recognises it
// and routes the fetch to the FB e2ee client's DownloadFB (a different client/endpoint than WhatsApp).
type fbDownloadable struct {
	integral  *waMediaTransport.WAMediaTransport_Integral
	mediaType whatsmeow.MediaType
}

func (f *fbDownloadable) GetDirectPath() string   { return f.integral.GetDirectPath() }
func (f *fbDownloadable) GetMediaKey() []byte      { return f.integral.GetMediaKey() }
func (f *fbDownloadable) GetFileSHA256() []byte    { return f.integral.GetFileSHA256() }
func (f *fbDownloadable) GetFileEncSHA256() []byte { return f.integral.GetFileEncSHA256() }

// handleE2EEMedia downloads + displays an incoming Facebook E2EE media message (image/video/audio/
// document) carried inside a ConsumerApplication. Returns true if the content WAS a media message (so
// the caller stops -- otherwise media was silently dropped, only text/reactions were handled). Mirrors
// the WhatsApp handle_attachment path.
func (h *gometaHandler) handleE2EEMedia(content *waConsumerApplication.ConsumerApplication_Content, evt *events.FBMessage, chatFbid, senderFbid int64, name string) bool {
	var (
		wa        *waMediaTransport.WAMediaTransport
		mediaType whatsmeow.MediaType
		dataType  C.int = C.gowhatsapp_attachment_type_none
		filename  string
		caption   string
	)
	if vm := content.GetVideoMessage(); vm != nil {
		if t, err := vm.Decode(); err == nil {
			wa = t.GetIntegral().GetTransport()
			caption = t.GetAncillary().GetCaption().GetText()
			mediaType, dataType = whatsmeow.MediaVideo, C.gowhatsapp_attachment_type_video
		} else {
			purple_debug(4, fmt.Sprintf("gometa: VideoMessage.Decode failed: %v", err))
		}
	} else if im := content.GetImageMessage(); im != nil {
		if t, err := im.Decode(); err == nil {
			wa = t.GetIntegral().GetTransport()
			mediaType, dataType = whatsmeow.MediaImage, C.gowhatsapp_attachment_type_image
		}
	} else if am := content.GetAudioMessage(); am != nil {
		if t, err := am.Decode(); err == nil {
			wa = t.GetIntegral().GetTransport()
			mediaType, dataType = whatsmeow.MediaAudio, C.gowhatsapp_attachment_type_audio
		}
	} else if dm := content.GetDocumentMessage(); dm != nil {
		if t, err := dm.Decode(); err == nil {
			wa = t.GetIntegral().GetTransport()
			filename = dm.GetFileName()
			mediaType, dataType = whatsmeow.MediaDocument, C.gowhatsapp_attachment_type_document
		}
	}
	if wa == nil || dataType == C.gowhatsapp_attachment_type_none {
		return false
	}
	integral := wa.GetIntegral()
	if integral == nil {
		return false
	}
	purple_debug(2, fmt.Sprintf("gometa: E2EE media type=%d mime=%q len=%d directPathLen=%d keyLen=%d encSHA=%d -> queueing download",
		mediaType, wa.GetAncillary().GetMimetype(), wa.GetAncillary().GetFileLength(),
		len(integral.GetDirectPath()), len(integral.GetMediaKey()), len(integral.GetFileEncSHA256())))
	mimetype := wa.GetAncillary().GetMimetype()
	length := wa.GetAncillary().GetFileLength()
	hash := hex.EncodeToString(integral.GetFileSHA256())
	extension := ""
	if filename != "" { // document: keep its real name (shown on the chip), split off the extension
		extension = filepath.Ext(filename)
		if extension != "" {
			filename = strings.TrimSuffix(filename, extension)
		}
		if safe := sanitize_attachment_name(filename); safe != "" {
			hash = safe
		}
	}
	if extension == "" {
		extension = extension_from_mimetype(&mimetype)
	}
	// Record who sent this (keyed by serviceMessageId) so a later reaction/reply over E2EE resolves.
	id := string(evt.Info.ID)
	if id != "" {
		h.mu.Lock()
		h.e2eeMsgMeta[id] = e2eeMsgInfo{fromMe: evt.Info.IsFromMe, sender: strconv.FormatInt(senderFbid, 10), text: caption}
		h.mu.Unlock()
	}
	h.addContact(chatFbid, name)
	// FB media CANNOT go through purple_handle_attachment: that path marshals the work onto the glib main
	// loop via purple_timeout_add, which never fires from the FB e2ee event context (proved by the C-side
	// fsync trace -- gowhatsapp_handle_attachment was never reached; the goroutine variant scheduled a
	// callback that never ran, the synchronous variant blocked the read loop forever). FB TEXT works
	// precisely because it uses the DIRECT notifyMessage/serv_got_im path, not the timeout bridge. So
	// download the media here and display it exactly like FB text: a message whose body is the file://
	// URL, which the Messaging app renders inline (the same media-URL bubble WhatsApp uses). Bounded
	// context so a stalled fetch can't wedge the read loop; notifyMessage itself is cheap.
	chatStr := strconv.FormatInt(chatFbid, 10)
	senderStr := strconv.FormatInt(senderFbid, 10)
	dir := "/media/internal/.im-attachments/facebook"
	os.MkdirAll(dir, 0o755)
	localPath := dir + "/" + hash + extension
	fbTrace(fmt.Sprintf("handleE2EEMedia: DownloadFB start mime=%s len=%d -> %s", mimetype, length, localPath))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	data, derr := h.e2ee.DownloadFB(ctx, integral, mediaType)
	fbTrace(fmt.Sprintf("handleE2EEMedia: DownloadFB returned %d bytes err=%v", len(data), derr))
	if derr != nil {
		purple_debug(4, fmt.Sprintf("gometa: DownloadFB failed (mime=%s): %v", mimetype, derr))
		return true
	}
	if werr := os.WriteFile(localPath, data, 0o644); werr != nil {
		purple_debug(4, fmt.Sprintf("gometa: write FB media failed: %v", werr))
		return true
	}
	fbTrace(fmt.Sprintf("handleE2EEMedia: WROTE %d bytes -> %s", len(data), localPath))
	body := "file://" + localPath
	if caption != "" {
		body = body + "\n" + caption
	}
	h.notifyMessage(chatStr, senderStr, name, body, id, evt.Info.Timestamp.Unix(), false, evt.Info.IsFromMe, "", "", "")
	return true
}
