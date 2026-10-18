package stun

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"strconv"
	"strings"

	"github.com/rs/zerolog"
)

// STUN/WARP relay framing: an RFC 5389 TLV encoder with WhatsApp's
// MESSAGE-INTEGRITY (HMAC-SHA1) and FINGERPRINT (CRC-32), the allocate-request
// builders, the consent ping, and the response parsers.

const (
	stunMagic          = 0x2112a442
	stunFingerprintXor = 0x5354554e
	stunXorPort        = 0x2112

	attrUsername              = 0x0006
	attrMessageIntegrity      = 0x0008
	attrErrorCode             = 0x0009
	attrPriority              = 0x0024
	attrUseCandidate          = 0x0025
	attrRelayToken            = 0x4000
	attrStreamDescriptors     = 0x4024
	attrWasmRelayEndpoint     = 0x0016
	attrIceControlling        = 0x802a
	attrFingerprint           = 0x8028
	attrSenderSubscriptionsV2 = 0x4025
)

// STUN message types.
const (
	MsgBindingRequest  uint16 = 0x0001
	MsgAllocateRequest uint16 = 0x0003
	MsgBindingSuccess  uint16 = 0x0101
	MsgAllocateSuccess uint16 = 0x0103
	MsgAllocateError   uint16 = 0x0113
	MsgWhatsappPing    uint16 = 0x0801
	MsgWhatsappPong    uint16 = 0x0802
)

// stunXorAddr is the magic-cookie prefix XORed into XOR-MAPPED addresses.
var stunXorAddr = [4]byte{0x21, 0x12, 0xa4, 0x42}

// wasmStreamDescriptorsTemplate is the WASM/Web StreamDescriptors blob (attr 0x4024).
var wasmStreamDescriptorsTemplate = []byte{
	0x0a, 0x06, 0x18, 0xca, 0xbc, 0x85, 0xae, 0x04, 0x0a, 0x08, 0x10, 0x01, 0x18, 0xa5, 0xac, 0xaf,
	0xae, 0x0a, 0x0a, 0x08, 0x10, 0x02, 0x18, 0xd6, 0xa4, 0xe6, 0xf9, 0x0f, 0x0a, 0x08, 0x08, 0x01,
	0x18, 0xf7, 0xdd, 0x9e, 0xb6, 0x0a, 0x0a, 0x0a, 0x08, 0x01, 0x10, 0x01, 0x18, 0xab, 0xcc, 0xb1,
	0xf3, 0x0d, 0x0a, 0x0a, 0x08, 0x01, 0x10, 0x02, 0x18, 0xda, 0xda, 0xef, 0x8a, 0x05, 0x0a, 0x08,
	0x08, 0x02, 0x18, 0xc5, 0xe9, 0xec, 0x8e, 0x0b, 0x0a, 0x0a, 0x08, 0x02, 0x10, 0x01, 0x18, 0xfd,
	0xc2, 0xb1, 0xb6, 0x0f, 0x0a, 0x0a, 0x08, 0x02, 0x10, 0x02, 0x18, 0xb0, 0x97, 0xf7, 0xb2, 0x09,
}

func pad4(n int) int {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L44-L46
	return (4 - (n % 4)) % 4
}

// stunAttr encodes one STUN attribute (type, length, value, 4-byte alignment pad).
func stunAttr(attrType uint16, value []byte) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L49-L57
	pad := pad4(len(value))
	buf := make([]byte, 0, 4+len(value)+pad)
	buf = binary.BigEndian.AppendUint16(buf, attrType)
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(value)))
	buf = append(buf, value...)
	return append(buf, make([]byte, pad)...)
}

// stunFingerprint is the STUN FINGERPRINT CRC-32 (reflected IEEE poly 0xedb88320),
// which is exactly stdlib hash/crc32.ChecksumIEEE.
func stunFingerprint(buf []byte) uint32 {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L60-L69
	return crc32.ChecksumIEEE(buf)
}

func stunPseudoHeader(msgType, msgLen uint16, transactionID [12]byte) [20]byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L71-L78
	var h [20]byte
	binary.BigEndian.PutUint16(h[0:2], msgType)
	binary.BigEndian.PutUint16(h[2:4], msgLen)
	binary.BigEndian.PutUint32(h[4:8], stunMagic)
	copy(h[8:20], transactionID[:])
	return h
}

// EncodeStunRequest encodes a STUN request: header + attrs, then optional
// MESSAGE-INTEGRITY (nil integrityKey skips it) and optional FINGERPRINT.
func EncodeStunRequest(msgType uint16, transactionID [12]byte, attrs []byte, integrityKey []byte, includeFingerprint bool, log ...zerolog.Logger) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L82-L118
	lg := pickLog(log)
	body := append([]byte(nil), attrs...)

	if integrityKey != nil {
		msgLen := uint16(len(body) + 24) // attrs + MI attr (4 + 20)
		header := stunPseudoHeader(msgType, msgLen, transactionID)
		mac := hmac.New(sha1.New, integrityKey)
		mac.Write(header[:])
		mac.Write(body)
		body = append(body, stunAttr(attrMessageIntegrity, mac.Sum(nil))...)
	}

	if includeFingerprint {
		msgLen := uint16(len(body) + 8) // attrs + FINGERPRINT attr (4 + 4)
		header := stunPseudoHeader(msgType, msgLen, transactionID)
		crcInput := make([]byte, 0, 20+len(body))
		crcInput = append(crcInput, header[:]...)
		crcInput = append(crcInput, body...)
		fp := stunFingerprint(crcInput) ^ stunFingerprintXor
		var fpb [4]byte
		binary.BigEndian.PutUint32(fpb[:], fp)
		body = append(body, stunAttr(attrFingerprint, fpb[:])...)
	}

	out := make([]byte, 0, 20+len(body))
	out = binary.BigEndian.AppendUint16(out, msgType)
	out = binary.BigEndian.AppendUint16(out, uint16(len(body)))
	out = binary.BigEndian.AppendUint32(out, stunMagic)
	out = append(out, transactionID[:]...)
	out = append(out, body...)
	lg.Trace().
		Uint16("msg_type", msgType).
		Int("attr_bytes", len(attrs)).
		Bool("message_integrity", integrityKey != nil).
		Bool("fingerprint", includeFingerprint).
		Int("packet_bytes", len(out)).
		Msg("encoded stun request")
	return out
}

// CreateNativeSenderSubscription is a native WA sender sub: 1-byte count + BE SSRC.
func CreateNativeSenderSubscription(ssrc uint32) [5]byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L121-L126
	var buf [5]byte
	buf[0] = 1
	binary.BigEndian.PutUint32(buf[1:5], ssrc)
	return buf
}

// EncodeXorRelayEndpoint XOR-encodes an IPv4:port into 6 bytes; ok=false if ipv4
// is not exactly four dotted octets.
func EncodeXorRelayEndpoint(ipv4 string, port uint16, log ...zerolog.Logger) ([6]byte, bool) {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L129-L144
	lg := pickLog(log)
	var octets []byte
	for part := range strings.SplitSeq(ipv4, ".") {
		n, err := strconv.ParseUint(part, 10, 8)
		if err != nil {
			continue
		}
		octets = append(octets, byte(n))
	}
	if len(octets) != 4 {
		lg.Debug().Int("octet_count", len(octets)).Msg("xor relay endpoint: malformed ipv4")
		return [6]byte{}, false
	}
	var buf [6]byte
	binary.BigEndian.PutUint16(buf[0:2], port^stunXorPort)
	for i := range 4 {
		buf[2+i] = octets[i] ^ stunXorAddr[i]
	}
	return buf, true
}

// createWasmRelayEndpointAttr is the WASM attr 0x0016 value: 00 01 + 6-byte endpoint.
func createWasmRelayEndpointAttr(endpointXor [6]byte) [8]byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L147-L152
	var buf [8]byte
	binary.BigEndian.PutUint16(buf[0:2], 1)
	copy(buf[2:8], endpointXor[:])
	return buf
}

// BuildWasmStunAllocateRequest builds the WASM/Web DataChannel Allocate: 0x4000
// token + 0x4024 stream desc + 0x0016 endpoint + MI, no FP.
func BuildWasmStunAllocateRequest(transactionID [12]byte, relayToken []byte, endpointXor [6]byte, integrityKey []byte, log ...zerolog.Logger) []byte {
	return buildWasmStunAllocateRequest(transactionID, relayToken, endpointXor, wasmStreamDescriptorsTemplate, nil, integrityKey, log...)
}

// BuildWasmStunAllocateRequestWithStreamSsrcs builds the WASM/Web allocate with
// per-call stream descriptors. The static KAT template only proves the wire shape; live
// calls must carry the SSRCs derived from the current call ID and participant LID.
func BuildWasmStunAllocateRequestWithStreamSsrcs(transactionID [12]byte, relayToken []byte, endpointXor [6]byte, streamSsrcs [9]uint32, integrityKey []byte, log ...zerolog.Logger) []byte {
	return buildWasmStunAllocateRequest(transactionID, relayToken, endpointXor, CreateWasmStreamDescriptors(streamSsrcs), nil, integrityKey, log...)
}

// BuildWasmStunAllocateRequestWithSubscriptions is BuildWasmStunAllocateRequestWithStreamSsrcs
// plus explicit peer sender-subscriptions (attr 0x4025, repeated: one per remote stream we
// want the relay to bridge to us). CreateVoipSenderSubscription/attrSenderSubscriptionsV2
// already existed in this file but were never called from the live allocate path -- the
// allocate only ever declared OUR OWN outbound streams, never which of the PEER's streams we
// want to receive. That is consistent with every symptom seen live: the relay confirms
// ALLOCATE-SUCCESS and consent PONG (both proven via direct log evidence), yet the peer's
// media never arrives -- a relay with no subscription record for us has no reason to forward
// anything the peer sends, regardless of how healthy our own side of the handshake is.
func BuildWasmStunAllocateRequestWithSubscriptions(transactionID [12]byte, relayToken []byte, endpointXor [6]byte, streamSsrcs [9]uint32, peerSubscriptions [][]byte, integrityKey []byte, log ...zerolog.Logger) []byte {
	return buildWasmStunAllocateRequest(transactionID, relayToken, endpointXor, CreateWasmStreamDescriptors(streamSsrcs), peerSubscriptions, integrityKey, log...)
}

func buildWasmStunAllocateRequest(transactionID [12]byte, relayToken []byte, endpointXor [6]byte, streamDescriptors []byte, peerSubscriptions [][]byte, integrityKey []byte, log ...zerolog.Logger) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L155-L177
	lg := pickLog(log)
	lg.Debug().
		Int("relay_token_bytes", len(relayToken)).
		Int("stream_descriptor_bytes", len(streamDescriptors)).
		Int("subscription_count", len(peerSubscriptions)).
		Bool("message_integrity", integrityKey != nil).
		Msg("building wasm allocate request")
	attrs := stunAttr(attrRelayToken, relayToken)
	// CreateVoipSenderSubscriptions/CreateVoipSenderSubscriptionForLayer's own citation says
	// these are attr 0x4000 (attrRelayToken's own value) for the WASM/Web variant, repeated
	// alongside the token itself -- NOT attrSenderSubscriptionsV2 (0x4025), which is the APK
	// variant's distinct attribute. STUN allows repeated attributes of the same type.
	for _, sub := range peerSubscriptions {
		attrs = append(attrs, stunAttr(attrRelayToken, sub)...)
	}
	attrs = append(attrs, stunAttr(attrStreamDescriptors, streamDescriptors)...)
	wep := createWasmRelayEndpointAttr(endpointXor)
	attrs = append(attrs, stunAttr(attrWasmRelayEndpoint, wep[:])...)
	return EncodeStunRequest(MsgAllocateRequest, transactionID, attrs, integrityKey, false, lg)
}

var wasmStreamDescriptorPlan = [9]struct {
	participant uint32
	layer       uint32
}{
	{0, 0},
	{0, 1},
	{0, 2},
	{1, 0},
	{1, 1},
	{1, 2},
	{2, 0},
	{2, 1},
	{2, 2},
}

// CreateWasmStreamDescriptors builds the WASM/Web attr 0x4024 protobuf payload for the
// nine relay stream SSRCs in rtp.WasmRelayStreamSlotWords order.
func CreateWasmStreamDescriptors(ssrcs [9]uint32) []byte {
	var out []byte
	for i, ssrc := range ssrcs {
		if ssrc == 0 {
			continue
		}
		plan := wasmStreamDescriptorPlan[i]
		var inner []byte
		if plan.participant != 0 {
			inner = pbTag(inner, 1, 0)
			inner = binary.AppendUvarint(inner, uint64(plan.participant))
		}
		if plan.layer != 0 {
			inner = pbTag(inner, 2, 0)
			inner = binary.AppendUvarint(inner, uint64(plan.layer))
		}
		inner = pbTag(inner, 3, 0)
		inner = binary.AppendUvarint(inner, uint64(ssrc))
		out = pbLenDelim(out, 1, inner)
	}
	return out
}

// BuildWhatsappPing builds the WhatsApp consent ping (type 0x0801, empty body).
func BuildWhatsappPing(transactionID [12]byte, log ...zerolog.Logger) [20]byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L180-L186
	lg := pickLog(log)
	lg.Trace().Uint16("msg_type", MsgWhatsappPing).Msg("built whatsapp consent ping")
	var out [20]byte
	binary.BigEndian.PutUint16(out[0:2], MsgWhatsappPing)
	binary.BigEndian.PutUint32(out[4:8], stunMagic)
	copy(out[8:20], transactionID[:])
	return out
}

// BuildIceBindingRequest builds a standards-compliant (RFC 5389/8445) ICE STUN Binding
// Request carrying WhatsApp's relay token inside the USERNAME attribute, matching what
// WhatsApp Web's real browser client sends before its DTLS handshake ever starts.
//
// Discovered from a live chrome://webrtc-internals capture of a real WhatsApp Web video
// call (2026-08-03), not from the whatsapp-rust reference source cited elsewhere in this
// file (that client is native/APK-oriented and doesn't use this browser-specific
// ICE-credential trick). The browser's self-synthesized SDP "answer" sets the REMOTE
// ice-ufrag to a huge base64 blob -- exactly base64(relay_token) by byte length -- and
// ice-pwd to a short base64 string matching this codebase's own relayKeyASCII
// MESSAGE-INTEGRITY key in both length and role. Chrome's native WebRTC stack then
// performs a real ICE connectivity check against the relay using
// USERNAME="{remote_ufrag}:{local_ufrag}" and MESSAGE-INTEGRITY keyed by the remote
// ice-pwd, BEFORE DTLS ever starts -- a completely different, and until now never sent,
// authentication step from this codebase's own custom MsgAllocateRequest (0x0003), which
// every capture all night showed succeeding (ALLOCATE-SUCCESS + consent PONG) while the
// relay still never bridged the peer's media.
//
// A first attempt at this (USERNAME + MESSAGE-INTEGRITY + FINGERPRINT only) shipped and
// was tested live but made no difference. A real Wireshark capture of a genuine WhatsApp
// Web call (2026-08-03, wavideo.pcapng) showed the actual attribute set a working client
// sends, byte for byte, in order: USERNAME, a libwebrtc-proprietary NETWORK-INFO attribute
// (0xC057, cosmetic -- carries interface id/cost for multipath ranking, safely omittable),
// ICE-CONTROLLING (0x802A, 8-byte tie-breaker), USE-CANDIDATE (0x0025, zero-length),
// PRIORITY (0x0024, 4 bytes), MESSAGE-INTEGRITY, FINGERPRINT. USE-CANDIDATE is the real
// RFC 8445 ICE nomination signal -- without it, even a fully credential-valid Binding
// Request is just a connectivity probe to an ICE-lite agent, never a nomination, and the
// far side has no reason to ever commit this candidate pair as the one to bridge media on.
// That gap, not the credentials themselves, is suspected to be why every prior attempt
// tonight got a clean ALLOCATE-SUCCESS/consent-PONG-equivalent yet zero peer media.
func BuildIceBindingRequest(transactionID [12]byte, relayToken []byte, localUfrag string, integrityKey []byte, log ...zerolog.Logger) []byte {
	lg := pickLog(log)
	username := base64.StdEncoding.EncodeToString(relayToken) + ":" + localUfrag
	attrs := stunAttr(attrUsername, []byte(username))

	// ICE-CONTROLLING: 8-byte tie-breaker signaling we are the controlling agent (we are
	// always the one initiating checks against a server-side relay, never the other way
	// round, so there is no real role-conflict scenario here -- any random value works).
	var tieBreaker [8]byte
	_, _ = rand.Read(tieBreaker[:])
	attrs = append(attrs, stunAttr(attrIceControlling, tieBreaker[:])...)

	// USE-CANDIDATE: zero-length, nominates this pair. See doc comment above -- this is
	// the piece missing from the first attempt, and the leading suspect for why that
	// attempt made no observable difference.
	attrs = append(attrs, stunAttr(attrUseCandidate, nil)...)

	// PRIORITY: real value observed live (0x6e7e1eff). The exact number only matters for
	// ranking among multiple candidate pairs; with a single pair here there is nothing to
	// rank, so the confirmed-real constant is reused rather than deriving one from the
	// RFC 8445 formula from scratch.
	var priority [4]byte
	binary.BigEndian.PutUint32(priority[:], 0x6e7e1eff)
	attrs = append(attrs, stunAttr(attrPriority, priority[:])...)

	lg.Debug().Int("username_bytes", len(username)).Msg("building ICE STUN binding request")
	return EncodeStunRequest(MsgBindingRequest, transactionID, attrs, integrityKey, true, lg)
}

// GenerateIceUfrag returns a short random ICE-style local ufrag: 3 random bytes,
// base64-encoded to exactly 4 characters with no padding -- matching the length WhatsApp
// Web's own browser client uses for its local side (observed live: "+KoB").
func GenerateIceUfrag() string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return base64.StdEncoding.EncodeToString(b[:])
}

// IsStunPacket reports whether data looks like a STUN packet (top two bits zero).
func IsStunPacket(data []byte) bool {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L188-L190
	return len(data) >= 2 && (data[0]&0xc0) == 0x00
}

// StunMessageType returns the STUN message type; ok=false if data is too short.
func StunMessageType(data []byte) (uint16, bool) {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L192-L194
	if len(data) < 2 {
		return 0, false
	}
	return (uint16(data[0]&0x3f) << 8) | uint16(data[1]), true
}

// StunTransactionID returns the 12-byte transaction id; ok=false if data < 20 bytes.
func StunTransactionID(data []byte) ([]byte, bool) {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L196-L198
	if len(data) < 20 {
		return nil, false
	}
	return data[8:20], true
}

// IsAllocateOrBindingSuccess reports an Allocate/Binding success response.
func IsAllocateOrBindingSuccess(data []byte) bool {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L200-L208
	if !IsStunPacket(data) || len(data) < 20 {
		return false
	}
	mt, ok := StunMessageType(data)
	return ok && (mt == MsgAllocateSuccess || mt == MsgBindingSuccess)
}

// IsAllocateError reports an Allocate-error response.
func IsAllocateError(data []byte) bool {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L210-L212
	if !IsStunPacket(data) {
		return false
	}
	mt, ok := StunMessageType(data)
	return ok && mt == MsgAllocateError
}

// IsWhatsappPong reports a WhatsApp pong; a nil/empty transactionID matches any.
func IsWhatsappPong(data []byte, transactionID []byte) bool {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L214-L222
	if !IsStunPacket(data) {
		return false
	}
	mt, ok := StunMessageType(data)
	if !ok || mt != MsgWhatsappPong {
		return false
	}
	if len(transactionID) == 0 {
		return true
	}
	tx, ok := StunTransactionID(data)
	return ok && bytes.Equal(tx, transactionID)
}

// StunAttribute is one parsed STUN TLV.
type StunAttribute struct {
	AttrType uint16
	Value    []byte
}

// ParseStunAttributes parses the STUN attributes after the 20-byte header.
func ParseStunAttributes(data []byte, log ...zerolog.Logger) []StunAttribute {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L231-L251
	lg := pickLog(log)
	if !IsStunPacket(data) || len(data) < 20 {
		lg.Debug().Int("packet_bytes", len(data)).Msg("parse stun attributes: not a stun packet or too short")
		return nil
	}
	var attrs []StunAttribute
	off := 20
	for off+4 <= len(data) {
		attrType := (uint16(data[off]) << 8) | uint16(data[off+1])
		length := (int(data[off+2]) << 8) | int(data[off+3])
		off += 4
		if off+length > len(data) {
			break
		}
		attrs = append(attrs, StunAttribute{
			AttrType: attrType,
			Value:    append([]byte(nil), data[off:off+length]...),
		})
		off += length + pad4(length)
	}
	lg.Trace().Int("attr_count", len(attrs)).Int("packet_bytes", len(data)).Msg("parsed stun attributes")
	return attrs
}

// ParseStunErrorCode parses the numeric error code (class*100+number); ok=false if absent.
func ParseStunErrorCode(data []byte, log ...zerolog.Logger) (uint16, bool) {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L254-L276
	lg := pickLog(log)
	if len(data) < 20 {
		return 0, false
	}
	t, ok := StunMessageType(data)
	if !ok || (t != MsgAllocateError && t != 0x0111) {
		lg.Debug().Uint16("msg_type", t).Msg("parse stun error code: not an error response")
		return 0, false
	}
	bodyLen := (int(data[2]) << 8) | int(data[3])
	end := min(20+bodyLen, len(data))
	off := 20
	for off+4 <= end {
		attrType := (uint16(data[off]) << 8) | uint16(data[off+1])
		length := (int(data[off+2]) << 8) | int(data[off+3])
		if attrType == attrErrorCode && length >= 4 && off+8 <= len(data) {
			class := uint16(data[off+6])
			number := uint16(data[off+7])
			code := class*100 + number
			lg.Debug().Uint16("error_code", code).Msg("parsed stun error code")
			return code, true
		}
		off += 4 + length + pad4(length)
	}
	lg.Debug().Msg("parse stun error code: no error-code attribute found")
	return 0, false
}

// pbTag writes a protobuf field tag.
func pbTag(out []byte, field, wire uint32) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L284-L286
	return binary.AppendUvarint(out, uint64((field<<3)|wire))
}

// pbZigzag zigzag-encodes a signed integer.
func pbZigzag(n int64) uint64 {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L288-L290
	return uint64((n << 1) ^ (n >> 63))
}

// pbLenDelim writes a length-delimited protobuf field.
func pbLenDelim(out []byte, field uint32, b []byte) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L292-L296
	out = pbTag(out, field, 2)
	out = binary.AppendUvarint(out, uint64(len(b)))
	return append(out, b...)
}

// CreateVoipSenderSubscriptions builds voip.SenderSubscriptions (WASM, attr 0x4000) for the
// AUDIO layer (kept for compatibility with the KAT-shape reference); see
// CreateVoipSenderSubscriptionForLayer for a specific stream_layer (e.g. video).
func CreateVoipSenderSubscriptions(ssrc uint32) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L299-L310
	return CreateVoipSenderSubscriptionForLayer(ssrc, 0)
}

// CreateVoipSenderSubscriptionForLayer builds one voip.SenderSubscriptions entry (WASM,
// repeated attr 0x4025) subscribing to a remote SSRC on the given stream_layer -- this is
// how we tell the relay which of the PEER's streams to bridge to us; the relay's own
// ALLOCATE-SUCCESS only ever covers OUR declared outbound streams (see
// BuildWasmStunAllocateRequestWithSubscriptions). layer follows this session's own 0/1/2
// per-participant slot grouping (0=audio, matching CreateVoipSenderSubscriptions above;
// 1=video is the next untested layer value -- NOT KAT-validated, best inference from the
// only real reference shape we have).
func CreateVoipSenderSubscriptionForLayer(ssrc uint32, layer uint64) []byte {
	var sender []byte
	sender = pbTag(sender, 3, 0) // ssrc
	sender = binary.AppendUvarint(sender, uint64(ssrc))
	sender = pbTag(sender, 5, 0) // stream_layer
	sender = binary.AppendUvarint(sender, layer)
	sender = pbTag(sender, 6, 0) // payload_type = MEDIA(0)
	sender = binary.AppendUvarint(sender, 0)
	return pbLenDelim(nil, 1, sender)
}

// CreateApkSenderSubscriptions builds wa.voip.SenderSubscriptions (APK, attr 0x4025).
func CreateApkSenderSubscriptions(ssrc uint32, pid *uint32) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L313-L329
	var ssrcLayers []byte
	ssrcLayers = pbTag(ssrcLayers, 1, 0) // ssrcs[0] (sint64, zigzag)
	ssrcLayers = binary.AppendUvarint(ssrcLayers, pbZigzag(int64(ssrc)))
	if pid != nil {
		var p []byte
		p = pbTag(p, 1, 0) // pid (sint64)
		p = binary.AppendUvarint(p, pbZigzag(int64(*pid)))
		p = pbLenDelim(p, 2, []byte("audio")) // layerId
		ssrcLayers = pbLenDelim(ssrcLayers, 2, p)
	}
	ext := pbLenDelim(nil, 1, ssrcLayers) // ssrcLayers
	return pbLenDelim(nil, 1, ext)        // subscriptions[0]
}

// CreateApkStreamDescriptors builds wa.voip.StreamDescriptors (APK, attr 0x4024).
func CreateApkStreamDescriptors(ssrc uint32) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L332-L343
	var sd []byte
	sd = pbLenDelim(sd, 1, []byte("audio")) // stream_layer
	sd = pbLenDelim(sd, 2, []byte("OPUS"))  // payload_type
	sd = pbTag(sd, 3, 0)                    // ssrc (sint64)
	sd = binary.AppendUvarint(sd, pbZigzag(int64(ssrc)))
	sd = pbTag(sd, 4, 0) // is_uplink_prefetch_enabled = false
	sd = binary.AppendUvarint(sd, 0)
	return pbLenDelim(nil, 1, sd)
}

// BuildAndroidStunAllocateRequest builds the APK Allocate: 0x4000 token + 0x4025
// sender subs + 0x4024 stream desc + MI.
func BuildAndroidStunAllocateRequest(transactionID [12]byte, relayToken []byte, ssrc uint32, pid *uint32, integrityKey []byte, includeFingerprint bool, log ...zerolog.Logger) []byte {
	// Source of truth: https://github.com/oxidezap/whatsapp-rust/blob/41095d4e6ba4610e054e9ede3af1d5e88a83faee/wacore/src/voip/stun.rs#L346-L370
	lg := pickLog(log)
	lg.Debug().
		Uint32("ssrc", ssrc).
		Bool("has_pid", pid != nil).
		Int("relay_token_bytes", len(relayToken)).
		Bool("message_integrity", integrityKey != nil).
		Bool("fingerprint", includeFingerprint).
		Msg("building android allocate request")
	attrs := stunAttr(attrRelayToken, relayToken)
	attrs = append(attrs, stunAttr(attrSenderSubscriptionsV2, CreateApkSenderSubscriptions(ssrc, pid))...)
	attrs = append(attrs, stunAttr(attrStreamDescriptors, CreateApkStreamDescriptors(ssrc))...)
	return EncodeStunRequest(MsgAllocateRequest, transactionID, attrs, integrityKey, includeFingerprint, lg)
}
