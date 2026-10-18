// Resolve an E.164 phone number ("+31611745571") to a stored contact's UUID, so a phone-addressed
// Signal send (which reaches us via cross-service contact linking) can be delivered. None if no
// stored contact carries that number.
async fn resolve_phone_to_uuid<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    phone: &str,
) -> Option<presage::libsignal_service::prelude::Uuid> {
    match manager.store().contacts().await {
        Ok(contacts) => {
            for contact in contacts.flatten() {
                if let Some(pn) = &contact.phone_number {
                    if pn.to_string() == phone {
                        return Some(contact.uuid);
                    }
                }
            }
            None
        }
        Err(_) => None,
    }
}

// Resolve an E.164 phone number to an ACI via Signal's Contact Discovery Service (a server lookup),
// so a NON-contact number typed in the dialer can still be called - unlike resolve_phone_to_uuid,
// which only knows already-stored contacts. Returns the ACI uuid, or None if the number isn't
// registered on Signal (or discovery fails / only a PNI is returned, which can't key a call).
async fn discover_uuid_by_phone<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    phone: &str,
) -> Option<presage::libsignal_service::prelude::Uuid> {
    use presage::libsignal_service::protocol::ServiceId;
    match manager.discover_contacts_by_phone_number([phone]).await {
        Ok(results) => {
            for (_pn, service_id) in results {
                if let Some(ServiceId::Aci(aci)) = service_id {
                    return Some(aci.into());
                }
            }
            None
        }
        Err(_) => None,
    }
}

/*
 * Runs a command.
 *
 * Based on presage-cli's `run`.
 */
async fn run<C: presage::store::Store + 'static>(
    subcommand: crate::structs::Cmd,
    mut manager: presage::Manager<C, presage::manager::Registered>,
    account: *mut crate::bridge_structs::PurpleAccount,
) -> Result<bool, presage::Error<<C>::Error>> {
    match subcommand {
        crate::structs::Cmd::Whoami => {
            let whoami = manager.whoami().await?;
            let uuid = whoami.aci.to_string(); // TODO: check alternatives to aci
            crate::bridge::append_message(crate::bridge::Message {
                account: account,
                uuid: Some(uuid.to_string()),
                ..Default::default()
            });
            Ok(true)
        }
        crate::structs::Cmd::Send {
            recipient,
            message,
            xfer,
            reply_to_ts,
        } => {
            // Resolve a phone-number recipient to the contact's UUID (see resolve_phone_to_uuid). If
            // there is no matching Signal contact, report it in the conversation and keep the loop
            // running -- never disconnect over one unsendable message.
            let recipient = match recipient {
                crate::structs::Recipient::ContactByPhone(phone) => {
                    match resolve_phone_to_uuid(&mut manager, &phone).await {
                        Some(uuid) => crate::structs::Recipient::Contact(uuid),
                        None => {
                            crate::bridge::append_message(crate::bridge::Message {
                                account: account,
                                who: Some(phone.clone()),
                                flags: crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_ERROR,
                                body: Some(format!("Error: no Signal contact found for {phone}")),
                                timestamp: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64),
                                ..Default::default()
                            });
                            return Ok(true);
                        }
                    }
                }
                other => other,
            };
            // prepare a PurplePresage message for providing feed-back (send success or error)
            let mut msg = crate::bridge::Message {
                account: account,
                timestamp: Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64),
                xfer: xfer, // in case of attachments, this is the reference to the respective purple Xfer
                ..Default::default()
            };
            match recipient {
                crate::structs::Recipient::Contact(uuid) => {
                    msg.who = Some(uuid.to_string());
                }
                crate::structs::Recipient::ContactByPhone(_) => {} // resolved to Contact above; unreachable
                crate::structs::Recipient::Group(master_key) => {
                    msg.group = Some(hex::encode(master_key));
                }
            }
            // now do the actual sending and error-handling
            match crate::send::send(&mut manager, recipient, message.clone(), xfer, reply_to_ts).await {
                Ok(sent_ts) => {
                    // NOTE: for Spectrum, send-acknowledgements should be PURPLE_MESSAGE_SEND only (without PURPLE_MESSAGE_REMOTE_SEND)
                    msg.flags = crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_SEND;
                    if let Some(body) = message {
                        msg.body = Some(body);
                    }
                    // webOS reactions: surface the server id (the sent timestamp, in ms) of this
                    // app-composed message so the transport (OutboxIdHandler) can label the Outbox row
                    // -> a later reaction can target the user's own message by its serviceMessageId.
                    crate::bridge::emit_outbox_id(account, sent_ts.to_string(), msg.body.clone().unwrap_or_default());
                }
                Err(err) => {
                    // TODO: remove this purple_debug once handling errors is reasonably well tested
                    crate::bridge::purple_debug(
                        account,
                        crate::bridge_structs::PURPLE_DEBUG_ERROR,
                        format!("Error „{err}“ occurred while sending a message. The error message should appear in the conversation window.\n"),
                    );
                    msg.flags = crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_ERROR;
                    msg.body = Some(format!("Error: {err}"));
                }
            }
            // feed the feed-back back into purple
            crate::bridge::append_message(msg);
            Ok(true)
        }
        crate::structs::Cmd::SendReaction {
            recipient,
            target_ts,
            emoji,
            remove,
        } => {
            // Resolve a phone-number recipient to the contact's UUID (same policy as Cmd::Send: never
            // disconnect over one unsendable reaction).
            let recipient = match recipient {
                crate::structs::Recipient::ContactByPhone(phone) => match resolve_phone_to_uuid(&mut manager, &phone).await {
                    Some(uuid) => crate::structs::Recipient::Contact(uuid),
                    None => {
                        crate::bridge::purple_debug(
                            account,
                            crate::bridge_structs::PURPLE_DEBUG_ERROR,
                            format!("Cannot send reaction: no Signal contact found for {phone}\n"),
                        );
                        return Ok(true);
                    }
                },
                other => other,
            };
            match crate::send::send_reaction(&mut manager, recipient, target_ts, emoji, remove).await {
                Ok(_) => crate::bridge::purple_debug(
                    account,
                    crate::bridge_structs::PURPLE_DEBUG_INFO,
                    format!("sent reaction targeting {target_ts}\n"),
                ),
                Err(err) => crate::bridge::purple_debug(
                    account,
                    crate::bridge_structs::PURPLE_DEBUG_ERROR,
                    format!("Error sending reaction targeting {target_ts}: {err}\n"),
                ),
            }
            Ok(true)
        }
        crate::structs::Cmd::ListGroups => {
            crate::contacts::forward_groups(account, &mut manager).await;
            Ok(true)
        }
        crate::structs::Cmd::GetGroupMembers { master_key_bytes } => {
            crate::contacts::get_group_members(account, manager, master_key_bytes).await?;
            Ok(true)
        }
        crate::structs::Cmd::GetProfile { uuid } => {
            match crate::contacts::get_profile(account, &mut manager, uuid).await {
                Ok(contact) => {
                    let name = if contact.name.is_empty() { None } else { Some(contact.name) };
                    let phone_number = contact.phone_number.map(|pn| pn.to_string());
                    crate::bridge::append_message(crate::bridge::Message {
                        account: account,
                        who: Some(contact.uuid.to_string()),
                        name: name,
                        phone_number: phone_number,
                        ..Default::default()
                    });
                }
                Err(err) => crate::bridge::append_message(crate::bridge::Message {
                    account: account,
                    who: Some(uuid.to_string()),
                    error: 1,
                    body: Some(err.to_string()),
                    ..Default::default()
                }),
            }
            Ok(true)
        }
        crate::structs::Cmd::GetAttachment {
            attachment_pointer,
            xfer,
        } => {
            crate::attachment::get_attachment(account, manager, attachment_pointer, xfer).await;
            Ok(true)
        }
        crate::structs::Cmd::SendCallAnswer { uuid, call_id, opaque } => {
            let cm = presage::proto::CallMessage {
                answer: Some(presage::proto::call_message::Answer {
                    id: Some(call_id),
                    opaque: Some(opaque),
                }),
                ..Default::default()
            };
            send_call_message(&mut manager, account, uuid, cm, "Answer").await;
            Ok(true)
        }
        crate::structs::Cmd::SendCallIce { uuid, call_id, opaque } => {
            eprintln!("call_bridge: [DIAG] command_loop got SendCallIce call_id={call_id} to={uuid} opaque_len={}", opaque.len());
            let cm = presage::proto::CallMessage {
                ice_update: vec![presage::proto::call_message::IceUpdate {
                    id: Some(call_id),
                    opaque: Some(opaque),
                }],
                ..Default::default()
            };
            send_call_message(&mut manager, account, uuid, cm, "IceUpdate").await;
            Ok(true)
        }
        crate::structs::Cmd::HangupCall { callee, call_id } => {
            // Resolve the address to a UUID (it's the dialer-card address: a UUID for incoming, or the
            // dialed E.164 for an outgoing call). Same resolution order as place_call.
            let uuid = match presage::libsignal_service::prelude::Uuid::parse_str(&callee) {
                Ok(u) => Some(u),
                Err(_) => match resolve_phone_to_uuid(&mut manager, &callee).await {
                    Some(u) => Some(u),
                    None => discover_uuid_by_phone(&mut manager, &callee).await,
                },
            };
            // Tell the peer the call is over (so their phone stops ringing / hangs up) ...
            if let Some(uuid) = uuid {
                let cm = presage::proto::CallMessage {
                    hangup: Some(presage::proto::call_message::Hangup {
                        id: Some(call_id),
                        r#type: Some(0), // HANGUP_NORMAL
                        device_id: Some(1),
                    }),
                    ..Default::default()
                };
                send_call_message(&mut manager, account, uuid, cm, "Hangup").await;
            }
            // ... and tear down our local media engine (always, even if the address didn't resolve).
            crate::call_bridge::stop(call_id);
            Ok(true)
        }
        crate::structs::Cmd::AcceptCall { call_id } => {
            // Local only: tell the engine to emit the RingRTC rtp-data `Accepted`. No network send.
            crate::call_bridge::accept(call_id);
            Ok(true)
        }
        crate::structs::Cmd::PlaceCall { callee } => {
            // Resolve the callee to an ACI. The dialer usually passes the Signal UUID, but for a
            // cross-service-linked contact (Alan's Signal thread keyed by his phone number) it passes an
            // E.164 number. If it isn't a UUID, look it up like the phone-addressed send path does.
            let callee_str = callee.trim().to_string();
            eprintln!("call_bridge: place_call dialed='{callee_str}' (resolving to Signal UUID...)");
            let uuid = match presage::libsignal_service::prelude::Uuid::parse_str(&callee_str) {
                Ok(u) => u,
                Err(_) => {
                    // Not a UUID: the dialer passed a phone number (a cross-service-linked contact, or a
                    // bare dialpad number for someone not in Contacts). Try a stored contact first (cheap,
                    // offline), then fall back to a Signal CDS lookup so a NON-contact number still
                    // resolves to an ACI - mirrors the Telegram searchUserByPhoneNumber path.
                    let resolved = match resolve_phone_to_uuid(&mut manager, &callee_str).await {
                        Some(u) => Some(u),
                        None => discover_uuid_by_phone(&mut manager, &callee_str).await,
                    };
                    match resolved {
                        Some(u) => u,
                        None => {
                            crate::bridge::purple_debug(
                                account,
                                crate::bridge_structs::PURPLE_DEBUG_ERROR,
                                format!("call bridge: place_call: '{callee_str}' is not on Signal (no UUID, no stored contact, no CDS match)\n"),
                            );
                            // Fail cleanly: clear the dialer's "Connecting" card instead of hanging.
                            crate::bridge::handle_call_state(
                                account,
                                Some(callee_str.clone()),
                                None,
                                crate::bridge::CALL_STATE_ENDED,
                                0,
                            );
                            return Ok(true);
                        }
                    }
                }
            };
            // Identity keys bound into the SRTP KDF: caller_id = OURS (we are the caller),
            // callee_id = the peer's (empty if we have no session yet -> signaling/ICE still work,
            // audio needs the ids; same known-unknown as the incoming path).
            use presage::libsignal_service::protocol::{DeviceId, IdentityKeyStore, ProtocolAddress};
            let aci_store = manager.store().aci_protocol_store();
            let caller_id: Vec<u8> = aci_store
                .get_identity_key_pair()
                .await
                .ok()
                .map(|kp| kp.identity_key().serialize()[1..].to_vec())
                .unwrap_or_default();
            let callee_id: Vec<u8> = match DeviceId::try_from(1u32) {
                Ok(dev) => {
                    let addr = ProtocolAddress::new(uuid.to_string(), dev);
                    aci_store
                        .get_identity(&addr)
                        .await
                        .ok()
                        .flatten()
                        .map(|ik| ik.serialize()[1..].to_vec())
                        .unwrap_or_default()
                }
                Err(_) => Vec::new(),
            };
            // Fetch Signal's STUN/TURN relays now so they're stashed before the engine spawns when
            // the peer answers (on_answer). Without them ICE gathers host-only candidates -> no NAT
            // traversal -> the call hangs on "Connecting".
            let ice = crate::ice::fetch_ice_servers(&manager).await;
            crate::call_bridge::set_ice_servers(ice);
            eprintln!("call_bridge: place_call resolved dialed='{callee_str}' -> UUID {uuid} ; sending Offer");
            if let Some((call_id, opaque)) = crate::call_bridge::place_call(uuid, caller_id, callee_id) {
                let cm = presage::proto::CallMessage {
                    offer: Some(presage::proto::call_message::Offer {
                        id: Some(call_id),
                        r#type: Some(presage::proto::call_message::offer::Type::OfferAudioCall as i32),
                        opaque: Some(opaque),
                        ..Default::default()
                    }),
                    ..Default::default()
                };
                send_call_message(&mut manager, account, uuid, cm, "Offer").await;
                // Drive the dialer with the REAL call_id (matching the Answer/Hangup that follow) AND
                // the DIALED address, not the resolved UUID: the dialer's pending "Connecting" card is
                // keyed on what the user dialed (e.g. "+31621489831"), so reporting the UUID here makes
                // it show a SECOND card for a number it never dialed. Stash the dialed address so the
                // later active/ended pushes (receive.rs) stay consistent. Mirrors Telegram's
                // getCallDialedAddress. blist_get_alias resolves the name off the UUID (correct person).
                crate::call_bridge::set_dialed_address(call_id, callee_str.clone());
                let name = crate::bridge::blist_get_alias(account, uuid.to_string());
                crate::bridge::handle_call_state(
                    account,
                    Some(callee_str.clone()),
                    Some(name),
                    crate::bridge::CALL_STATE_DIALING,
                    call_id,
                );
            }
            Ok(true)
        }
        crate::structs::Cmd::Exit {} => Ok(false),
    }
}

/// Send a RingRTC CallMessage (Answer / IceUpdate) to `uuid`. Errors are logged, never fatal -- a
/// dropped signaling message must not tear down the Signal connection (same policy as command_loop).
async fn send_call_message<C: presage::store::Store + 'static>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    account: *mut crate::bridge_structs::PurpleAccount,
    uuid: presage::libsignal_service::prelude::Uuid,
    call_message: presage::proto::CallMessage,
    kind: &str,
) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    match manager
        .send_message(
            presage::libsignal_service::protocol::ServiceId::Aci(uuid.into()),
            presage::libsignal_service::content::ContentBody::CallMessage(call_message),
            timestamp,
        )
        .await
    {
        Ok(_) => {
            eprintln!("call_bridge: [DIAG] send_call_message OK kind={kind} to={uuid}");
            crate::bridge::purple_debug(
                account,
                crate::bridge_structs::PURPLE_DEBUG_INFO,
                format!("call bridge: sent {kind} to {uuid}\n"),
            )
        }
        Err(err) => {
            eprintln!("call_bridge: [DIAG] send_call_message FAILED kind={kind} to={uuid}: {err}");
            crate::bridge::purple_debug(
                account,
                crate::bridge_structs::PURPLE_DEBUG_ERROR,
                format!("call bridge: failed to send {kind} to {uuid}: {err}\n"),
            )
        }
    }
}

/*
 * Retrieves commands from the command channel and delegates work to `run`, but catches the errors for forwarding to the front-end.
 *
 * Based on presage-cli's main loop.
 */
pub async fn command_loop<C: presage::store::Store + 'static>(
    manager: presage::Manager<C, presage::manager::Registered>,
    mut command_receiver: tokio::sync::mpsc::Receiver<crate::structs::Cmd>,
    account: *mut crate::bridge_structs::PurpleAccount,
) {
    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("mainloop begins…\n"));
    let mut keep_running = true;
    while keep_running {
        match command_receiver.recv().await {
            Some(cmd) => match run(cmd, manager.clone(), account).await {
                Ok(keep_running_commands) => {
                    keep_running = keep_running_commands;
                }
                Err(err) => {
                    // Do NOT tear the whole account down for a single failed command. This branch
                    // used to call purple_error(OTHER_ERROR), which the webOS transport turns into a
                    // full connection failure -> Signal disconnected on basically every send (the
                    // sent message's sync echo, a profile/group lookup, or any transient "Invalid…"
                    // surfaced here). Log it and keep the mainloop running; genuine connection loss
                    // is handled by the receive loop (receive_messages retry / stream-ended reconnect).
                    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_ERROR, format!("command error (connection kept alive): {err:?}\n"));
                }
            },
            None => {
                // this should never happen
                crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_NETWORK_ERROR, format!("Command channel disrupted."));
                keep_running = false;
            }
        }
    }
}

pub async fn login(
    config_store: presage_store_sqlite::SqliteStore,
    account: *mut crate::bridge_structs::PurpleAccount,
) -> Option<presage::Manager<presage_store_sqlite::SqliteStore, presage::manager::Registered>> {
    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("login begins…\n"));
    match presage::Manager::load_registered(config_store.clone()).await {
        Ok(manager) => {
            crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("account information was loaded\n"));
            match manager.whoami().await {
                Ok(whoami) => {
                    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("Linked to account: {whoami:?}.\n"));
                    return Some(manager);
                }
                Err(err) => {
                    // so far, err usually is ServiceError(WsError(Handshake(UnexpectedStatusCode(403))))
                    // happens when main device removed our linked device
                    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("Unable to confirm log-in due to {err:?}.\n"));
                    return link(config_store, account).await;
                }
            }
        }
        Err(presage::Error::NotYetRegisteredError) => {
            // happens on pristine set-ups
            // can happen during whoami
            return link(config_store, account).await;
        }
        Err(presage::Error::ServiceError(err)) => {
            // can happen during load_registered after main device has revoked the link
            // NOTE: possibly also happens during execution of commands like whoami or send, possibly others
            match err {
                presage::libsignal_service::push_service::ServiceError::Unauthorized => {
                    return link(config_store, account).await;
                }
                // Handle specific HTTP timeout error – by ChatGPT
                presage::libsignal_service::push_service::ServiceError::Http(ref http_err) => {
                    // Check if the error is a timeout
                    // generated by ChatGPT
                    if let Some(source) = std::error::Error::source(&http_err) {
                        // Try to downcast to std::io::Error and detect ErrorKind::TimedOut
                        if source.downcast_ref::<std::io::Error>().map_or(false, |io_err| io_err.kind() == std::io::ErrorKind::TimedOut) {
                            crate::bridge::purple_error(
                                account,
                                crate::bridge_structs::PURPLE_CONNECTION_ERROR_NETWORK_ERROR,
                                format!("Network timeout while logging in: {http_err:?}"),
                            );
                            return None;
                        }
                        // Try to downcast to std::io::Error and detect ErrorKind::TimedOut in reqwest::Error
                        let is_connect_error = source
                            .downcast_ref::<reqwest::Error>()
                            .and_then(|e| std::error::Error::source(e))
                            .and_then(|s| s.downcast_ref::<hyper_util::client::legacy::Error>())
                            .and_then(|e| std::error::Error::source(e))
                            .and_then(|s| s.downcast_ref::<std::io::Error>())
                            .is_some_and(|io| io.kind() == std::io::ErrorKind::TimedOut);
                        if is_connect_error {
                            crate::bridge::purple_error(
                                account,
                                crate::bridge_structs::PURPLE_CONNECTION_ERROR_NETWORK_ERROR,
                                format!("Client timed out while logging in: {http_err:?}"),
                            );
                            return None;
                        }
                    }
                    // Fallback for other HTTP errors
                    crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR, format!("login ServiceError {http_err:?}"));
                }
                // presage::libsignal_service::prelude::ServiceError::UnhandledResponseCode { http_code } => {
                //     if http_code == 499 {
                //         // this can happen on invalid/damaged/obsolete login information
                //     }
                // }
                _ => {
                    crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR, format!("login ServiceError {err:?}"));
                }
            }
        }
        Err(err) => {
            crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR, format!("login error {err:?}"));
        }
    }
    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("login failed.\n"));
    None
}

async fn link(
    config_store: presage_store_sqlite::SqliteStore,
    account: *mut crate::bridge_structs::PurpleAccount,
) -> Option<presage::Manager<presage_store_sqlite::SqliteStore, presage::manager::Registered>> {
    let device_name = "purple-presage".to_string(); // TODO: use hostname or make user-configurable
    let server = presage::libsignal_service::configuration::SignalServers::Production;
    let (provisioning_link_tx, provisioning_link_rx) = futures::channel::oneshot::channel();
    let join_handle = futures::future::join(presage::Manager::link_secondary_device(config_store, server, device_name, provisioning_link_tx), async move {
        match provisioning_link_rx.await {
            Ok(url) => {
                crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, String::from("got URL for QR code\n"));
                crate::bridge::append_message(crate::bridge::Message {
                    account: account,
                    qrcode: Some(url.to_string()),
                    ..Default::default()
                });
            }
            Err(err) => {
                crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_AUTHENTICATION_FAILED, format!("Error linking device: {err:?}"));
            }
        }
    })
    .await;
    let (manager, _) = join_handle;

    match manager {
        Ok(mut manager) => {
            let whoami = manager.whoami().await; // this seems to be necessary for the manager to finish the linking process
            match whoami {
                Ok(whoami) => {
                    let uuid = whoami.aci.to_string(); // TODO: check if there are alternatives to aci
                    crate::bridge::append_message(crate::bridge::Message {
                        account: account,
                        uuid: Some(uuid),
                        ..Default::default()
                    });

                    // request contacts now after linking once.
                    // TODO: check whether requesting contacts again (on a subsequent log-in) still sometimes blocks forever.
                    if let Err(err) = manager.request_contacts().await {
                        crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("Error while requesting contacts: {err:?}\n"));
                    }

                    return Some(manager);
                }
                Err(err) => {
                    crate::bridge::purple_error(
                        account,
                        crate::bridge_structs::PURPLE_CONNECTION_ERROR_AUTHENTICATION_FAILED,
                        format!("Error checking identity: {err:?}"),
                    );
                }
            }
        }
        Err(err) => {
            crate::bridge::purple_error(
                account,
                crate::bridge_structs::PURPLE_CONNECTION_ERROR_AUTHENTICATION_FAILED,
                format!("Error after linking device: {err:?}"),
            );
        }
    }
    return None;
}

/*
 * Opens the stream of incoming messages and receives them one by one.
 *
 * Based on presage-cli's receive.
 */
async fn receive<S: presage::store::Store + Clone + 'static>(
    mut manager: presage::Manager<S, presage::manager::Registered>,
    account: *mut crate::bridge_structs::PurpleAccount,
) {
    // webOS: the receive stream ends spuriously (network hiccups) and, on a freshly-linked device,
    // often before Received::QueueEmpty — so `connected:1` (receive.rs) is never sent and the account
    // never reaches "online". The upstream code's own comment says "re-connecting is a good idea", but
    // it forwarded a fatal network error instead, which libpurple/the transport turned into a hard
    // login failure (account stuck "signing in" then offline). Loop and re-open the stream on end;
    // only give up after several *consecutive* hard errors (which usually means the main device
    // unlinked us). Once catching-up finishes, handle_received() marks the account connected.
    // Prefetch Signal's ICE/TURN relays now (right after login) and cache them, so an INCOMING call's
    // start_incoming does NOT block this single receive loop on a network fetch. That per-call fetch
    // delayed the answerer's engine spawn ~2s, so our Answer + our responses to the caller's early ICE
    // connectivity checks were late and the answerer's ICE failed (the caller path fetches before it
    // dials, so it was unaffected). Best-effort: empty on failure -> host/srflx still connect on LAN.
    {
        let ice = crate::ice::fetch_ice_servers(&manager).await;
        crate::call_bridge::set_ice_servers(ice);
    }
    let mut consecutive_errors: u32 = 0;
    // webOS: the underlying stream ends spuriously on ordinary network hiccups (see this fn's own
    // top comment) and the loop below transparently re-opens it - each re-open re-drains to a fresh
    // Received::QueueEmpty, which used to re-send connected:1 every single time. On the C side that
    // fans out into presage_blist_buddies_all_set_online(), a full re-broadcast of EVERY buddy's
    // presence (CAPTURED 2026-08-05: a ~59-buddy account logged 50+ status-change lines in under a
    // second, repeating every couple of minutes as the stream flapped) - pure log/CPU churn since
    // nothing about the buddies actually changed, and one of several loads implicated in a
    // transport crash-loop that day. connected:1 only needs to fire once per login (libpurple's
    // connection state never actually leaves CONNECTED across these transparent reconnects, so
    // re-sending it was never doing anything besides the broadcast). Scoped here, not as a static,
    // so a genuinely fresh login (new receive() call) still gets its one legitimate broadcast.
    let mut first_connect = true;
    loop {
        match manager.receive_messages().await {
            Err(err) => {
                consecutive_errors += 1;
                if consecutive_errors >= 6 {
                    crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_NETWORK_ERROR,
                        format!("Receiver failed {consecutive_errors} times (device may have been unlinked): {err}"));
                    return;
                }
                crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO,
                    format!("receive_messages error ({consecutive_errors}/6): {err}; retrying…\n"));
            }
            Ok(messages) => {
                consecutive_errors = 0;
                crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("message stream open. stand by while catching up…\n"));
                futures::pin_mut!(messages);
                while let Some(received) = futures::StreamExt::next(&mut messages).await {
                    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("received: {received:?}\n"));
                    crate::receive::handle_received(&mut manager, account, received, &mut first_connect).await;
                }
                crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("receive stream ended; reconnecting…\n"));
            }
        }
        // brief back-off so we never busy-spin on immediate failures
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

/*
 * Opens the store, does the log-in, then runs forever.
 *
 * Based on presage-cli's main loop.
 */
pub async fn main(
    store_path: String,
    passphrase: Option<String>,
    command_receiver: tokio::sync::mpsc::Receiver<crate::structs::Cmd>,
    account: *mut crate::bridge_structs::PurpleAccount,
) {
    // make sure directory exists (presage-cli has this built-in, but not presage itself)
    if let Some(dir) = std::path::Path::new(&store_path).parent() {
        if let Err(err) = std::fs::create_dir_all(dir) {
            crate::bridge::purple_error(
                account,
                crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR,
                format!("Failed to create directory {dir:?}: {err}"),
            );
            return;
        }
    }
    crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("opening config database from {store_path}\n"));
    let config_store = presage_store_sqlite::SqliteStore::open_with_passphrase(&store_path, passphrase.as_deref(), presage::model::identity::OnNewIdentity::Trust);
    match config_store.await {
        Err(err) => {
            crate::bridge::purple_error(account, crate::bridge_structs::PURPLE_CONNECTION_ERROR_OTHER_ERROR, format!("config store error {err:#?}"));
        }
        Ok(config_store) => {
            crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, String::from("config store OK\n"));
            if let Some(mut manager) = login(config_store, account).await {
                // Login has succeeded, forward (cached) contacts for bitlbee. It tends to forget them after re-connects.
                crate::contacts::forward_contacts(account, &mut manager).await;
                // webOS: re-request the contact list from the primary (phone) on EVERY login, not just
                // at initial link. The address-book NAMES the user has on their phone only reach a
                // linked device via this contact sync; without re-requesting, contacts added/renamed
                // since pairing stay nameless (shown as bare +<phone>). The primary answers with a
                // ContactSync in the receive stream (started just below), which presage stores and
                // receive.rs feeds back through forward_contacts so the buddies gain their names.
                // Bounded by a timeout so a non-responding primary can't wedge the login (see the
                // historical "blocks forever" note in link()); the receive loop keeps running regardless.
                match tokio::time::timeout(std::time::Duration::from_secs(20), manager.request_contacts()).await {
                    Ok(Ok(())) => crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, String::from("requested contact sync from primary device\n")),
                    Ok(Err(err)) => crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("request_contacts error: {err:?}\n")),
                    Err(_) => crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, String::from("request_contacts timed out (primary not responding)\n")),
                }
                // clone the manager so we can receive messages in one task and process commands in the other
                let manager_receive = manager.clone();
                let local = tokio::task::LocalSet::new();
                // Re-request the contact sync a few times with backoff, in the background. The single
                // 20s request above just times out and NEVER retries, so a sleeping or slow primary
                // (phone) at login time loses the ENTIRE Signal contact list until the next reboot --
                // buddies then never appear (only bare +<phone> from message exchanges). The
                // ContactSync response is handled by the receive loop as usual; this only nudges the
                // primary again. Bounded to a handful of attempts, and cancelled with the LocalSet
                // when the connection ends.
                let manager_resync = manager.clone();
                let account_resync = account;
                local.spawn_local(async move {
                    let mut m = manager_resync;
                    for delay in [45u64, 90, 180, 360] {
                        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
                        if let Ok(Ok(())) = tokio::time::timeout(std::time::Duration::from_secs(20), m.request_contacts()).await {
                            crate::bridge::purple_debug(account_resync, crate::bridge_structs::PURPLE_DEBUG_INFO, String::from("re-requested contact sync from primary (background retry)\n"));
                        }
                    }
                });
                local.spawn_local(receive(manager_receive, account));
                local.run_until(command_loop(manager, command_receiver, account)).await;
            }
        }
    }
}
