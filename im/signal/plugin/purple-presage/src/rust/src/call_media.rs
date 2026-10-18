//! Signal 1:1 call MEDIA signaling helpers (presage side).
//!
//! Encodes/decodes the `opaque` bytes carried by the CallMessage Offer/Answer/IceUpdate - i.e.
//! RingRTC's ConnectionParametersV4 and IceCandidate. Verified byte-for-byte against a real captured
//! call (see messaging/signal/calling/media/, /tmp/dec.py, and the standalone test below).
//!
//! Flow for an INCOMING call (we are the answerer):
//!   1. decode_offer_opaque(offer.opaque) -> peer public_key + ice_ufrag/ice_pwd (+ bitrate).
//!   2. media engine generates OUR X25519 keypair + ICE ufrag/pwd/candidates; SRTP keys come from
//!      signal_negotiate_srtp_keys() (messaging/signal/calling/media/srtp_kdf.c) using the DH.
//!   3. encode_answer_opaque(our_public_key, our_ufrag, our_pwd) -> send as a CallMessage Answer.
//!   4. our local ICE candidates -> encode_ice_opaque(candidate_string) -> send as IceUpdate(s).
//!   5. peer IceUpdates -> decode_ice_opaque -> feed to the media engine.
//! No DTLS: SRTP is AEAD_AES_256_GCM keyed by the Curve25519 DH.
#![allow(dead_code)]

/// Decoded ConnectionParametersV4 (the audio-relevant fields; video codecs are ignored).
#[derive(Debug, Default, Clone)]
pub struct ConnParamsV4 {
    pub public_key: Vec<u8>,   // 32-byte Curve25519
    pub ice_ufrag: String,
    pub ice_pwd: String,
    pub max_bitrate_bps: u64,
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 { b |= 0x80; }
        out.push(b);
        if v == 0 { break; }
    }
}
fn put_len_field(out: &mut Vec<u8>, field: u64, data: &[u8]) {
    put_varint(out, (field << 3) | 2);
    put_varint(out, data.len() as u64);
    out.extend_from_slice(data);
}

fn read_varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut r = 0u64;
    let mut s = 0;
    loop {
        let x = *b.get(*i)?;
        *i += 1;
        r |= ((x & 0x7f) as u64) << s;
        s += 7;
        if x & 0x80 == 0 { break; }
        if s >= 64 { return None; }
    }
    Some(r)
}

enum Field<'a> { Len(u64, &'a [u8]), Var(u64, u64) }

fn iter_fields(b: &[u8]) -> Vec<Field<'_>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let key = match read_varint(b, &mut i) { Some(k) => k, None => break };
        let f = key >> 3;
        match key & 7 {
            2 => {
                let ln = match read_varint(b, &mut i) { Some(l) => l as usize, None => break };
                if i + ln > b.len() { break; }
                out.push(Field::Len(f, &b[i..i + ln]));
                i += ln;
            }
            0 => match read_varint(b, &mut i) { Some(v) => out.push(Field::Var(f, v)), None => break },
            _ => break,
        }
    }
    out
}

/// Offer/Answer opaque = message { ConnectionParametersV4 v4 = 4 }.
pub fn decode_offer_opaque(op: &[u8]) -> Option<ConnParamsV4> {
    for f in iter_fields(op) {
        if let Field::Len(4, v4) = f {
            let mut c = ConnParamsV4::default();
            for g in iter_fields(v4) {
                match g {
                    Field::Len(1, b) => c.public_key = b.to_vec(),
                    Field::Len(2, b) => c.ice_ufrag = String::from_utf8_lossy(b).into_owned(),
                    Field::Len(3, b) => c.ice_pwd = String::from_utf8_lossy(b).into_owned(),
                    Field::Var(5, v) => c.max_bitrate_bps = v,
                    _ => {}
                }
            }
            return Some(c);
        }
    }
    None
}

/// Build OUR Answer opaque: message { ConnectionParametersV4 v4 = 4 { ... } }.
///
/// RingRTC uses the SAME ConnectionParametersV4 for the Offer AND the Answer, so the Answer must
/// carry the SAME fields a real Offer does: field 4 (receive_video_codecs, the constant VideoCodec
/// {1:8} we mirror from the captured reference) and field 5 (max_bitrate_bps). A stripped-down answer
/// with only public_key/ufrag/pwd is rejected by a live Signal peer, which then hangs up within ~1s
/// (the "disconnects right after accept" symptom) - the same reason encode_offer_opaque carries them.
pub fn encode_answer_opaque(public_key: &[u8], ufrag: &str, pwd: &str) -> Vec<u8> {
    encode_offer_opaque(public_key, ufrag, pwd, 2_000_000)
}

/// Build OUR Offer opaque (OUTGOING call): message { ConnectionParametersV4 v4 = 4 {
///   public_key=1, ice_ufrag=2, ice_pwd=3, <field4 const>, max_bitrate_bps=5 } }.
/// Same ConnectionParametersV4 as the Answer, plus the two fields a real RingRTC OFFER carries (the
/// small field-4 sub-message and the max-bitrate) so a live Signal answerer accepts it.
/// decode_offer_opaque round-trips fields 1/2/3/5.
pub fn encode_offer_opaque(public_key: &[u8], ufrag: &str, pwd: &str, max_bitrate_bps: u64) -> Vec<u8> {
    let mut v4 = Vec::new();
    put_len_field(&mut v4, 1, public_key);
    put_len_field(&mut v4, 2, ufrag.as_bytes());
    put_len_field(&mut v4, 3, pwd.as_bytes());
    // Field 4: the small nested message a real RingRTC offer includes (constant { 1: 8 } in the
    // captured reference). Carried verbatim for interop; the answerer's decoder ignores it.
    put_len_field(&mut v4, 4, &[0x08, 0x08]);
    // Field 5: max audio bitrate (varint). Real offers advertise 2_000_000.
    put_varint(&mut v4, (5 << 3) | 0);
    put_varint(&mut v4, max_bitrate_bps);
    let mut op = Vec::new();
    put_len_field(&mut op, 4, &v4);
    op
}

/// IceUpdate opaque = message { IceCandidate added = field 2 { string candidate = field 1 } }.
pub fn decode_ice_opaque(op: &[u8]) -> Option<String> {
    for f in iter_fields(op) {
        if let Field::Len(_, inner) = f {
            for g in iter_fields(inner) {
                if let Field::Len(1, s) = g {
                    return Some(String::from_utf8_lossy(s).into_owned());
                }
            }
        }
    }
    None
}

/// Build an IceUpdate opaque from an SDP candidate string.
pub fn encode_ice_opaque(candidate: &str) -> Vec<u8> {
    let mut inner = Vec::new();
    put_len_field(&mut inner, 1, candidate.as_bytes());
    let mut op = Vec::new();
    put_len_field(&mut op, 2, &inner);
    op
}

#[cfg(test)]
mod tests {
    use super::*;
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

    #[test]
    fn decodes_real_offer() {
        // Alan's real captured offer opaque (2026-07-21).
        let offer = unhex("224a0a20364fb3e8d71d17b656aca498ca2c4e9ffacfab68b6a7255507a8ca1d5863736112044e6c506e1a18456762473838716f385845773870506e5572613956504658220208082880897a");
        let c = decode_offer_opaque(&offer).unwrap();
        assert_eq!(hex(&c.public_key), "364fb3e8d71d17b656aca498ca2c4e9ffacfab68b6a7255507a8ca1d58637361");
        assert_eq!(c.ice_ufrag, "NlPn");
        assert_eq!(c.ice_pwd, "EgbG88qo8XEw8pPnUra9VPFX");
        assert_eq!(c.max_bitrate_bps, 2_000_000);
    }

    #[test]
    fn answer_round_trips() {
        let pk = unhex("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c");
        let ans = encode_answer_opaque(&pk, "AbCd", "our24charpasswordxxxxxxxx");
        let back = decode_offer_opaque(&ans).unwrap();
        assert_eq!(back.public_key, pk);
        assert_eq!(back.ice_ufrag, "AbCd");
        assert_eq!(back.ice_pwd, "our24charpasswordxxxxxxxx");
    }

    #[test]
    fn offer_round_trips() {
        let pk = unhex("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c");
        let off = encode_offer_opaque(&pk, "AbCd", "our24charpasswordxxxxxxxx", 2_000_000);
        let back = decode_offer_opaque(&off).unwrap();
        assert_eq!(back.public_key, pk);
        assert_eq!(back.ice_ufrag, "AbCd");
        assert_eq!(back.ice_pwd, "our24charpasswordxxxxxxxx");
        assert_eq!(back.max_bitrate_bps, 2_000_000);
    }

    #[test]
    fn ice_candidate_is_byte_identical() {
        // A real captured IceUpdate opaque; decode + re-encode must reproduce it exactly.
        let ice = unhex("127a0a7863616e6469646174653a333130383232383138382031207564702032313232323032383739203139322e3136382e3137382e34322035323937362074797020686f73742067656e65726174696f6e2030207566726167204e6c506e206e6574776f726b2d69642034206e6574776f726b2d636f7374203130");
        let cand = decode_ice_opaque(&ice).unwrap();
        assert!(cand.starts_with("candidate:3108228188 1 udp"));
        assert_eq!(encode_ice_opaque(&cand), ice);
    }
}
