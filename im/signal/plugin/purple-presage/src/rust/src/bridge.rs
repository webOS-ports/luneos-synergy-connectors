/*
 * A rust representation of the C Message struct.
 *
 * The idea is that we have rust types for safety until the very moment we transfer the data to the C part.
 */
#[derive(Clone, Debug)]
pub struct Message {
    pub account: *mut crate::bridge_structs::PurpleAccount,
    pub tx_ptr: *const tokio::sync::mpsc::Sender<crate::structs::Cmd>,
    pub qrcode: Option<String>,
    pub uuid: Option<String>,
    pub debug: i32,
    pub error: i32,
    pub connected: i32,
    pub timestamp: Option<u64>,
    pub flags: crate::bridge_structs::PurpleMessageFlags,
    pub who: Option<String>,
    pub name: Option<String>,
    pub phone_number: Option<String>,
    pub group: Option<String>,
    pub body: Option<String>,
    pub attachment_pointer: Option<presage::proto::AttachmentPointer>,
    pub hash: Option<String>,
    pub filename: Option<String>,
    pub extension: Option<String>,
    pub mimetype: Option<String>,
    pub groups: Vec<crate::bridge::Group>,
    pub xfer: *const crate::bridge_structs::PurpleXfer,
    pub thread: Option<presage::store::Thread>,
}
#[derive(Clone, Debug)]
pub struct Group {
    pub key: String,
    pub title: String,
    pub description: String,
    pub revision: u32,
    pub members: Vec<String>,
}
// presage::model::groups::Group does not implement the clone trait, so we have this domain-specific variant
impl Group {
    pub fn from_group(
        key: [u8; 32],
        group: presage::model::groups::Group,
    ) -> Self {
        Self {
            key: hex::encode(key),
            title: group.title,
            description: group.description.unwrap_or_default(),
            revision: group.revision,
            members: group.members.into_iter().map(|member| member.aci.service_id_string()).collect(),
            // `avatar`, `disappearing_messages_timer`, `access_control`, `pending_members`, `requesting_members`, `invite_link_password`
        }
    }
}
impl Default for Message {
    fn default() -> Self {
        Message {
            thread: None,
            account: std::ptr::null_mut(),
            timestamp: None,
            flags: crate::bridge_structs::PurpleMessageFlags::default(),
            who: None,
            name: None,
            group: None,
            body: None,
            attachment_pointer: None,
            hash: None,
            filename: None,
            extension: None,
            mimetype: None,
            phone_number: None,
            error: -1,
            debug: -1,
            tx_ptr: std::ptr::null_mut(),
            connected: 0,
            uuid: None,
            groups: Vec::new(),
            qrcode: None,
            xfer: std::ptr::null_mut(),
        }
    }
}
impl Message {
    pub fn body(
        mut self,
        body: String,
    ) -> Self {
        self.body = Some(body);
        self
    }
    pub fn flags(
        mut self,
        flags: crate::bridge_structs::PurpleMessageFlags,
    ) -> Self {
        self.flags = flags;
        self
    }
}

extern "C" {
    // this is implemented by bridge.c
    fn presage_append_message(message: *const crate::bridge_structs::Message);

    // this is implemented by libpurple's ft.c
    // TODO: automatically generate declaration from ft.h
    fn purple_xfer_get_local_filename(xfer: *const crate::bridge_structs::PurpleXfer) -> *const std::os::raw::c_char;

    fn presage_blist_get_alias(
        account: *mut crate::bridge_structs::PurpleAccount,
        who: *const std::os::raw::c_char,
    ) -> *const std::os::raw::c_char;

    // implemented by call.c - push a Signal call state to the com.palm.signal.call LS2 service
    fn presage_handle_call_state(
        account: *mut crate::bridge_structs::PurpleAccount,
        who: *const std::os::raw::c_char,
        name: *const std::os::raw::c_char,
        state: u32,
        call_id: u64,
    );

    // implemented by receive_text.c - emit the cross-prpl "webos-im-reaction" signal.
    fn presage_emit_reaction(
        account: *mut crate::bridge_structs::PurpleAccount,
        target_id: *const std::os::raw::c_char,
        emoji: *const std::os::raw::c_char,
        sender: *const std::os::raw::c_char,
    );

    // implemented by receive_text.c - emit the cross-prpl "webos-im-outbox-id" signal, telling the
    // transport the server id (sent timestamp) of a message the user sent from the app.
    fn presage_emit_outbox_id(
        account: *mut crate::bridge_structs::PurpleAccount,
        service_message_id: *const std::os::raw::c_char,
        text: *const std::os::raw::c_char,
    );

    // implemented by receive_text.c - emit the cross-prpl "webos-im-receipt" signal telling the
    // transport the recipient delivered/read one of our outgoing messages. target_id is the message's
    // sent timestamp (its serviceMessageId); status is "delivered" or "read".
    fn presage_emit_receipt(
        account: *mut crate::bridge_structs::PurpleAccount,
        target_id: *const std::os::raw::c_char,
        status: *const std::os::raw::c_char,
    );
}

// Signal call states pushed to the Phone app's com.palm.signal.call service (must match call.c).
pub const CALL_STATE_INCOMING: u32 = 0;
pub const CALL_STATE_ENDED: u32 = 1; // remote hung up / call ended
pub const CALL_STATE_DECLINED: u32 = 2;
pub const CALL_STATE_BUSY: u32 = 3;
pub const CALL_STATE_ACTIVE: u32 = 4; // peer answered OUR outgoing call -> connected
pub const CALL_STATE_DIALING: u32 = 5; // we placed an outgoing call (Offer sent) -> ringing peer

// Forward an incoming Signal CallMessage to the stock Phone app (ring / clear). Signaling only:
// there is no media yet, so this is presence of a call, not a connected call.
pub fn handle_call_state(
    account: *const crate::bridge_structs::PurpleAccount,
    who: Option<String>,
    name: Option<String>,
    state: u32,
    call_id: u64,
) {
    let who = who.and_then(|s| std::ffi::CString::new(s).ok());
    let name = name.and_then(|s| std::ffi::CString::new(s).ok());
    let who_p = who.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
    let name_p = name.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
    unsafe {
        presage_handle_call_state(account as *mut crate::bridge_structs::PurpleAccount, who_p, name_p, state, call_id);
    }
}

// webOS reactions: forward a Signal reaction to the transport via the "webos-im-reaction" signal.
// target_id is the reacted-to message's sent timestamp (its serviceMessageId); sender is the reactor's
// UUID; an empty emoji ("") means the reaction was removed.
pub fn emit_reaction(
    account: *const crate::bridge_structs::PurpleAccount,
    target_id: String,
    emoji: String,
    sender: String,
) {
    let target = std::ffi::CString::new(target_id).unwrap_or_default();
    let emoji = std::ffi::CString::new(emoji).unwrap_or_default();
    let sender = std::ffi::CString::new(sender).unwrap_or_default();
    unsafe {
        presage_emit_reaction(
            account as *mut crate::bridge_structs::PurpleAccount,
            target.as_ptr(),
            emoji.as_ptr(),
            sender.as_ptr(),
        );
    }
}

// webOS reactions: tell the transport the server id of a message the user sent from the app, via the
// "webos-im-outbox-id" signal. service_message_id is the message's sent timestamp (its serviceMessageId,
// in ms, decimal); text is the sent body (used by the transport only as a correlation hint). The C side
// hops to the libpurple main thread before emitting.
pub fn emit_outbox_id(
    account: *const crate::bridge_structs::PurpleAccount,
    service_message_id: String,
    text: String,
) {
    let id = std::ffi::CString::new(service_message_id).unwrap_or_default();
    let text = std::ffi::CString::new(text).unwrap_or_default();
    unsafe {
        presage_emit_outbox_id(
            account as *mut crate::bridge_structs::PurpleAccount,
            id.as_ptr(),
            text.as_ptr(),
        );
    }
}

// webOS delivery/read receipts: tell the transport the recipient delivered/read one of our outgoing
// messages, via the "webos-im-receipt" signal. target_id is the message's sent timestamp (its
// serviceMessageId, ms decimal); status is "delivered" or "read". The C side hops to the libpurple
// main thread before emitting.
pub fn emit_receipt(
    account: *const crate::bridge_structs::PurpleAccount,
    target_id: String,
    status: String,
) {
    let target = std::ffi::CString::new(target_id).unwrap_or_default();
    let status = std::ffi::CString::new(status).unwrap_or_default();
    unsafe {
        presage_emit_receipt(
            account as *mut crate::bridge_structs::PurpleAccount,
            target.as_ptr(),
            status.as_ptr(),
        );
    }
}

// I want to forward a Vec of groups to the C part, but the rust-allocated C-compatible CStrings must live somewhere, so we have this intermediate type
struct CGroup {
    key: Option<std::ffi::CString>,
    title: Option<std::ffi::CString>,
    description: Option<std::ffi::CString>,
    c_members: Vec<*const std::os::raw::c_char>,
    members: Vec<std::ffi::CString>,
}

pub fn append_message(message: Message) {
    //print!("(xx:xx:xx) presage: append_message {message:#?}\n");
    let to_cstring = |s: Option<String>| -> Option<std::ffi::CString> { s.map_or(None, |s| std::ffi::CString::new(s).ok()) };
    let get_cstring_ptr = |s: &Option<std::ffi::CString>| {
        if let Some(ss) = s {
            return ss.as_ptr();
        }
        return std::ptr::null();
    };

    // let the CStrings live here
    let qrcode = to_cstring(message.qrcode);
    let uuid = to_cstring(message.uuid);
    let who = to_cstring(message.who);
    let name = to_cstring(message.name);
    let phone_number = to_cstring(message.phone_number);
    let group = to_cstring(message.group);
    let body = to_cstring(message.body);
    let attachment_size = message.attachment_pointer.as_ref().map_or(0, |a| a.size());
    let hash = to_cstring(message.hash);
    let filename = to_cstring(message.filename);
    let extension = to_cstring(message.extension);
    let mimetype = to_cstring(message.mimetype);
    let groups_length = message.groups.len();
    // create a CString for every field for every CGroup
    let groups: Vec<CGroup> = message
        .groups
        .iter()
        .map(|g| {
            let mut c_group = CGroup {
                key: std::ffi::CString::new(g.key.clone()).ok(),
                title: std::ffi::CString::new(g.title.clone()).ok(),
                description: std::ffi::CString::new(g.description.clone()).ok(),
                members: g.members.iter().map(|m| std::ffi::CString::new(m.clone()).unwrap()).collect(),
                c_members: [].to_vec(),
            };
            // hava a C-compatible pointer to the vector of members
            c_group.c_members = c_group.members.iter().map(|cm| cm.as_ptr()).collect();
            c_group
        })
        .collect();
    // hava a C-compatible pointer to the vector of groups
    let c_groups: Vec<crate::bridge_structs::Group> = groups
        .iter()
        .zip(message.groups)
        .map(|(cg, rg)| crate::bridge_structs::Group {
            key: get_cstring_ptr(&cg.key),
            title: get_cstring_ptr(&cg.title),
            description: get_cstring_ptr(&cg.description),
            revision: rg.revision,
            members: cg.c_members.as_ptr(),
            population: cg.c_members.len(),
        })
        .collect();

    // wrap all data into one struct
    let c_message = crate::bridge_structs::Message {
        account: message.account,
        tx_ptr: message.tx_ptr as crate::bridge_structs::RustChannelPtr,
        qrcode: get_cstring_ptr(&qrcode),
        uuid: get_cstring_ptr(&uuid),
        debug: message.debug,
        error: message.error,
        connected: message.connected,
        attachment_pointer_box: message.attachment_pointer.map_or(std::ptr::null(), |a| Box::into_raw(Box::new(a)) as *const std::os::raw::c_void),
        hash: get_cstring_ptr(&hash),
        filename: get_cstring_ptr(&filename),
        extension: get_cstring_ptr(&extension),
        mimetype: get_cstring_ptr(&mimetype),
        timestamp: message.timestamp.unwrap_or(0),
        flags: message.flags,
        who: get_cstring_ptr(&who),
        name: get_cstring_ptr(&name),
        phone_number: get_cstring_ptr(&phone_number),
        group: get_cstring_ptr(&group),
        body: get_cstring_ptr(&body),
        attachment_size: attachment_size,
        groups: c_groups.as_ptr(),
        groups_length: groups_length,
        xfer: message.xfer,
    };
    //print!("(xx:xx:xx) presage: c_message.groups is at {0:p}\n", c_message.groups);
    unsafe {
        presage_append_message(&c_message);
    }
}

// convenience function for calling purple_error on the main thread
pub fn purple_error(
    account: *mut crate::bridge_structs::PurpleAccount,
    level: crate::bridge_structs::PurpleConnectionError,
    msg: String,
) {
    append_message(Message {
        account: account,
        error: level,
        body: Some(msg),
        ..Default::default()
    });
}

// convenience function for calling purple_debug on the main thread
pub fn purple_debug(
    account: *mut crate::bridge_structs::PurpleAccount,
    level: crate::bridge_structs::PurpleDebugLevel,
    msg: String,
) {
    append_message(Message {
        account: account,
        debug: level,
        body: Some(msg),
        ..Default::default()
    });
}

// wrapper around unsafe purple_xfer_get_local_filename
pub fn xfer_get_local_filename(xfer: *const crate::bridge_structs::PurpleXfer) -> String {
    unsafe {
        return std::ffi::CStr::from_ptr(purple_xfer_get_local_filename(xfer)).to_str().unwrap().to_owned();
    }
}

// wrapper around unsafe presage_blist_get_alias
// In case there is no alias, the origial UUID is passed thorugh
pub fn blist_get_alias(
    account: *mut crate::bridge_structs::PurpleAccount,
    uuid: String,
) -> String {
    let c_uuid = std::ffi::CString::new(uuid.clone()).expect("String → CString conversion failed on a UUID. How did you manage that?");
    unsafe {
        let c_alias = presage_blist_get_alias(account, c_uuid.as_ptr());
        if !c_alias.is_null() {
            if let Ok(alias) = std::ffi::CStr::from_ptr(c_alias).to_str() {
                return alias.to_owned();
            }
        }
    }
    return uuid;
}

/*
 * This library has no main function to annotate with `#[tokio::main]`, but needs a run-time.
 * This function creates a tokio runtime and boxes it so the runtime can live in the front-end.
 *
 * The approach is described at https://tokio.rs/tokio/topics/bridging.
 * https://stackoverflow.com/questions/66196972/ and https://stackoverflow.com/questions/64658556/ are helpful.
 */
#[no_mangle]
pub extern "C" fn presage_rust_init() -> *mut tokio::runtime::Runtime {
    // route debug information handled by the tracing crate to purple's debug functions
    tracing_subscriber::util::SubscriberInitExt::init(tracing_subscriber::layer::SubscriberExt::with(tracing_subscriber::registry(), crate::debug::PurpleDebugLayer));
    // NOTE: a stack size of 25 MB has proven to be insufficient in March 2026
    let runtime = tokio::runtime::Builder::new_multi_thread().thread_name("presage Tokio").thread_stack_size(32 * 1024 * 1024).worker_threads(2).enable_all().build().unwrap();
    let runtime_box = Box::new(runtime);
    Box::into_raw(runtime_box)
}

#[no_mangle]
pub extern "C" fn presage_rust_destroy(runtime: *mut tokio::runtime::Runtime) {
    unsafe {
        drop(Box::from_raw(runtime));
    }
}

/*
 * Around the core's main function.
 *
 * This blocks until the rust main function finishes.
 */
#[no_mangle]
pub unsafe extern "C" fn presage_rust_main(
    account: *mut crate::bridge_structs::PurpleAccount,
    rt: *mut tokio::runtime::Runtime,
    c_store_path: *const std::os::raw::c_char,
) {
    let store_path = std::ffi::CStr::from_ptr(c_store_path).to_str().unwrap().to_owned();

    // create a channel for asynchronous communication of commands c → rust
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    // give the call media bridge a clone so its per-call reader thread can enqueue outgoing
    // CallMessage Answer/IceUpdate for the command loop (which owns the Manager) to send.
    crate::call_bridge::set_command_sender(tx.clone());
    // put the sender into a box so it can live in the C part
    let tx_box = Box::new(tx);
    append_message(Message {
        account: account,
        tx_ptr: Box::into_raw(tx_box) as *const tokio::sync::mpsc::Sender<crate::structs::Cmd>,
        ..Default::default()
    }); // let front-end know how to reach us

    // now execute the actual program
    let runtime = rt.as_ref().unwrap();
    runtime.block_on(crate::core::main(store_path, None, rx, account));
    purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, String::from("rust runtime finishes now…\n"));
}
