/*
 *  Taken from presage-cli
 */
#[derive(Debug, Clone)]
pub enum Cmd {
    Exit,
    Whoami,
    Send {
        recipient: Recipient,
        message: Option<String>,
        xfer: *const crate::bridge_structs::PurpleXfer,
        // webOS replies: the reply target's serviceMessageId (its sent timestamp, in ms); 0 == not a
        // reply. send() looks the quoted message up by this timestamp to build the Signal Quote.
        reply_to_ts: u64,
    },
    // webOS reactions (SEND): transmit a reaction the user placed from the app. `recipient` is the
    // conversation peer (contact UUID / phone / group key); `target_ts` is the reacted-to message's
    // sent timestamp (its serviceMessageId); `remove` true retracts the user's emoji. Carries only
    // Send data, so the `unsafe impl Send for Cmd` above stays sound.
    SendReaction {
        recipient: Recipient,
        target_ts: u64,
        emoji: String,
        remove: bool,
    },
    ListGroups,
    GetGroupMembers {
        master_key_bytes: [u8; 32],
    },
    GetProfile {
        uuid: presage::libsignal_service::prelude::Uuid,
    },
    GetAttachment {
        attachment_pointer: presage::proto::AttachmentPointer,
        xfer: *const crate::bridge_structs::PurpleXfer,
    },
    // Emitted by the call media bridge (call_bridge.rs) so the command loop -- which owns the
    // concrete Manager -- sends our RingRTC Answer / IceUpdate CallMessages back to the caller.
    // `opaque` is the already-encoded ConnectionParametersV4 (answer) or IceCandidate (ice) blob.
    SendCallAnswer {
        uuid: presage::libsignal_service::prelude::Uuid,
        call_id: u64,
        opaque: Vec<u8>,
    },
    SendCallIce {
        uuid: presage::libsignal_service::prelude::Uuid,
        call_id: u64,
        opaque: Vec<u8>,
    },
    // Place an OUTGOING call to `callee` (a Signal UUID or e164). The command loop resolves the
    // recipient + identity keys, has call_bridge generate our keypair, and sends the Offer.
    PlaceCall {
        callee: String,
    },
    // End the current call locally (the user pressed hang up): send the peer a Hangup CallMessage so
    // their phone stops ringing / the call ends, and tear down our media engine. `callee` is the address
    // from the dialer's card - a Signal UUID OR (for an outgoing call now reported under the dialed
    // number) an E.164; the handler resolves a non-UUID like place_call does.
    HangupCall {
        callee: String,
        call_id: u64,
    },
    // User tapped Answer on an INCOMING call: tell the media engine to start sending the RingRTC
    // rtp-data `Accepted` message (PT 101 / SSRC 0xD, SRTP) so the caller's phone stops ringing and
    // both sides ungate media. Purely local -> no CallMessage; just drives the engine over its stdin.
    AcceptCall {
        call_id: u64,
    },
}

// Cmd already crosses threads today: it is pushed onto a tokio mpsc from the C-invoked send_cmd
// thread and drained on the runtime thread (tokio mpsc does not bound T: Send, so this compiles
// without the marker). The call bridge additionally needs to hold the Sender<Cmd> in a global so a
// std reader thread can enqueue SendCallAnswer/SendCallIce -- and a static Sender<Cmd> requires
// Cmd: Send. The raw pointers in the Send/GetAttachment variants are only ever dereferenced on the
// main/runtime thread (append_message etc.); the call-bridge variants carry only Send data. This
// unsafe impl formalises the thread movement that already happens.
unsafe impl Send for Cmd {}

#[derive(Debug, Clone)]
pub enum Recipient {
    Contact(presage::libsignal_service::prelude::Uuid),
    // An E.164 phone number (e.g. "+31611745571"); resolved to a contact UUID in the command loop.
    // Signal buddies are UUID-keyed, but a phone address reaches us from cross-service contact linking.
    ContactByPhone(String),
    Group(presage::libsignal_service::zkgroup::GroupMasterKeyBytes),
}
