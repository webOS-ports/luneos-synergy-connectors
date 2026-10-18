//! Signal 1:1 CALL MEDIA bridge (presage side).
//!
//! Spawns and drives the standalone `signal_media --answer` engine (messaging/signal/calling/media)
//! for an INCOMING Signal voice call, and relays the RingRTC signaling both ways over the manager:
//!
//!   incoming Offer  --> decode ConnectionParametersV4 (call_media.rs)
//!                       generate our ephemeral X25519 private key + ICE ufrag/pwd
//!                       spawn signal_media --answer, feed START
//!                       engine reports PUB  -> send CallMessage Answer  (encode_answer_opaque)
//!                       engine reports CAND -> send CallMessage IceUpdate (encode_ice_opaque)
//!   incoming IceUpdate --> decode_ice_opaque -> feed the engine "RCAND <candidate>"
//!   incoming Hangup/Busy --> feed the engine "STOP" and reap it
//!
//! The engine does the X25519 DH + AEAD_AES_256_GCM SRTP keying + ICE + Opus + ALSA itself; this
//! side is pure signaling. Sends go through the command channel (Cmd::SendCall*) so the command loop
//! -- which owns the concrete Manager -- performs the actual manager.send_message.
//!
//! GATING: media auto-answer only kicks in when the flag file /media/internal/signal_call_media
//! exists, so normal incoming calls keep the signaling-only v1 behaviour (ring + missed-call) and
//! only a deliberate test auto-answers. See RUNTIME_STATUS.md.
//!
//! KNOWN LIVE-CALL UNKNOWN: the SRTP KDF binds caller_id/callee_id (RingRTC identity material) into
//! the HKDF info. Their exact bytes are unverified, so we currently pass EMPTY ids -- signaling and
//! ICE connectivity will work, but two-way audio needs those ids confirmed against a real call.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::structs::Cmd;
use presage::libsignal_service::prelude::Uuid;

/// The media engine binary on the device (patchelf'd to the wpe-glibc loader; see build-signal-media.sh).
const SIGNAL_MEDIA_BIN: &str = "/media/internal/signal_media_p";
/// Presence of this file enables auto-answer + media for incoming calls (test gate).
const MEDIA_GATE_FILE: &str = "/media/internal/signal_call_media";
const WPE_DIR: &str = "/media/cryptofs/apps/usr/palm/applications/org.webosports.app.atlas/deviceroot/wpe-252";
/// AEC (webrtcdsp) plugin + its libwebrtc_audio_processing live in ENGINE-ONLY dirs, NOT the shared
/// wpe-252 gstreamer dir. The transport (imlibpurpletransport) also scans wpe-252/lib/gstreamer-1.0
/// for its own gstreamer use, and loading the webrtc-audio-processing lib CRASHED it (an atomic/LDREX
/// alignment trap in the lib's global ctors on the 2.6.35 kernel). Keeping the plugin in a private dir
/// that only signal_media_p's GST_PLUGIN_PATH/LD_LIBRARY_PATH reference means only the call engine can
/// ever load it - a bad lib can crash a call, never the whole transport.
const SIG_PLUGIN_DIR: &str = "/media/internal/sig-gst-plugins";
const SIG_LIB_DIR: &str = "/media/internal/sig-gst-libs";
/// GST_PLUGIN_PATH for the engine: the shared wpe plugins + our private AEC plugin dir.
fn sig_gst_plugin_path() -> String {
    format!("{WPE_DIR}/lib/gstreamer-1.0:{SIG_PLUGIN_DIR}")
}
/// LD_LIBRARY_PATH for the engine: our private AEC lib dir PREPENDED to the inherited wpe path (so the
/// webrtcdsp plugin resolves libwebrtc_audio_processing.so.1 without exposing it to the transport).
fn sig_ld_library_path() -> String {
    format!("{SIG_LIB_DIR}:{}", std::env::var("LD_LIBRARY_PATH").unwrap_or_default())
}

/// Command sender, stashed from presage_rust_main, so a per-call reader thread can enqueue the
/// Answer/IceUpdate for the command loop (which owns the Manager) to send.
static CMD_TX: OnceLock<Mutex<Option<tokio::sync::mpsc::Sender<Cmd>>>> = OnceLock::new();

struct CallProc {
    child: Child,
    stdin: ChildStdin,
}
/// Active calls keyed by RingRTC call_id (in practice one at a time; keyed for safety).
static CALLS: OnceLock<Mutex<HashMap<u64, CallProc>>> = OnceLock::new();

fn calls() -> &'static Mutex<HashMap<u64, CallProc>> {
    CALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// STUN/TURN servers for the current call, fetched from /v2/calling/relays (see ice.rs) by the async
/// contexts (core.rs place_call, receive.rs incoming) and read here when the engine is spawned. The
/// engine only gathers host candidates without these -> no NAT traversal -> permanent "Connecting".
static ICE_SERVERS: OnceLock<Mutex<Vec<crate::ice::IceServer>>> = OnceLock::new();
fn ice_servers() -> &'static Mutex<Vec<crate::ice::IceServer>> {
    ICE_SERVERS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Stash the ICE servers for the next engine spawn (call before place_call / start_incoming).
pub fn set_ice_servers(servers: Vec<crate::ice::IceServer>) {
    *ice_servers().lock().unwrap() = servers;
}

/// Write the stashed STUN/TURN servers as `RELAY` lines. MUST be sent before `START` so the engine
/// wires them into the nice agent (set_stun_server / set_relay_info) before it gathers candidates.
fn write_relay_lines<W: std::io::Write>(w: &mut W) {
    let servers = ice_servers().lock().unwrap();
    // TEMP diagnostic (2026-07-30): dump the live, full-credential RELAY lines to a file so the
    // standalone turn_loopback test (messaging/signal/calling/media/turn_loopback.c) can reuse a
    // real, currently-valid TURN allocation without needing its own Signal account/session. Remove
    // once the TURN relay-to-relay receive-path question is resolved.
    if let Ok(mut f) = std::fs::File::create("/media/internal/turn_creds.txt") {
        for s in servers.iter() {
            let line = match s.kind {
                crate::ice::IceKind::Stun => format!("RELAY stun {} {}\n", s.host, s.port),
                crate::ice::IceKind::Turn => format!(
                    "RELAY turn {} {} {} {} {}\n",
                    s.host, s.port, s.username, s.password, s.transport
                ),
            };
            let _ = f.write_all(line.as_bytes());
        }
    }
    for s in servers.iter() {
        let line = match s.kind {
            crate::ice::IceKind::Stun => format!("RELAY stun {} {}\n", s.host, s.port),
            crate::ice::IceKind::Turn => format!(
                "RELAY turn {} {} {} {} {}\n",
                s.host, s.port, s.username, s.password, s.transport
            ),
        };
        let _ = w.write_all(line.as_bytes());
    }
    eprintln!("call_bridge: sent {} RELAY line(s) to engine", servers.len());
}
fn cmd_tx_slot() -> &'static Mutex<Option<tokio::sync::mpsc::Sender<Cmd>>> {
    CMD_TX.get_or_init(|| Mutex::new(None))
}

/// Called once from presage_rust_main with a clone of the command channel sender.
pub fn set_command_sender(tx: tokio::sync::mpsc::Sender<Cmd>) {
    *cmd_tx_slot().lock().unwrap() = Some(tx);
}

/// Enqueue a Cmd for the command loop. Called from a std reader thread (no async context), so
/// blocking_send is correct here.
fn enqueue(cmd: Cmd) {
    if let Some(tx) = cmd_tx_slot().lock().unwrap().as_ref() {
        let _ = tx.blocking_send(cmd);
    }
}

pub fn media_enabled() -> bool {
    std::path::Path::new(MEDIA_GATE_FILE).exists()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
fn rand_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf
}
/// Random ICE token of `n` hex chars (a valid RFC5245 ice-char subset).
fn rand_token(n: usize) -> String {
    let s = hex(&rand_bytes(n.div_ceil(2)));
    s[..n].to_string()
}

/// Start (auto-answer) media for an incoming call. `caller_uuid` is who we send Answer/ICE back to.
///
/// `caller_id` / `callee_id` are the 32-byte RAW Curve25519 identity public keys bound into the
/// SRTP KDF (RingRTC negotiate_srtp_keys: caller = the offerer/remote peer's ACI identity key,
/// callee = our ACI identity key). Pass empty slices if unavailable -- signaling/ICE still work but
/// the SRTP keys won't match the peer, so there will be no audio.
pub fn start_incoming(
    caller_uuid: Uuid,
    call_id: u64,
    offer_opaque: &[u8],
    caller_id: &[u8],
    callee_id: &[u8],
) {
    if !media_enabled() {
        return;
    }
    let params = match crate::call_media::decode_offer_opaque(offer_opaque) {
        Some(p) => p,
        None => {
            eprintln!("call_bridge: could not decode offer opaque for call {call_id}");
            return;
        }
    };
    if caller_id.is_empty() || callee_id.is_empty() {
        eprintln!("call_bridge: WARNING starting call {call_id} without identity keys -> no audio (signaling/ICE only)");
    }

    let priv32 = rand_bytes(32);
    let our_ufrag = rand_token(4);
    let our_pwd = rand_token(24);

    // Capture the engine's stderr (gst/ICE/SRTP/ALSA logs) to a file so a live call is diagnosable;
    // fall back to null if the file can't be opened.
    let engine_log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/media/internal/sigmedia_call.log")
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let mut child = match Command::new(SIGNAL_MEDIA_BIN)
        .arg("--answer")
        // The engine inherits imlibpurpletransport's env (the correct wpe LD_LIBRARY_PATH incl.
        // /media/internal/sslfix where the GCM libsrtp2 lives); we only pin the gst plugin path +
        // a writable registry so it never rescans into a read-only location.
        .env("GST_PLUGIN_PATH", sig_gst_plugin_path())
        .env("LD_LIBRARY_PATH", sig_ld_library_path())
        .env("GST_REGISTRY", "/media/internal/gstreg-sig.bin")
        .env("GST_DEBUG", "2")
        // TEMP diagnostic: libnice's ICE conncheck internals (why us->peer checks never validate ->
        // ICE FAILED even though inbound SRTP arrives). Goes to the engine's stderr = sigmedia_call.log.
        // Remove once ICE nomination works. G_MESSAGES_DEBUG is needed for glib to print g_debug().
        .env("NICE_DEBUG", "all")
        .env("G_MESSAGES_DEBUG", "all")
        // Force gst's alsasink/alsasrc to use the SYSTEM libasound (which knows /usr/lib/alsa-lib's
        // pulse plugin + /etc/asound.conf's voip/voipsource PCMs). Without this, gst loads the Atlas
        // wpe-252 libasound, which can't find its pulse module -> "Cannot open shared library" ->
        // alsasink "No such device" -> pipeline fails to set PLAYING -> the call drops. This is the
        // same system-libasound route the Telegram/wacallm audio path uses. Verified on device.
        .env("LD_PRELOAD", "/usr/lib/libasound.so.2")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(engine_log)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("call_bridge: failed to spawn {SIGNAL_MEDIA_BIN}: {e}");
            return;
        }
    };

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => return,
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => return,
    };

    let start = format!(
        "START {} {} {} {} {} {} {} {}\n",
        hex(&priv32),
        hex(&params.public_key),
        hex(caller_id),
        hex(callee_id),
        our_ufrag,
        our_pwd,
        params.ice_ufrag,
        params.ice_pwd,
    );
    write_relay_lines(&mut stdin); // STUN/TURN config MUST precede START (engine wires it pre-gather)
    if let Err(e) = stdin.write_all(start.as_bytes()) {
        eprintln!("call_bridge: failed to write START: {e}");
        return;
    }
    let _ = stdin.flush();

    // Reader thread: turn the engine's PUB/CAND lines into outgoing CallMessages.
    let ufrag_c = our_ufrag.clone();
    let pwd_c = our_pwd.clone();
    eprintln!("call_bridge: [DIAG] incoming-side reader thread SPAWNING for call_id={call_id}");
    std::thread::spawn(move || {
        eprintln!("call_bridge: [DIAG] incoming-side reader thread RUNNING for call_id={call_id}");
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => { eprintln!("call_bridge: [DIAG] reader.lines() Err: {e}"); break; }
            };
            eprintln!("call_bridge: [DIAG] incoming-side reader RAW LINE: {line:?}");
            if let Some(pubhex) = line.strip_prefix("PUB ") {
                if let Some(pk) = unhex(pubhex.trim()) {
                    let opaque = crate::call_media::encode_answer_opaque(&pk, &ufrag_c, &pwd_c);
                    enqueue(Cmd::SendCallAnswer { uuid: caller_uuid, call_id, opaque });
                }
            } else if let Some(cand) = line.strip_prefix("CAND ") {
                let opaque = crate::call_media::encode_ice_opaque(cand.trim());
                eprintln!("call_bridge: [DIAG] incoming-side reader got CAND, enqueueing SendCallIce call_id={call_id} opaque_len={}", opaque.len());
                enqueue(Cmd::SendCallIce { uuid: caller_uuid, call_id, opaque });
            }
            // READY / AUDIOD / ERR: audiod is driven by call.c; just ignore here.
        }
        eprintln!("call_bridge: [DIAG] incoming-side reader thread EXITED for call_id={call_id}");
    });

    calls().lock().unwrap().insert(call_id, CallProc { child, stdin });
}

// ---------------------------------------------------------------------------------------------
// OUTGOING (caller) side.
//
// Unlike an incoming call (where the Offer already carries the peer's key + ICE creds so the engine
// starts immediately), a caller sends its Offer FIRST and only learns the peer's key/creds from the
// Answer. So place_call() generates our ephemeral keypair + ICE creds, derives our public key via a
// throwaway `signal_media --caller` PREPARE (reusing the engine's verified X25519), and returns the
// Offer opaque for the command loop to send. The engine proper is not started until on_answer().
// ---------------------------------------------------------------------------------------------

/// Outgoing call awaiting the peer's Answer (keyed by call_id).
struct Pending {
    callee: Uuid,          // who we send the Offer/ICE to (and receive the Answer from)
    priv32: Vec<u8>,       // our ephemeral X25519 private key
    our_ufrag: String,
    our_pwd: String,
    caller_id: Vec<u8>,    // OUR identity key (we are the caller) - bound into the SRTP KDF
    callee_id: Vec<u8>,    // the peer's identity key
    buffered_ice: Vec<Vec<u8>>, // peer IceUpdate opaques that arrived before the engine started
}
static PENDING: OnceLock<Mutex<HashMap<u64, Pending>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<u64, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// call_ids we placed (OUTGOING). Kept until the call is stopped so the receive loop can tell an
/// outgoing call's hangup apart from a genuinely missed INCOMING call (no "Missed voice call" line).
static OUTGOING: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
fn outgoing() -> &'static Mutex<HashSet<u64>> {
    OUTGOING.get_or_init(|| Mutex::new(HashSet::new()))
}
/// True if this call_id is one WE placed (so its hangup is not a missed incoming call).
pub fn is_outgoing_call(call_id: u64) -> bool {
    outgoing().lock().unwrap().contains(&call_id)
}

/// For an OUTGOING call, the EXACT address the user dialed (e.g. "+31621489831") vs the resolved Signal
/// UUID we place the call to. The stock dialer keys its pending "Connecting" card on the dialed address,
/// so every state we push for this call (dialing/active/ended) must report the dialed address too - else
/// the dialer sees a second call (a UUID it never dialed) and shows TWO cards. Mirrors Telegram's
/// getCallDialedAddress. Keyed by call_id; set in place_call, read in the state pushes, cleared in stop.
static DIALED: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();
fn dialed() -> &'static Mutex<HashMap<u64, String>> {
    DIALED.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn set_dialed_address(call_id: u64, addr: String) {
    dialed().lock().unwrap().insert(call_id, addr);
}
/// The dialed address for an outgoing call_id, or None (incoming / unknown).
pub fn dialed_address(call_id: u64) -> Option<String> {
    dialed().lock().unwrap().get(&call_id).cloned()
}

/// call_ids the user has ACCEPTED on THIS (linked) device. webOS is a secondary Signal device; an
/// incoming call rings this device AND the user's primary phone. When we accept, the caller broadcasts
/// `Hangup{type=ACCEPTED, device_id=<us>}` to the account so the OTHER devices stop ringing - but Signal
/// fans it out to us too. We must NOT tear down our own accepted call on that notification.
static ACCEPTED: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
fn accepted() -> &'static Mutex<HashSet<u64>> {
    ACCEPTED.get_or_init(|| Mutex::new(HashSet::new()))
}
/// True if the user accepted this call_id on this device (so a HANGUP_ACCEPTED for it is our own).
pub fn was_accepted(call_id: u64) -> bool {
    accepted().lock().unwrap().contains(&call_id)
}

/// The env every engine invocation needs (wpe LD_LIBRARY_PATH is inherited; we pin gst + libasound).
fn engine_command(mode: &str) -> Command {
    let mut c = Command::new(SIGNAL_MEDIA_BIN);
    c.arg(mode)
        .env("GST_PLUGIN_PATH", sig_gst_plugin_path())
        .env("LD_LIBRARY_PATH", sig_ld_library_path())
        .env("GST_REGISTRY", "/media/internal/gstreg-sig.bin")
        .env("GST_DEBUG", "2")
        // TEMP diagnostic: libnice's ICE conncheck internals (why us->peer checks never validate ->
        // ICE FAILED even though inbound SRTP arrives). Goes to the engine's stderr = sigmedia_call.log.
        // Remove once ICE nomination works. G_MESSAGES_DEBUG is needed for glib to print g_debug().
        .env("NICE_DEBUG", "all")
        .env("G_MESSAGES_DEBUG", "all")
        .env("LD_PRELOAD", "/usr/lib/libasound.so.2");
    c
}

/// Derive our X25519 public key from `priv32` by driving a throwaway engine PREPARE. Returns the
/// 32-byte public key, or None on failure. Short-lived: the child exits when we drop its stdin.
fn derive_pubkey(priv32: &[u8]) -> Option<Vec<u8>> {
    let mut child = engine_command("--caller")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let _ = writeln!(stdin, "PREPARE {}", hex(priv32));
    let _ = stdin.flush();
    let mut pub_hex = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        if let Some(p) = line.strip_prefix("PUB ") {
            pub_hex = Some(p.trim().to_string());
            break;
        }
        if line.starts_with("ERR") {
            break;
        }
    }
    drop(stdin); // EOF -> engine leaves its IPC loop and exits
    let _ = child.kill();
    let _ = child.wait();
    pub_hex.and_then(|h| unhex(&h))
}

/// Place an OUTGOING call. Generates our ephemeral keypair + ICE creds, stores pending state (so
/// on_answer can start media), and returns (call_id, offer_opaque) for the command loop to send as
/// a CallMessage Offer to `callee`. Returns None if media is disabled or key derivation fails.
pub fn place_call(callee: Uuid, caller_id: Vec<u8>, callee_id: Vec<u8>) -> Option<(u64, Vec<u8>)> {
    if !media_enabled() {
        eprintln!("call_bridge: place_call ignored - media gate file absent");
        return None;
    }
    let priv32 = rand_bytes(32);
    let pub32 = match derive_pubkey(&priv32) {
        Some(p) => p,
        None => {
            eprintln!("call_bridge: place_call could not derive our public key");
            return None;
        }
    };
    let our_ufrag = rand_token(4);
    let our_pwd = rand_token(24);
    // RingRTC call_id is a random u64.
    let mut idb = [0u8; 8];
    idb.copy_from_slice(&rand_bytes(8));
    let call_id = u64::from_be_bytes(idb);

    let opaque = crate::call_media::encode_offer_opaque(&pub32, &our_ufrag, &our_pwd, 2_000_000);
    pending().lock().unwrap().insert(
        call_id,
        Pending { callee, priv32, our_ufrag, our_pwd, caller_id, callee_id, buffered_ice: Vec::new() },
    );
    outgoing().lock().unwrap().insert(call_id);
    Some((call_id, opaque))
}

/// The peer ANSWERED our outgoing call: decode their ConnectionParametersV4, start the media engine
/// in caller role, wire its CAND lines to outgoing IceUpdates, and flush any early remote ICE.
pub fn on_answer(call_id: u64, answer_opaque: &[u8]) {
    let p = match pending().lock().unwrap().remove(&call_id) {
        Some(p) => p,
        None => return, // not our outgoing call (or already started)
    };
    let params = match crate::call_media::decode_offer_opaque(answer_opaque) {
        Some(p) => p,
        None => {
            eprintln!("call_bridge: could not decode answer opaque for call {call_id}");
            return;
        }
    };

    let engine_log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/media/internal/sigmedia_call.log")
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let mut child = match engine_command("--caller")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(engine_log)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("call_bridge: failed to spawn caller engine: {e}");
            return;
        }
    };
    let mut stdin = match child.stdin.take() { Some(s) => s, None => return };
    let stdout = match child.stdout.take() { Some(s) => s, None => return };

    // Caller START: same 8 fields as the answerer, but the engine (--caller) flips RX/TX keys, and
    // remote_pub / remote_ufrag / remote_pwd come from the ANSWER; caller_id = OUR identity.
    let start = format!(
        "START {} {} {} {} {} {} {} {}\n",
        hex(&p.priv32),
        hex(&params.public_key),
        hex(&p.caller_id),
        hex(&p.callee_id),
        p.our_ufrag,
        p.our_pwd,
        params.ice_ufrag,
        params.ice_pwd,
    );
    if let Err(e) = stdin.write_all(start.as_bytes()) {
        eprintln!("call_bridge: failed to write caller START: {e}");
        return;
    }
    let _ = stdin.flush();

    // Reader thread: the caller only relays its local candidates (it already sent the Offer; the
    // engine emits no PUB in caller mode).
    let callee = p.callee;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line { Ok(l) => l, Err(_) => break };
            if let Some(cand) = line.strip_prefix("CAND ") {
                let opaque = crate::call_media::encode_ice_opaque(cand.trim());
                enqueue(Cmd::SendCallIce { uuid: callee, call_id, opaque });
            }
        }
    });

    // Flush any remote ICE that arrived between our Offer and this Answer.
    for op in &p.buffered_ice {
        if let Some(cand) = crate::call_media::decode_ice_opaque(op) {
            let _ = writeln!(stdin, "RCAND {cand}");
        }
    }
    let _ = stdin.flush();

    calls().lock().unwrap().insert(call_id, CallProc { child, stdin });
}

/// Feed the engine one or more remote ICE candidates decoded from incoming IceUpdate opaques. If
/// the call is still a pending OUTGOING one (engine not started until the Answer), buffer them.
pub fn feed_remote_ice(call_id: u64, candidate_opaques: &[Vec<u8>]) {
    {
        let mut pend = pending().lock().unwrap();
        if let Some(p) = pend.get_mut(&call_id) {
            p.buffered_ice.extend_from_slice(candidate_opaques);
            return;
        }
    }
    let mut guard = calls().lock().unwrap();
    if let Some(cp) = guard.get_mut(&call_id) {
        for op in candidate_opaques {
            if let Some(cand) = crate::call_media::decode_ice_opaque(op) {
                let _ = writeln!(cp.stdin, "RCAND {cand}");
            }
        }
        let _ = cp.stdin.flush();
    }
}

/// User accepted an incoming call: tell the engine to start sending the RingRTC rtp-data `Accepted`
/// message (repeated at 1 Hz by the engine). Until the caller receives it, RingRTC keeps the caller
/// "ringing" and gates all media - so this is what actually connects an incoming call's audio.
pub fn accept(call_id: u64) {
    accepted().lock().unwrap().insert(call_id);
    let mut guard = calls().lock().unwrap();
    if let Some(cp) = guard.get_mut(&call_id) {
        let _ = writeln!(cp.stdin, "ACCEPT {call_id}");
        let _ = cp.stdin.flush();
    }
}

/// Tear down the engine for a call (hangup/busy). Also drops any pending outgoing state (the peer
/// declined/was-busy before answering, so the engine was never started).
pub fn stop(call_id: u64) {
    // DIAG (call-sustain): who tore down the call? Backtrace-free breadcrumb - the immediate caller is
    // in the log line just before this (receive.rs PEER-ended, or the C hangup path). Logs whether an
    // engine was actually running for this id (vs a stale/no-op stop).
    let had_engine = calls().lock().unwrap().contains_key(&call_id);
    eprintln!("call_bridge::stop(call_id={call_id}) had_running_engine={had_engine}");
    pending().lock().unwrap().remove(&call_id);
    outgoing().lock().unwrap().remove(&call_id);
    accepted().lock().unwrap().remove(&call_id);
    dialed().lock().unwrap().remove(&call_id);
    let cp = calls().lock().unwrap().remove(&call_id);
    if let Some(CallProc { mut child, mut stdin }) = cp {
        let _ = writeln!(stdin, "STOP");
        drop(stdin); // EOF -> engine leaves its stdin loop and calls signal_media_stop()
        // Reap off-thread so we never block the receive loop; kill as a backstop.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let _ = child.kill();
            let _ = child.wait();
        });
    }
}
