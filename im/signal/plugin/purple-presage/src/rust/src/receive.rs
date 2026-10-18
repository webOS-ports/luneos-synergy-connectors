/*
 * Looks up the title of a group identified by its group master key.
 *
 * Adapted from presage-cli.
 */
async fn format_group<S: presage::store::Store>(
    key: [u8; 32],
    manager: &presage::Manager<S, presage::manager::Registered>,
) -> String {
    manager.store().group(key).await.ok().flatten().map(|g| g.title).unwrap_or_else(|| "<missing group>".to_string())
}

async fn lookup_message_body_by_timestamp<S: presage::store::Store>(
    manager: &presage::Manager<S, presage::manager::Registered>,
    thread: &presage::store::Thread,
    timestamp: u64,
) -> Option<String> {
    match manager.store().message(thread, timestamp).await {
        Err(_) => None,
        Ok(None) => None,
        Ok(Some(message)) => {
            if let presage::libsignal_service::content::ContentBody::DataMessage(presage::libsignal_service::content::DataMessage { body, .. })
            | presage::libsignal_service::content::ContentBody::SynchronizeMessage(presage::libsignal_service::content::SyncMessage {
                sent:
                    Some(presage::proto::sync_message::Sent {
                        message: Some(presage::libsignal_service::content::DataMessage { body, .. }),
                        ..
                    }),
                ..
            }) = message.body
            {
                body
                // TODO: also return body_ranges
            } else {
                None
            }
        }
    }
}

/*
 * Turns a DataMessage into a string for presentation via libpurple.
 *
 * Adapted from presage-cli.
 *
 * For long message, the message text body is not actually contained in the DataMessage, but delivered as an attachment.
 * In this case, the attachment is downloaded first and overrides the body of the DataMessage since that is only a preview.
 */
async fn format_data_message<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    account: *mut crate::bridge_structs::PurpleAccount,
    maybe_thread: Option<presage::store::Thread>,
    data_message: &presage::libsignal_service::content::DataMessage,
    body_override: Option<String>,
) -> Option<String> {
    let get_alias = |uuid: String| crate::bridge::blist_get_alias(account, uuid);
    match data_message {
        // Quote
        presage::libsignal_service::content::DataMessage {
            quote:
                Some(presage::proto::data_message::Quote {
                    id: quote_id,
                    author_aci: quote_author,
                    text: Some(quoted_text),
                    body_ranges: quoted_text_ranges,
                    ..
                }),
            body: Some(body),
            body_ranges,
            ..
        } => {
            let quote = pidgin_flavoured_html_from_body_with_ranges(quoted_text.to_owned(), quoted_text_ranges, get_alias);
            let firstline = quote.split("\n").next().unwrap_or("<message body missing>");
            let body = pidgin_flavoured_html_from_body_with_ranges(body_override.unwrap_or(body.to_owned()), body_ranges, get_alias);
            // webOS replies: rather than folding "> …" into the body, sentinel-encode the quoted
            // original so the C layer (presage_display_text) can split it out and stash it as
            // webos-quoted-{id,from,text} on the conversation -- the transport renders those as an
            // inline reply card (mirrors Telegram/WhatsApp/Signal-send). Wire format:
            //   \x01 <id> \x1f <from> \x1f <text> \x02 <reply body>
            // \x01/\x02/\x1f are control chars that never occur in real message text.
            let qid = quote_id.map(|v| v.to_string()).unwrap_or_default();
            let qfrom = quote_author.as_ref().map(|a| get_alias(a.to_owned())).unwrap_or_default();
            Some(format!("\u{1}{qid}\u{1f}{qfrom}\u{1f}{firstline}\u{2}{body}"))
        }
        // Reaction
        presage::libsignal_service::content::DataMessage {
            reaction:
                Some(presage::proto::data_message::Reaction {
                    target_sent_timestamp: Some(timestamp),
                    emoji: Some(emoji),
                    ..
                }),
            ..
        } => {
            if let Some(thread) = maybe_thread {
                match lookup_message_body_by_timestamp(manager, &thread, *timestamp).await {
                    None => {
                        let sent_at =
                            chrono::prelude::DateTime::<chrono::Local>::from(std::time::UNIX_EPOCH + std::time::Duration::from_millis(*timestamp)).format("%Y-%m-%d %H:%M:%S");
                        Some(format!("Reacted with {emoji} to message from {sent_at}."))
                    }
                    Some(body) => {
                        let firstline = body.split("\n").next().unwrap_or("<message body missing>");
                        // TODO: add ellipsis if body contains more than one line
                        Some(format!("Reacted with {emoji} to message „{firstline}“."))
                    }
                }
            } else {
                Some(format!("Reacted with {emoji} to unknown message (history not available for this conversation)."))
            }
        }
        // Sticker emoji (the sticker itself has already been handled like an attachment)
        presage::libsignal_service::content::DataMessage {
            sticker: Some(presage::proto::data_message::Sticker { emoji, .. }),
            ..
        } => emoji.clone(),
        // Poll Creation
        presage::libsignal_service::content::DataMessage {
            poll_create: Some(poll_create),
            ..
        } => {
            let question = poll_create.question();
            let options = poll_create.options.iter().enumerate().map(|(index, option_description)| {
                let option_number = index + 1;
                format!("{option_number}. {option_description}\n")}
            ).fold(String::new(), |a,b|format!("{a}{b}"));
            let multiple = if poll_create.allow_multiple() {
                "Multiple options are allowed."
            } else {
                "Only one option is allowed."
            };
            return Some(format!("Poll: {question}\n\n{options}\n{multiple}"));
        },
        // Poll Vote
        presage::libsignal_service::content::DataMessage {
            poll_vote: Some(poll_vote),
            ..
        } => {
            // TODO: find appropriate poll via poll_vote.target_sent_timestamp()?
            let chosen_options = itertools::Itertools::join(&mut poll_vote.option_indexes.iter().map(|i|(i+1).to_string()), ", ");
            Some(format!("voted for options {chosen_options}."))
        }
        // Plain text message
        presage::libsignal_service::content::DataMessage {
            body: Some(body),
            body_ranges,
            ..
        } => Some(pidgin_flavoured_html_from_body_with_ranges(body_override.unwrap_or(body.to_owned()), body_ranges, get_alias)),
        // Default (catch all other cases)
        c => {
            crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("DataMessage with unhandled fields: {c:?}\n"));
            // NOTE: This happens when receiving a file, but not providing a text
            // TODO: suppress this debug message if data message contained an attachment
            // NOTE: flags: Some(4) with a timestamp (and a profile_key?) may indicate "message sent"
            // Some("message has been sent".to_string())
            None
        }
    }
}

/*
 * Turn text body with style ranges into HTML. Mentions are turned into Links for keeping the UUID.
 *
 * In the end, this becomes Pango markup (see https://docs.gtk.org/Pango/pango_markup.html),
 * but not all features are supported since Pidgin does the HTML → Pango conversion
 * in gtk_imhtml_insert_html_at_iter(…), see pidgin/gtkimhtml.c.
 */
// TODO: forward body ranges and let front-end take care of resolving the UUIDs to friendly names
// NOTE: keep an eye on PurpleMarkupSpan documented at https://issues.imfreedom.org/issue/PIDGIN-17842
// TODO: it would probably be smarter to emit an iterator of char instead of converting a single char to a string
fn pidgin_flavoured_html_from_body_with_ranges<F: Fn(String) -> String>(
    body: String,
    body_ranges: &Vec<presage::proto::BodyRange>,
    get_alias: F,
) -> String {
    body.chars()
        .enumerate()
        .map(|(index, character)| {
            // taken from purple_markup_escape_text and append_escaped_text from libpurple/util.c
            let mut output = match character {
                '&' => "&amp;".to_string(),
                '<' => "&lt;".to_string(),
                '>' => "&gt;".to_string(),
                '"' => "&quot;".to_string(),
                '\n' => "<br>".to_string(),
                '\r' => "".to_string(),
                default => default.to_string(), // TODO: use XML numeric character references for all non-latin chars?
            };
            // start the style and resolve mentions along the way
            for body_range in body_ranges.iter().filter(|br| br.start.is_some_and(|s| s as usize == index)) {
                if let Some(associated_value) = &body_range.associated_value {
                    match associated_value {
                        presage::proto::body_range::AssociatedValue::MentionAci(mention_aci) => {
                            let alias = get_alias(mention_aci.clone());
                            output = format!("<a href=\"#{mention_aci}\">@{alias}</a>")
                        }
                        presage::proto::body_range::AssociatedValue::Style(style_id) => {
                            if let Ok(style) = presage::proto::body_range::Style::try_from(*style_id) {
                                match style {
                                    presage::proto::body_range::Style::None => {}
                                    presage::proto::body_range::Style::Bold => output = format!("<b>{output}"),
                                    presage::proto::body_range::Style::Italic => output = format!("<i>{output}"),
                                    presage::proto::body_range::Style::Spoiler => output = format!("<span style=\"color: #FFFFFF\">{output}"), // TODO: set color to background color for "invisibility"
                                    presage::proto::body_range::Style::Strikethrough => output = format!("<s>{output}"),
                                    presage::proto::body_range::Style::Monospace => output = format!("<font face=\"monospace\">{output}"),
                                }
                            }
                        }
                        presage::proto::body_range::AssociatedValue::MentionAciBinary(mention_aci_binary) => {
                            if let Ok(uuid) = presage::libsignal_service::prelude::Uuid::from_slice(mention_aci_binary) {
                                let alias = get_alias(uuid.to_string());
                                output = format!("<a href=\"#{uuid}\">@{alias}</a>");
                            }
                        }
                    }
                }
            }
            // end the style
            // mentions are already resolved and the replacement characters replaced, so there is nothing to do with them here
            for body_range in body_ranges.iter().filter(|br| br.start.is_some_and(|s| (s + br.length() - 1) as usize == index)) {
                // -1 is needed as I want to end the style after this caracter and there might not be a next character when at the end of the body
                if let Some(associated_value) = &body_range.associated_value {
                    match associated_value {
                        presage::proto::body_range::AssociatedValue::MentionAci(_) => {}
                        presage::proto::body_range::AssociatedValue::Style(style_id) => {
                            if let Ok(style) = presage::proto::body_range::Style::try_from(*style_id) {
                                match style {
                                    presage::proto::body_range::Style::None => {}
                                    presage::proto::body_range::Style::Bold => output = format!("{output}</b>"),
                                    presage::proto::body_range::Style::Italic => output = format!("{output}</i>"),
                                    presage::proto::body_range::Style::Spoiler => output = format!("{output}</span>"),
                                    presage::proto::body_range::Style::Strikethrough => output = format!("{output}</s>"),
                                    presage::proto::body_range::Style::Monospace => output = format!("{output}</font>"),
                                }
                            }
                        }
                        presage::proto::body_range::AssociatedValue::MentionAciBinary(_) => {}
                    }
                }
            }
            output
        })
        .collect()
}

async fn process_attachments<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    message: crate::bridge::Message,
    attachments: &Vec<presage::proto::AttachmentPointer>,
) -> Option<String> {
    let mut bodies = Vec::new();

    for attachment_pointer in attachments {
        if attachment_pointer.content_type() == "text/x-signal-plain" {
            // not actually an attachment, just a long text message
            if let Ok(attachment_data) = manager.get_attachment(attachment_pointer).await {
                match String::from_utf8(attachment_data) {
                    Ok(body) => {
                        bodies.push(body);
                    }
                    Err(err) => {
                        crate::bridge::append_message(
                            message
                                .clone()
                                .body(format!("Failed to fetch long text message due to {err}"))
                                .flags(crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_ERROR),
                        );
                    }
                }
            } else {
                crate::bridge::append_message(
                    message
                        .clone()
                        .body(format!("Some parts of this long text message might be missing."))
                        .flags(crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_ERROR),
                );
            }
        } else {
            process_non_text_attachment(attachment_pointer, message.clone());
        }
    }

    if bodies.is_empty() {
        None
    } else {
        Some(bodies.join("\n\n"))
    }
}

fn process_non_text_attachment(
    attachment_pointer: &presage::proto::AttachmentPointer,
    mut message: crate::bridge::Message,
) {
    match attachment_pointer.content_type.as_deref() {
        None => {
            crate::bridge::purple_debug(message.account, crate::bridge_structs::PURPLE_DEBUG_ERROR, format!("Received attachment without content type.\n"));
        }
        Some(mimetype) => {
            let extension = match mimetype {
                // use the most poplular default for some common mimetypes
                "image/jpeg" => "jpg",
                "image/png" => "png",
                "video/mp4" => "mp4",
                mimetype => {
                    let extensions = mime_guess::get_mime_extensions_str(mimetype);
                    extensions.and_then(|e| e.first()).unwrap_or(&"bin")
                }
            };
            // TODO: have a user-configurable template for generating the file-name
            // NOTE: for some conversations, all images come with the same filename
            let hash = match attachment_pointer.attachment_identifier.clone().unwrap() {
                presage::proto::attachment_pointer::AttachmentIdentifier::CdnId(id) => id.to_string(),
                presage::proto::attachment_pointer::AttachmentIdentifier::CdnKey(key) => key,
            };

            let filename = std::path::Path::new(attachment_pointer.file_name());

            message.attachment_pointer = Some(attachment_pointer.clone());
            message.hash = Some(hash);
            message.filename = filename.file_stem().unwrap_or_default().to_str().map(|s| s.to_string());
            let ext = filename.extension().map_or(extension, |s| s.to_str().unwrap_or(extension)).to_string();
            message.extension = Some(format!(".{ext}"));
            crate::bridge::append_message(message);
        }
    }
}

async fn process_data_message<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    message: crate::bridge::Message,
    data_message: &presage::proto::DataMessage,
) -> Option<String> {
    // webOS reactions: a reaction is not a message. Forward it to the transport as a typed
    // "webos-im-reaction" signal (targeting the reacted-to message by its sent timestamp, which is
    // that message's serviceMessageId) and suppress the prose "Reacted with X" line that would
    // otherwise appear as a separate message. An empty emoji signals removal to the transport.
    if let Some(reaction) = &data_message.reaction {
        if let Some(target) = reaction.target_sent_timestamp {
            let emoji = if reaction.remove() { String::new() } else { reaction.emoji().to_string() };
            let sender = message.who.clone().unwrap_or_default();
            crate::bridge::emit_reaction(message.account, target.to_string(), emoji, sender);
        }
        return None;
    }
    // download sticker if present
    if let Some(sticker) = &data_message.sticker {
        if let Some(attachment) = &sticker.data {
            process_non_text_attachment(attachment, message.clone());
        }
    }
    // download attachment (which – for long text messages – might contain the actual message body while the data message contains only a preview)
    let body = process_attachments(manager, message.clone(), &data_message.attachments).await;
    format_data_message(manager, message.account, message.thread, data_message, body).await
}

async fn process_sent_message<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    message: crate::bridge::Message,
    sent: &presage::proto::sync_message::Sent,
) {
    let mut message = message;
    message.flags = crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_SEND | crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_REMOTE_SEND;
    if let Some(body) = match sent {
        presage::proto::sync_message::Sent {
            message: Some(data_message),
            ..
        } => process_data_message(manager, message.clone(), data_message).await,
        presage::proto::sync_message::Sent {
            edit_message: Some(presage::proto::EditMessage {
                data_message: Some(data_message),
                ..
            }),
            ..
        } => process_data_message(manager, message.clone(), &data_message).await,
        c => {
            crate::bridge::purple_debug(message.account, crate::bridge_structs::PURPLE_DEBUG_WARNING, format!("Unsupported message {c:?}\n"));
            None
        }
    } {
        crate::bridge::append_message(message.clone().body(body));
    }
}

async fn process_sync_message<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    message: crate::bridge::Message,
    sync_message: &presage::proto::SyncMessage,
) {
    // TODO: explicitly ignore SynchronizeMessage(SyncMessage { sent: None, contacts: None, request: None, read: [], blocked: None, verified: None, configuration: None, padding: Some([…]), …, delete_for_me: Some(DeleteForMe { message_deletes: [MessageDeletes { conversation: Some(ConversationIdentifier { identifier: Some(ThreadServiceId("REDACTED")) }), messages: [AddressableMessage { sent_timestamp: Some(1674147919685), author: Some(AuthorServiceId("REDACTED")) }] }], conversation_deletes: [], local_only_conversation_deletes: [], attachment_deletes: [] }) })
    if let Some(sent) = &sync_message.sent {
        process_sent_message(manager, message, sent).await;
    }
}

async fn process_received_message<C: presage::store::Store>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    message: crate::bridge::Message,
    received: &presage::libsignal_service::content::ContentBody,
) {
    if let Some(body) = match received {
        presage::libsignal_service::content::ContentBody::NullMessage(_) => Some("Null message (for example deleted)".to_string()),
        presage::libsignal_service::content::ContentBody::DataMessage(data_message) => process_data_message(manager, message.clone(), data_message).await,
        presage::libsignal_service::content::ContentBody::SynchronizeMessage(_) => {
            // Defensive: a SynchronizeMessage should have been routed to process_sync_message by the
            // dispatch. If one slips through, just log it -- do NOT purple_error, which would drop the
            // whole Signal connection over a single stray message.
            crate::bridge::purple_debug(
                message.account,
                crate::bridge_structs::PURPLE_DEBUG_WARNING,
                "SynchronizeMessage ended up in process_received_message (ignored)\n".to_string(),
            );
            None
        }
        presage::libsignal_service::content::ContentBody::CallMessage(call_message) => {
            // DIAG (media-bridge step #1): dump the RAW opaque bytes of a real call so we can decode
            // RingRTC's ConnectionParametersV4 (public_key / ice_ufrag / ice_pwd / codecs, no DTLS)
            // off-device and ground the GStreamer/SRTP media plan on an actual message. Offer +
            // answer + every ICE update. Remove once the format is confirmed.
            {
                use std::io::Write as _;
                let hexify = |b: &[u8]| b.iter().map(|x| format!("{:02x}", x)).collect::<String>();
                let mut dump = String::new();
                if let Some(o) = call_message.offer.as_ref() {
                    dump += &format!("OFFER id={:?} type={:?} opaque_len={} opaque_hex={}\n",
                        o.id, o.r#type, o.opaque.as_ref().map_or(0, |v| v.len()),
                        o.opaque.as_ref().map_or(String::new(), |v| hexify(v)));
                }
                if let Some(a) = call_message.answer.as_ref() {
                    dump += &format!("ANSWER id={:?} opaque_len={} opaque_hex={}\n",
                        a.id, a.opaque.as_ref().map_or(0, |v| v.len()),
                        a.opaque.as_ref().map_or(String::new(), |v| hexify(v)));
                }
                for (i, ice) in call_message.ice_update.iter().enumerate() {
                    dump += &format!("ICE[{i}] id={:?} opaque_len={} opaque_hex={}\n",
                        ice.id, ice.opaque.as_ref().map_or(0, |v| v.len()),
                        ice.opaque.as_ref().map_or(String::new(), |v| hexify(v)));
                }
                // DIAG (call-sustain): log Hangup/Busy so we can see WHO ends the call at ~1-2s and why
                // (hangup.type: 0=NORMAL 1=ACCEPTED 2=DECLINED 3=BUSY 4=NEED_PERMISSION). If the peer
                // (Android) sends this, the caller tore down; if not, our side did.
                if let Some(h) = call_message.hangup.as_ref() {
                    dump += &format!("HANGUP id={:?} type={:?} device_id={:?}\n", h.id, h.r#type, h.device_id);
                }
                if let Some(b) = call_message.busy.as_ref() {
                    dump += &format!("BUSY id={:?}\n", b.id);
                }
                if !dump.is_empty() {
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("/media/internal/sigoffer.log") {
                        let _ = f.write_all(dump.as_bytes());
                    }
                }
            }
            // Signaling only (no media yet): ring the stock Phone app on an incoming call, clear it on
            // hangup/busy, and drop a "Missed voice call" line into history. offer=incoming; hangup/busy
            // end it; answer/ice belong to a call we don't drive, so ignore them.
            let call_id = call_message
                .offer
                .as_ref()
                .and_then(|o| o.id)
                .or_else(|| call_message.answer.as_ref().and_then(|a| a.id))
                .or_else(|| call_message.hangup.as_ref().and_then(|h| h.id))
                .or_else(|| call_message.busy.as_ref().and_then(|b| b.id))
                // A trickled IceUpdate carries ONLY ice_update entries (each with the call id) - no
                // offer/answer. Without this it fell through to 0, so feed_remote_ice(0,...) never
                // matched the engine and the peer's candidates were dropped -> ICE never connected.
                .or_else(|| call_message.ice_update.iter().find_map(|i| i.id))
                .unwrap_or(0);
            // Multi-device: webOS is a LINKED (secondary) Signal device. An incoming call rings this
            // device AND the user's primary phone. When the user accepts HERE, the caller broadcasts
            // Hangup{type=ACCEPTED, device_id=<us>} to the account so the phone stops ringing - but
            // Signal delivers it to THIS device too. Acting on it would tear down our own live call
            // (that was the ~1-2s "disconnect"). RingRTC hangup types: 0=NORMAL 1=ACCEPTED 2=DECLINED
            // 3=BUSY. A type=ACCEPTED for a call we've accepted is our own acceptance echo -> ignore it.
            let hangup_type = call_message.hangup.as_ref().and_then(|h| h.r#type);
            let self_accept_hangup = hangup_type == Some(1) && crate::call_bridge::was_accepted(call_id);
            let (state, chat) = if call_message.offer.is_some() {
                (crate::bridge::CALL_STATE_INCOMING, None)
            } else if call_message.answer.is_some() {
                // Peer answered OUR outgoing call -> tell the dialer the line is now active.
                (crate::bridge::CALL_STATE_ACTIVE, None)
            } else if self_accept_hangup {
                // "Accepted on this (our) device" notification for OUR live call - not a call end.
                (u32::MAX, None)
            } else if call_message.busy.is_some() {
                (crate::bridge::CALL_STATE_BUSY, None)
            } else if call_message.hangup.is_some() {
                // Only a genuinely MISSED incoming call gets a "Missed voice call" history line. A
                // hangup for a call WE placed is just the end of an outgoing call, not a missed one.
                let missed = if crate::call_bridge::is_outgoing_call(call_id) {
                    None
                } else {
                    Some("Missed voice call".to_string())
                };
                (crate::bridge::CALL_STATE_ENDED, missed)
            } else {
                (u32::MAX, None)
            };
            if state != u32::MAX {
                // message.name is None for a direct contact (only the async resolver fills the buddy
                // alias), so resolve the caller's friendly name by UUID here. blist_get_alias returns
                // the UUID unchanged when no alias is known yet; process_incoming_message has already
                // kicked off resolve_name_background for this sender, so a saved/previously-messaged
                // contact resolves immediately. Without this the Phone app shows the raw Signal UUID
                // ("Unknown Caller") instead of the contact name.
                let name = message.name.clone().or_else(|| {
                    message.who.clone().map(|uuid| crate::bridge::blist_get_alias(message.account, uuid))
                });
                // For an OUTGOING call (e.g. the peer's Answer -> ACTIVE), report the address the user
                // DIALED, not the peer's UUID - so the dialer keeps the single card it opened instead of
                // spawning a UUID-addressed second one (same reason as place_call). Incoming keeps who.
                let card_addr = crate::call_bridge::dialed_address(call_id).or_else(|| message.who.clone());
                crate::bridge::handle_call_state(message.account, card_addr, name, state, call_id);
            }

            // Media bridge (gated on /media/internal/signal_call_media). Drives the signal_media
            // engine: offer -> auto-answer + start media; ice_update -> feed remote candidates;
            // hangup/busy -> tear the engine down. Sends the Answer/our-ICE back via the command loop.
            if crate::call_bridge::media_enabled() {
                let caller_uuid = message
                    .who
                    .as_ref()
                    .and_then(|w| presage::libsignal_service::prelude::Uuid::parse_str(w).ok());
                if let Some(offer) = call_message.offer.as_ref() {
                    if let (Some(uuid), Some(op)) = (caller_uuid, offer.opaque.as_ref()) {
                        // Source the 32-byte RAW Curve25519 identity public keys the RingRTC SRTP KDF
                        // binds in: caller = the offerer/peer's ACI identity key, callee = ours.
                        // IdentityKey::serialize() is the 33-byte 0x05-prefixed form; strip the prefix.
                        use presage::libsignal_service::protocol::{DeviceId, IdentityKeyStore, ProtocolAddress};
                        let aci_store = manager.store().aci_protocol_store();
                        let callee_id: Vec<u8> = aci_store
                            .get_identity_key_pair()
                            .await
                            .ok()
                            .map(|kp| kp.identity_key().serialize()[1..].to_vec())
                            .unwrap_or_default();
                        let caller_id: Vec<u8> = match (message.who.as_ref(), DeviceId::try_from(1u32)) {
                            (Some(w), Ok(dev)) => {
                                let addr = ProtocolAddress::new(w.clone(), dev);
                                aci_store
                                    .get_identity(&addr)
                                    .await
                                    .ok()
                                    .flatten()
                                    .map(|ik| ik.serialize()[1..].to_vec())
                                    .unwrap_or_default()
                            }
                            _ => Vec::new(),
                        };
                        // Use the ICE/TURN relays prefetched at login (call_bridge's cache) - do NOT
                        // fetch here: a blocking network fetch on this single receive loop delayed the
                        // answerer's engine spawn ~2s, making our Answer/ICE responses late so the
                        // answerer's ICE failed. Spawn immediately so we answer the caller's checks fast.
                        crate::call_bridge::start_incoming(uuid, call_id, op, &caller_id, &callee_id);
                    }
                }
                // The peer answered one of OUR outgoing calls -> start media in caller role.
                if let Some(answer) = call_message.answer.as_ref() {
                    if let Some(op) = answer.opaque.as_ref() {
                        crate::call_bridge::on_answer(call_id, op);
                    }
                }
                if !call_message.ice_update.is_empty() {
                    let opaques: Vec<Vec<u8>> = call_message
                        .ice_update
                        .iter()
                        .filter_map(|ice| ice.opaque.clone())
                        .collect();
                    if !opaques.is_empty() {
                        crate::call_bridge::feed_remote_ice(call_id, &opaques);
                    }
                }
                if (call_message.hangup.is_some() || call_message.busy.is_some()) && !self_accept_hangup {
                    eprintln!("call_bridge: PEER ended call {call_id} (hangup={} busy={} type={:?}) -> stop engine",
                              call_message.hangup.is_some(), call_message.busy.is_some(), hangup_type);
                    crate::call_bridge::stop(call_id);
                } else if self_accept_hangup {
                    eprintln!("call_bridge: IGNORING self HANGUP_ACCEPTED for our live call {call_id} (linked-device notification)");
                }
            }
            chat
        }
        presage::libsignal_service::content::ContentBody::EditMessage(presage::proto::EditMessage {
            data_message: Some(data_message),
            ..
        }) => process_data_message(manager, message.clone(), &data_message).await,
        // TODO: forward these properly
        presage::libsignal_service::content::ContentBody::TypingMessage(_) => None, // TODO Some(Msg::Received(&thread, "is typing...".into())), // too annyoing for now. also does not differentiate between "started typing" and "stopped typing"
        presage::libsignal_service::content::ContentBody::ReceiptMessage(receipt) => {
            // webOS delivery/read receipts: the recipient delivered/read messages we sent.
            // receipt.timestamp lists the target sent-timestamps (each == our serviceMessageId);
            // receipt.type is Delivery(0)/Read(1)/Viewed(2). Emit a per-id receipt so the transport
            // upgrades each Outbox row's deliveryStatus (single/double tick).
            let status = match presage::proto::receipt_message::Type::try_from(receipt.r#type.unwrap_or(0)) {
                Ok(presage::proto::receipt_message::Type::Read) | Ok(presage::proto::receipt_message::Type::Viewed) => "read",
                _ => "delivered",
            };
            for ts in &receipt.timestamp {
                crate::bridge::emit_receipt(message.account, ts.to_string(), status.to_string());
            }
            None
        }
        c => {
            // catch-all for everything else
            crate::bridge::purple_debug(message.account, crate::bridge_structs::PURPLE_DEBUG_WARNING, format!("Unsupported message {c:?}\n"));
            None
        }
    } {
        let mut message = message.clone();
        message.body = Some(body);
        crate::bridge::append_message(message);
    }
}

/*
 * Prepares a received message (text and attachments) for further processing.
 *
 * Based on presage-cli's `process_incoming_message`.
 */
thread_local! {
    // UUIDs we have already spawned a background name-resolution for this session, so a chatty
    // contact does not trigger a profile fetch on every single message. Reset on reconnect (the
    // whole LocalSet/task tree is torn down and rebuilt), which is when re-resolving is useful anyway.
    static NAME_RESOLVE_ATTEMPTED: std::cell::RefCell<std::collections::HashSet<presage::libsignal_service::prelude::Uuid>>
        = std::cell::RefCell::new(std::collections::HashSet::new());
}

// The message's profile_key belongs to whoever SENT the message. Only hand it to the resolver when
// the sender is the contact we're naming (an incoming direct message); for sync (sent-by-me)
// messages the key is not the recipient's, so let the resolver fall back to the store instead.
fn contact_profile_key_hint(
    content: &presage::libsignal_service::content::Content,
    contact_uuid: presage::libsignal_service::prelude::Uuid,
) -> Option<Vec<u8>> {
    if content.metadata.sender.raw_uuid() != contact_uuid {
        return None;
    }
    match &content.body {
        presage::libsignal_service::content::ContentBody::DataMessage(dm) => dm.profile_key.clone(),
        _ => None,
    }
}

async fn process_incoming_message<C: presage::store::Store + Clone + 'static>(
    manager: &mut presage::Manager<C, presage::manager::Registered>,
    content: &presage::libsignal_service::content::Content,
    account: *mut crate::bridge_structs::PurpleAccount,
) {
    let mut message = crate::bridge::Message {
        account: account,
        // webOS: the whole pipeline (bridge -> presage_handle_text -> db8 immessage.localTimestamp)
        // works in MILLISECONDS. chrono's .timestamp() returns SECONDS, so every incoming message was
        // stored 1000x too small and rendered at ~Jan 1970 - sorted completely out of view, which
        // looked like received Signal messages were being dropped. Use .timestamp_millis().
        timestamp: Some(content.metadata.timestamp.timestamp_millis() as u64),
        ..Default::default()
    };
    // TODO: check where thread is actually needed and look it up conditionally?
    // That would mean handling the metadata for determining source/destination/sender/recipient ourselves.
    match presage::store::Thread::try_from(content) {
        Ok(thread) => {
            match thread {
                presage::store::Thread::Contact(service_id) => {
                    message.who = Some(service_id.service_id_string());
                    // Resolve a display name for this contact WITHOUT blocking the receive loop.
                    // An earlier version fetched the name inline with an untimed network call, which
                    // stalled the entire loop when it hung (no further messages arrived). Instead
                    // spawn a fire-and-forget task on a cloned manager (bounded by a timeout inside),
                    // throttled to one attempt per UUID per session. This names contacts you have only
                    // messaged (never saved on the phone) -- forward_contacts can't, as they aren't in
                    // the address book. The receive loop continues immediately.
                    let uuid = service_id.raw_uuid();
                    let first_attempt = NAME_RESOLVE_ATTEMPTED.with(|seen| seen.borrow_mut().insert(uuid));
                    if first_attempt {
                        let hint = contact_profile_key_hint(content, uuid);
                        let manager_name = manager.clone();
                        tokio::task::spawn_local(crate::contacts::resolve_name_background(account, manager_name, uuid, hint));
                    }
                }
                presage::store::Thread::Group(key) => {
                    message.who = Some(content.metadata.sender.raw_uuid().to_string());
                    message.group = Some(hex::encode(key));
                    message.name = Some(format_group(key, manager).await);
                }
            }
            message.thread = Some(thread);
        }
        Err(err) => {
            crate::bridge::purple_debug(
                account,
                crate::bridge_structs::PURPLE_DEBUG_ERROR,
                format!("Unable to find conversation thread due to {err:?} for {content:?}.\n"),
            );
            message.who = Some("00000000-0000-0000-0000-000000000000".to_string());
            message.name = Some("unknown contact – do not reply".to_owned());
        }
    };
    match &content.body {
        presage::libsignal_service::content::ContentBody::SynchronizeMessage(sync_message) => process_sync_message(manager, message, sync_message).await,
        _ => {
            message.flags = crate::bridge_structs::PurpleMessageFlags::PURPLE_MESSAGE_RECV;
            process_received_message(manager, message, &content.body).await
        }
    }
}

pub async fn handle_received<S: presage::store::Store + Clone + 'static>(
    manager: &mut presage::Manager<S, presage::manager::Registered>,
    account: *mut crate::bridge_structs::PurpleAccount,
    received: presage::model::messages::Received,
    first_connect: &mut bool,
) {
    match received {
        presage::model::messages::Received::QueueEmpty => {
            // webOS CORRECTION (2026-08-05): this fires far more often than "once after all old
            // messages have been received and processed" (the upstream comment's claim, kept below
            // for context) - CAPTURED LIVE: roughly every 30-90s during otherwise-idle, fully-online
            // operation, not just after a stream reconnect. Anything unconditional in this branch
            // runs on that same cadence for the life of the connection.
            crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("finished catching up.\n"));

            if *first_connect {
                *first_connect = false;
                // webOS chatthread fix: prime every stored contact's phone_number attribute from the
                // persistent store BEFORE reporting connected, so the transport's getFullBuddyList
                // (fired on connected) writes each Signal buddy's ims.value as +E.164 rather than the
                // raw ACI. Otherwise phone-addressed messages fail Person.findByIM(type_signal) in the
                // chatthreader and spawn duplicate "+<number>" conversations. Queued before connected:1
                // so these run first on the main thread. See prime_contact_phone_numbers().
                // MOVED INSIDE first_connect (2026-08-05): this was previously unconditional on the
                // (wrong) assumption that QueueEmpty fires once and that re-priming on every
                // recurrence was cheap. It isn't - prime_contact_phone_numbers() calls
                // presage_handle_contact() per stored contact, which unconditionally calls
                // presage_blist_set_online() (blist.c) for EVERY one of them, i.e. exactly the same
                // full-buddy-list presence re-broadcast connected:1 was fixed to stop sending, just
                // via a second path this fix missed the first time. CAPTURED LIVE: with only the
                // connected:1 gate in place, a ~59-buddy account still logged 50-60 status-change
                // lines roughly every 30-90s, unchanged from before that fix. The E.164 data doesn't
                // change after the first priming in practice, so gating this too is safe.
                crate::contacts::prime_contact_phone_numbers(account, manager).await;

                // now that the initial sync has completed, the account can be regarded as "connected" since it is ready to send messages
                // see https://github.com/whisperfish/presage/blob/3f55d5f/presage/src/manager/registered.rs#L574 which says:
                // „As a client, it is heavily recommended to process incoming messages and wait for the Received::QueueEmpty messages before giving the ability for users to send messages.“
                // NOTE: if an error occurs between login and here, libpurple does not automatically close the connection
                crate::bridge::append_message(crate::bridge::Message {
                    account: account,
                    connected: 1,
                    ..Default::default()
                });
            } else {
                crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO,
                    format!("already connected - skipping the phone-number priming + buddy re-broadcast.\n"));
            }
        }
        presage::model::messages::Received::Contacts => {
            // this happens in response to manager.request_contacts()
            crate::bridge::purple_debug(account, crate::bridge_structs::PURPLE_DEBUG_INFO, format!("received contacts\n"));
            crate::contacts::forward_contacts(account, manager).await;
            crate::contacts::forward_groups(account, manager).await; // TODO: find out how to actually request list of groups
        }
        presage::model::messages::Received::Content(content) => process_incoming_message(manager, &content, account).await,
    }
}
