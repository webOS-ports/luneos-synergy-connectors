extern "C" {
    // TODO: automatically generate declaration from presage.h
    fn presage_account_error(
        account: *mut crate::bridge_structs::PurpleAccount,
        reason: crate::bridge_structs::PurpleConnectionError,
        description: *const ::std::os::raw::c_char,
    );
}

unsafe fn send_cmd(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    cmd: crate::structs::Cmd,
) {
    if let Err(err) = send_cmd_impl(rt, tx, cmd) {
        let errmsg = std::ffi::CString::new(format!("send cmd error: {err}")).unwrap();
        presage_account_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_NETWORK_ERROR, errmsg.as_ptr());
    }
}

/*
 * Feeds a command into the channel c → rust.
 */
unsafe fn send_cmd_impl(
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    cmd: crate::structs::Cmd,
) -> Result<(), anyhow::Error> {
    let command_tx = tx.as_ref().ok_or(anyhow::anyhow!("send_cmd: command channel is missing"))?;
    let runtime = rt.as_ref().ok_or(anyhow::anyhow!("send_cmd: runtime is missing"))?;
    runtime.block_on(command_tx.send(cmd)).map_err(|err| anyhow::anyhow!(err.to_string()))
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_exit(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
) {
    let cmd = crate::structs::Cmd::Exit {};
    send_cmd(account, rt, tx, cmd);
    // we should be done with this connection instance, drop the box containing the sender
    drop(Box::from_raw(tx));
    // NOTE: the C part should mark their representation of the channel sender as "deleted", too
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_whoami(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
) {
    let cmd = crate::structs::Cmd::Whoami {};
    send_cmd(account, rt, tx, cmd);
}

/// Place an OUTGOING Signal call to `c_callee` (the dialer's address, i.e. the Signal UUID). The
/// command loop resolves the recipient + identity keys, has the call bridge generate our keypair,
/// and sends the RingRTC Offer. call.c invokes this from its LS2 `dial` handler.
#[no_mangle]
pub unsafe extern "C" fn presage_rust_place_call(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    c_callee: *const std::os::raw::c_char,
) {
    let callee = match std::ffi::CStr::from_ptr(c_callee).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return,
    };
    let cmd = crate::structs::Cmd::PlaceCall { callee };
    send_cmd(account, rt, tx, cmd);
}

/// The user tapped Answer on an incoming call: tell the media engine to emit the RingRTC rtp-data
/// `Accepted` so the caller connects (stops ringing + ungates audio). Local only, no callee needed.
#[no_mangle]
pub unsafe extern "C" fn presage_rust_accept_call(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    call_id: u64,
) {
    let cmd = crate::structs::Cmd::AcceptCall { call_id };
    send_cmd(account, rt, tx, cmd);
}

/// The user hung up: send the peer a Hangup for `call_id` and tear down our media engine. `c_callee`
/// is the peer's Signal UUID (the dialer's call address).
#[no_mangle]
pub unsafe extern "C" fn presage_rust_hangup_call(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    c_callee: *const std::os::raw::c_char,
    call_id: u64,
) {
    let callee = match std::ffi::CStr::from_ptr(c_callee).to_str() {
        Ok(s) => s.trim().to_string(),
        Err(_) => return,
    };
    // Pass the raw address through - it may be a UUID or (for an outgoing call reported under the dialed
    // number) an E.164. The command handler resolves it, so hangup works either way.
    let cmd = crate::structs::Cmd::HangupCall { callee, call_id };
    send_cmd(account, rt, tx, cmd);
}

// TODO: wire this up completely
#[no_mangle]
pub unsafe extern "C" fn presage_rust_list_groups(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
) {
    let cmd = crate::structs::Cmd::ListGroups {};
    send_cmd(account, rt, tx, cmd);
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_get_group_members(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    c_group: *const std::os::raw::c_char,
) {
    let master_key_bytes = parse_group_master_key(std::ffi::CStr::from_ptr(c_group).to_str().unwrap());
    match master_key_bytes {
        Ok(master_key_bytes) => {
            let cmd = crate::structs::Cmd::GetGroupMembers {
                master_key_bytes: master_key_bytes,
            };
            send_cmd(account, rt, tx, cmd);
        }
        Err(err) => {
            let c_errmsg = std::ffi::CString::new(err.to_string()).unwrap();
            presage_account_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR, c_errmsg.as_ptr());
        }
    }
}

// Classify a conversation destination string into a Recipient exactly like presage_rust_send: a
// 36-char dashed string is a contact UUID, a "+<digits>" string is an E.164 phone (resolved to a
// UUID in the command loop), anything else is a hex group master key. Shared by the send + reaction
// FFI entry points so both classify peers identically.
fn classify_recipient(destination: &str) -> Result<crate::structs::Recipient, anyhow::Error> {
    let d = destination.as_bytes();
    if d.len() == 36 && d[8] == b'-' && d[13] == b'-' && d[18] == b'-' && d[23] == b'-' {
        presage::libsignal_service::prelude::Uuid::parse_str(destination)
            .map(|uuid| crate::structs::Recipient::Contact(uuid))
            .map_err(|err| anyhow::anyhow!(err))
    } else if d.first() == Some(&b'+') && d.len() > 1 && d[1..].iter().all(|c| c.is_ascii_digit()) {
        Ok(crate::structs::Recipient::ContactByPhone(destination.to_owned()))
    } else {
        parse_group_master_key(destination).map(|master_key_bytes| crate::structs::Recipient::Group(master_key_bytes))
    }
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_send(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    c_destination: *const std::os::raw::c_char,
    c_message: *const std::os::raw::c_char,
    xfer: *const crate::bridge_structs::PurpleXfer,
    reply_to_ts: u64,
) {
    let destination = std::ffi::CStr::from_ptr(c_destination).to_str().unwrap();
    let recipient = classify_recipient(destination);
    match recipient {
        Ok(recipient) => {
            let cmd = crate::structs::Cmd::Send {
                recipient: recipient,
                message: if c_message != std::ptr::null() {
                    Some(std::ffi::CStr::from_ptr(c_message).to_str().unwrap().to_owned())
                } else {
                    None
                },
                xfer: xfer,
                // webOS replies: the reply target's serviceMessageId (sent timestamp, ms); 0 == none.
                reply_to_ts: reply_to_ts,
            };
            send_cmd(account, rt, tx, cmd);
        }
        Err(err) => {
            // Do NOT tear the whole Signal connection down over a single unparseable recipient
            // (this used to purple_error(OTHER_ERROR) -> disconnect on every send to an
            // unrecognized address). Just log it; the message simply is not sent.
            crate::bridge::purple_debug(
                account,
                crate::bridge_structs::PURPLE_DEBUG_ERROR,
                format!("Cannot send: unrecognized recipient \"{destination}\": {err}\n"),
            );
        }
    }
}

/// webOS reactions (SEND): transmit a reaction the user placed from the app. Called by
/// presage_send_reaction_cb (connection.c), which handles the "webos-im-send-reaction" signal. `c_peer`
/// is the conversation peer (contact UUID / E.164 / group hex), classified exactly like a send;
/// `target_ts` is the reacted-to message's sent timestamp; `c_emoji` is the (always supplied) emoji;
/// `remove` nonzero retracts the user's reaction.
#[no_mangle]
pub unsafe extern "C" fn presage_rust_send_reaction(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    c_peer: *const std::os::raw::c_char,
    target_ts: u64,
    c_emoji: *const std::os::raw::c_char,
    remove: std::os::raw::c_int,
) {
    let peer = match std::ffi::CStr::from_ptr(c_peer).to_str() {
        Ok(s) => s,
        Err(_) => return,
    };
    let emoji = if c_emoji.is_null() {
        String::new()
    } else {
        std::ffi::CStr::from_ptr(c_emoji).to_str().unwrap_or("").to_owned()
    };
    match classify_recipient(peer) {
        Ok(recipient) => {
            let cmd = crate::structs::Cmd::SendReaction {
                recipient,
                target_ts,
                emoji,
                remove: remove != 0,
            };
            send_cmd(account, rt, tx, cmd);
        }
        Err(err) => {
            crate::bridge::purple_debug(
                account,
                crate::bridge_structs::PURPLE_DEBUG_ERROR,
                format!("Cannot send reaction: unrecognized peer \"{peer}\": {err}\n"),
            );
        }
    }
}

/*
 * Taken from presage-cli
 */
fn parse_group_master_key(value: &str) -> Result<presage::libsignal_service::zkgroup::GroupMasterKeyBytes, anyhow::Error> {
    let master_key_bytes = hex::decode(value)?;
    presage::libsignal_service::zkgroup::GroupMasterKeyBytes::try_from(master_key_bytes).map_err(|vec| anyhow::anyhow!("Unable to convert group master key {vec:?}."))
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_get_profile(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    c_uuid: *const std::os::raw::c_char,
) {
    match presage::libsignal_service::prelude::Uuid::parse_str(std::ffi::CStr::from_ptr(c_uuid).to_str().unwrap()) {
        Ok(uuid) => {
            let cmd = crate::structs::Cmd::GetProfile { uuid };
            send_cmd(account, rt, tx, cmd);
        }
        Err(err) => {
            let c_errmsg = std::ffi::CString::new(err.to_string()).unwrap();
            presage_account_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR, c_errmsg.as_ptr());
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_get_attachment(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    tx: *mut tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    attachment_pointer_box: *mut presage::proto::AttachmentPointer,
    xfer: *const crate::bridge_structs::PurpleXfer,
) {
    let attachment_pointer = Box::from_raw(attachment_pointer_box);
    let cmd = crate::structs::Cmd::GetAttachment {
        attachment_pointer: *attachment_pointer,
        xfer: xfer,
    };
    send_cmd(account, rt, tx, cmd);
}

#[no_mangle]
pub unsafe extern "C" fn presage_rust_drop_attachment(attachment_pointer_box: *mut presage::proto::AttachmentPointer) {
    //print!("(xx:xx:xx) presage: presage_rust_drop_attachment({attachment_pointer_box:#?})…\n");
    drop(Box::from_raw(attachment_pointer_box));
}
