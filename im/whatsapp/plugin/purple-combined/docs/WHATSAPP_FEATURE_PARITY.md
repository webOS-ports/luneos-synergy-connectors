# WhatsApp feature parity — status & implementation complexity

Gap analysis of this codebase's WhatsApp support against a "full-featured WhatsApp client"
feature list, plus an effort estimate for closing each gap. Covers two layers:

- **Backend**: `messaging/facebook-e2ee/plugin/purple-combined` (the combined libpurple plugin;
  WhatsApp support is `whatsmeow`-based Go glued into libpurple via cgo — there is no separate
  "whatsapp-only" plugin, see `keep-upstream-unchanged` / architecture notes).
- **UI**: `com.palm.app.messaging` (core-apps repo).

Backend complexity estimates are grounded in the **actual vendored whatsmeow version**
(`go.mau.fi/whatsmeow v0.0.0-20260716095330-85d99080dee8`, per `go.mod`) — function names below
were confirmed to exist in that checkout, not assumed from general WhatsApp/whatsmeow knowledge.
**Re-verify against `go.mod` before scoping work** if the dependency has been bumped since.

Effort scale: **S** = ~1-3 days, **M** = ~1 week, **L** = ~2-4 weeks, **XL** = multi-week, touches
new subsystems or UI paradigms not yet present in the app.

---

## Summary table

| Feature | Status | Backend effort to close | UI effort to close | Overall |
|---|---|---|---|---|
| Authentication (QR, pair code, persistent sessions) | ✅ Done | — | — | — |
| Messaging (E2E, edit, reactions, quote, receipts) | ✅ Done | — | — | — |
| Media (image/video/doc/voice) | ✅ Done | — | — | — |
| Media: GIF as animated media | ❌ Gap | S | S | **S-M** |
| Voice calls | ✅ Done (+video, beyond scope) | — | — | — |
| Location messages (incl. live location) — receive | ✅ Done | — | — | — |
| Contact / vCard messages — receive | ✅ Done | — | — | — |
| "Delete for everyone" (revoke) — receive | ✅ Done | — | — | — |
| Stickers — send (receive already worked) | ✅ Done | — | — | — |
| Events — receive + add to Calendar | ✅ Done | — | — | — |
| **Polls — display *and* vote** | ✅ Done | — | — | — |
| Status posts — **receive** (own Servers-tab channel per sender) | ✅ Done | — | — | — |
| Groups: create/admin/invite | ❌ Gap | S (calls exist) | M-L (new screens) | **M-L** |
| Communities (subgroup linking) | ❌ Gap | S-M (calls + blist filing) | S (nav concept already exists) | **M** |
| Newsletters: create | ⚠️ Follow-only | S | S-M | **S-M** |
| Status posts — **send** (post your own) | ❌ Gap | M (audience logic) | L-XL (new UI paradigm) | **L-XL** |
| Contacts: phone lookup | ❌ Gap | S | S | **S** |
| Contacts: business profile | ❌ Gap | S | S | **S** |
| Presence: outgoing typing | ❌ Gap | S | S | **S** |
| Presence: block/unblock action | ⚠️ Read-only | S | S | **S-M** |
| Chat actions: archive/pin/mute/star | ❌ Gap | S (builders exist) | M-L (4 affordances + 2 views) | **M-L** |
| Profile: push name / status text / own photo | ❌ Gap | S | S-M | **S-M** |
| Privacy settings (last-seen, photo, receipts, etc.) | ❌ Gap | S | S-M | **S-M** |
| Disappearing messages (usable) | ⚠️ Backend-only, no UI | S (calls exist) | M (needs local expiry/purge job) | **M** |
| Modular / native plugins / runtime-agnostic | N/A | — | — | N/A — describes a different library's build-time architecture, not applicable to this single combined `.so` |

---

## Recently closed (rich message types)

A batch of "special message" types that `handle_message.go` previously either ignored silently or
rendered as placeholder text. All of these are **receive**-side except sticker send and poll
voting. The shared UI pattern: the plugin encodes the payload into the message body as a compact
token, and `ConversationItem.js` turns that token into a real widget (a tappable chip, or for
polls an interactive control), stripping the token from the displayed text.

| Type | Backend (`purple-combined`) | UI (`com.palm.app.messaging`) |
|---|---|---|
| **Location** | `LocationMessage` + `LiveLocationMessage` → `formatLocationMessage` emits a `geo:<lat>,<lng>` URI (RFC 5870-ish) plus name/address | `geoUrlRe`/`buildLocationChip` → tappable pin chip; opens `com.palm.app.maps` at the coordinates |
| **Contact / vCard** | `ContactMessage` + `ContactsArrayMessage` → vCard written to a real `.vcf` in the account's attachment dir; body is the `file://` URL with `?name=` | `mediaKind` → `"contact"`; renders as a named chip, opens `com.palm.app.contacts` |
| **Delete for everyone** | `ProtocolMessage` type `REVOKE` → `purple_handle_message_delete` → new `webos-im-delete` signal → transport's `DeleteHandler` merges the tombstone onto the original db8 row | Original bubble becomes *"This message was deleted."* in place (same in-place-edit pattern as `EditHandler`) |
| **Stickers (send)** | `.webp` from the attachment picker routes to `send_file_sticker` (a `StickerMessage`, not an `ImageMessage` — the same format-based distinction real clients make) | Existing picker; no new UI |
| **Stickers (receive)** | Incoming stickers are **transcoded webp→PNG** in `download_attachment` | Needed because this WebKit can't render webp at all — was the "stickers don't display" symptom |
| **Events** | `EventMessage` → `formatEventMessage` emits an `event:<base64url-json>` token (name/location/note/start/end) | `buildEventChip` → "Add to Calendar" chip; launches the Calendar app's pre-filled new-event flow |
| **Polls** | `PollCreationMessage*` → `formatPollMessage` emits a `poll:<base64url-json>` token; **voting** goes back out via `send_poll_vote` (`BuildPollVote` + `SendMessage`) | `buildPollBlock` renders real radio buttons (single-select) or checkboxes (multi), tappable; taps are swallowed before the reaction picker so polls aren't reactable |

### Polls — the interesting one

This is the only item here that is genuinely **two-way**, and it closes the upstream plugin's own
documented limitation (its README still reads *"Displaying polls (but no participating in them)"*).
Three things made it more than a display feature:

- **Vote encryption keying.** `EncryptPollVote` looks up a per-message secret that whatsmeow stored
  under the exact `(chat, sender, id)` it saw internally — with **no LID/PN fallback**. The rest of
  the codebase resolves senders through `lidToPn()` for display, so voting with that resolved JID
  silently looks up the wrong key whenever the two forms differ. `CachedMessage.RawSender` keeps
  the un-resolved original alongside the display one specifically for this.
- **Surviving a transport restart.** The in-memory message cache is wiped on every restart, which
  made any poll from a previous session permanently unvotable ("poll not found in cache"). Fixed by
  reusing the **db8-fallback pattern already proven for reactions**: the app sends the poll's
  original sender (`senderJid`) from its own stored row, the transport stashes it on the account as
  an out-of-band string right before the (synchronous) signal emit, and the Go side reconstructs the
  `MessageSource` from it on a cache miss. The per-message *secret* lives in whatsmeow's own
  persistent store, not the cache, so this works for arbitrarily old polls.
- **Optimistic local state.** Votes are debounced (600 ms) before transmit so a rapid multi-select
  burst sends only the final selection — each send is its own goroutine with no ordering guarantee,
  so one send per tap let an older selection land after a newer one. Locally the pending selection
  is overlaid in a wrapper around `list.queryResponse`, which is the one choke point *every*
  re-render path funnels through (`list.punt()`/`reset()` from the db8 watch bypass the app's own
  `gotMessages` handler entirely). `myPollVote` also had to be added to the query's `select`
  whitelist or db8 drops it on every fresh query, losing the vote across an app restart.

### Status posts (receive)

Distinct from the **send** gap still listed above. A contact's status update arrives on
`types.StatusBroadcastJID`; rather than masquerading as an ordinary 1:1 chat from that contact
(which made each one show up as a random new chat thread), it's re-tagged with a synthetic
`<phone>@broadcast` JID so `LibpurpleAdapter`'s `isWhatsAppStatus` can bucket it into its own
per-sender channel under a "Status Updates" server — the same Servers-tab mechanism followed
Channels already use.

---

## Detail

### GIF send/receive — S-M
`send_file.go`'s mimetype switch has no `image/gif` case, so GIFs fall through to
`send_file_document` (sent as a generic file, not an animated message). WhatsApp represents GIFs
as an MP4 **`VideoMessage`** with the `GifPlayback` flag set — confirmed present in the vendored
proto (`proto/waE2E`: `VideoMessage.GifPlayback`, `GifAttribution`). The existing
`send_file_video`/`check_mp4` pipeline already produces a valid `VideoMessage`; the only new work
is (1) detecting `image/gif`, (2) transcoding GIF→MP4, and (3) setting `GifPlayback: true`.
`ffmpeg` is already cross-compiled and deployed on-device (used by the Teams voice-note transcode
path, `teams_contacts.c`), so the transcode step reuses an already-proven toolchain rather than
requiring new cross-build work. Receive side likely already "works" (plays as a normal video) —
looping/muted-autoplay is a UX nicety, not a functional blocker.

### Groups: create / admin / invite / membership approval — M-L
All of the following already exist as direct, exported whatsmeow calls: `CreateGroup`,
`LeaveGroup`, `UpdateGroupParticipants`, `GetGroupRequestParticipants` +
`UpdateGroupRequestParticipants` (membership approval), `SetGroupJoinApprovalMode`,
`SetGroupMemberAddMode`, `SetGroupDescription`, `SetGroupName`, `SetGroupTopic`, `SetGroupPhoto`,
`SetGroupLocked`, `SetGroupAnnounce`, `GetGroupInviteLink`, `JoinGroupWithInvite`/
`JoinGroupWithLink`. The protocol-level heavy lifting is already done by the library — this is
"thin wrapper + cgo glue" work following the exact pattern already used in `groups.go` for
`GetGroupInfo`/`GetJoinedGroups`. The real cost is UI: a "Create Group" flow (name + member
picker — no such picker currently exists in Messaging), an admin panel (rename/photo/description/
lock/approval-mode/add-mode toggles), and a "pending join requests" queue screen. None of these
UI pieces exist today; they'd be new Enyo views, though following well-trodden patterns (similar
in shape to the existing swipe/menu actions in `ConversationList.js`).

### Communities (subgroup linking) — M
**Correction from an earlier pass of this doc, prompted by a good push-back**: this was originally
scored L-XL on the assumption that the Messaging app has no "a chat that is itself a collection of
other chats" concept. That's wrong — it already does, and it's already generic across protocols.

`com.palm.app.messaging/app/servers/` (`ServerList.js`/`ChannelList.js`/`ServerService.js`) is a
shipped two-level drill-down (server list → that server's channel list → opens the channel's
chatthread in the normal `ChatView`) backed by two real db8 kinds, **`com.palm.imserver:1`** and
**`com.palm.imchannel:1`** (`imchannel.serverId` points at its parent `imserver`). It's already
protocol-agnostic — the empty-state copy literally reads *"Add a Discord, IRC, Teams, Slack or
Matrix account to see its servers here"* — and it's populated by a native mechanism
(`LibpurpleAdapter::enumerateServersChannels` → `IMServiceHandler::syncServersChannels`, in
`imlibpurpleservice`) that has **already been extended once for WhatsApp specifically**: followed
newsletters/channels are synthesized into a single "WhatsApp Channels" pseudo-server today (see the
`type_whatsapp`-specific block in `enumerateServersChannels`), so there's a direct, working
precedent for "WhatsApp thing → entry in the Servers tab" already in this exact codebase.

Crucially, the generic mechanism's "which guild does this chat belong to" signal is **just a
naming convention on the purple buddy-list group** — `deriveServerName()` splits a blist group's
name on `": "` (`"GuildName: Category"`), which is how Discord/Teams signal hierarchy today (no
special per-protocol API, just a string convention `purple-discord`/`purple-teams` already follow
when filing chats into blist groups). And on the whatsmeow side, `types.GroupInfo` already embeds
**`GroupLinkedParent.LinkedParentJID`** directly — every group/subgroup we already receive via
`JoinedGroup`/`GetGroupInfo` already tells us which community it belongs to, no extra polling
needed (`GetSubGroups`/`GetLinkedGroupsParticipants` exist too, for completeness/backfill).

So the real remaining work is narrow: when a group's `LinkedParentJID` is set, file its purple
chat under a blist group named `"<CommunityDisplayName>: "` (`glue/blist.c` already provides blist
manipulation primitives) instead of today's flat `"Whatsapp"` bucket, and resolve/cache the
community's own display name (one `GetGroupInfo` call on the parent JID). That's it — the generic
Servers/Rooms machinery (`imserver`/`imchannel`, the `ServerList`/`ChannelList` UI, unread
aggregation) needs **zero changes**. In size and shape this is comparable to the ~100-line
"WhatsApp Channels" synthetic-server block that's already shipped in `enumerateServersChannels` —
a bounded, precedented addition, not a new subsystem.

### Newsletter creation — S-M
`CreateNewsletter(ctx, CreateNewsletterParams{Name, Description, Picture})` already exists and
returns full metadata; `FollowNewsletter`/`UnfollowNewsletter` are already exported (following
channels is already implemented per existing newsletter/channel-icon work — see
`handle_newsletter.go`). `ChannelList.js` currently only browses/joins **existing** channels — no
create flow. Effort is small because the group-create UI work (member/name/photo form) directly
informs this one; a channel-create form is simpler still (no member picker).

### Status posts — L-XL (largest single gap)
Backend: sending a status is explicitly documented in whatsmeow itself — `SetStatusMessage`'s
doc-comment states *"Use SendMessage to types.StatusBroadcastJID"* for status broadcasts, meaning
the existing `send_message.go`/`send_file.go` plumbing is directly reusable for the send path.
`GetStatusPrivacy` is exported (read current audience rules), but the **recipient-list resolution
helper (`getStatusBroadcastRecipients`) is unexported** — we'd have to reimplement "who should see
my status" ourselves from the contact list + `GetStatusPrivacy` rather than call a ready-made
helper. No direct `SetStatusPrivacy`-equivalent was found in this vendored version either — worth
a closer look before committing to a scope.
UI: this is the real cost. WhatsApp's Status is a fundamentally different interaction model —
full-screen story viewer, progress-bar segments, camera capture flow, 24h auto-expiry, "who
viewed" tracking — none of which exists anywhere in the current Messaging app. This is closer to
building a small standalone feature/app than extending an existing screen.

### Contacts: phone lookup & business profiles — S (each)
`IsOnWhatsApp(ctx, phones []string)` and `GetBusinessProfile(ctx, jid)` are both already exported,
single, direct calls — no protocol work at all. Phone lookup wires into the "start new
chat"/contact-add flow (validate before creating a thread — small, contained change). Business
profile data slots into the existing **adaptive Contact Detail popup**
(`contact-detail-dialog-adaptive` — already designed to size-to-content for new field groups),
so it's mostly "add a field group," not new UI infrastructure. Cleanest, lowest-risk items on the
whole list.

### Presence: outgoing typing indicator — S
`SendChatPresence(ctx, jid, state types.ChatPresence, media)` already exists; we currently only
*consume* the incoming event (`handle_chat_presence` in `presence.go`) and never call the
outgoing equivalent. Needs: a debounce in the compose bar (composing-on-keystroke,
paused-after-idle-or-on-send) and a signal path from the compose UI down to the plugin. Contained,
well-understood addition — no new protocol concepts.

### Presence: real block/unblock — S-M
`UpdateBlocklist(ctx, jid, action events.BlocklistChangeAction)` already exists; today we only
call `GetBlocklist` (read-only, used to locally filter incoming messages/contacts —
`handler.go`/`bridge.go`). Needs a "Block/Unblock" action somewhere in the contact/conversation
overflow menu, plus reflecting blocked state in the UI (badge, disabled compose). Backend is a
single call; the work is the UI affordance and state reflection.

### Chat actions: archive / pin / mute / star — M-L
This was expected to be the hardest backend item (WhatsApp's archive/pin/mute/star are synced via
the **App State** protocol — encrypted LTHash-chained patches, historically one of the gnarlier
parts of any WhatsApp client implementation). In practice the vendored whatsmeow already ships
ready-made patch builders for all four: `appstate.BuildMute`, `BuildPin`, `BuildArchive`,
`BuildStar` (plus `BuildMarkChatAsRead`, `BuildSettingPushName`, `BuildDeleteChat`, `BuildLabelChat`
for free) — and sending one is a single call, `client.SendAppState(ctx, patch)`. So the Go-side
lift drops from "reimplement a sync protocol" to "call four existing builder functions." The
library's own `dispatchAppState`/`applyAppStatePatches` machinery already exists for consuming
patches that arrive from *other* linked devices (i.e., reflecting a mute set from the phone) —
this should mostly be "already wired for free" once the corresponding webOS-side event handler is
added, but that consumption path (which `events.*` type each patch dispatches, if any) hasn't been
verified against this app's event handler and should be checked before scoping.
UI is the bulk of the real work: swipe/menu actions per thread (mirroring the existing
Delete/React swipe pattern already in `ConversationList.js`), an "Archived" filter/section, pinned
threads sorting to the top, a per-message "star" toggle, and a "Starred Messages" view. Four
distinct affordances across two levels (thread, message) plus two new list views.

### Profile: push name / status text / own picture — S-M
`SetStatusMessage(ctx, msg)` exists directly (this *is* the WhatsApp "About" text, per its own
doc-comment). `SetGroupPhoto(ctx, jid, avatar)` is **generic on target JID** — the same call used
for group photos already works for the *own* profile picture (call it with the account's own JID);
no new whatsmeow code needed there at all. Push name specifically has a low-effort path too via
`appstate.BuildSettingPushName(name)` + `SendAppState` (same mechanism as chat actions above).
Needs one new "Edit Profile" screen (display name, about text, tap-to-change photo) — no such
screen exists today in the Accounts/WhatsApp validator UI, but it's a single focused form, not a
flow.

### Privacy settings & disappearing messages — M
`GetPrivacySettings`/`SetPrivacySetting(ctx, name, value)` already exist as direct calls
(presumably covering last-seen, profile-photo, about, status, read-receipts, groups-add — see
`types.PrivacySettingType` for the actual enumerated set). `SetDisappearingTimer(ctx, chat,
duration, settingTS)` and `SetDefaultDisappearingTimer(ctx, duration)` **also already exist
directly** — no need to hand-construct a `ProtocolMessage` as might be assumed; this is
meaningfully simpler than the `message-expiration` account-option workaround already sitting
unused in `send_message.go` (`GOWHATSAPP_EXPIRATION_OPTION` — never exposed in any webOS UI).
The one genuinely new piece of infrastructure: **disappearing messages only matter if expired
messages actually get removed locally** — WhatsApp servers don't retroactively purge already-
synced copies, so this needs a local timer/purge job against `immessage` rows, which doesn't
exist anywhere in this codebase today. That purge mechanism, not the protocol calls, is the
long pole here.

---

## Suggested prioritization

**Done since this doc was first written** (see "Recently closed" above): the rich message types —
location, contact/vCard, delete-for-everyone, events, sticker send, status *receive*, and poll
display **+ voting**. These were the cheapest remaining wins: all receive-side except sticker send
and poll voting, and all riding message plumbing that already existed.

**Quick wins** (small, contained, no new UI paradigms) — do these next:
IsOnWhatsApp lookup, business profile display, outgoing typing indicator, block/unblock action,
own profile (name/status/photo), GIF send.

**Medium lifts** (backend mostly solved, meaningful but bounded new UI):
newsletter creation, chat actions (archive/pin/mute/star), privacy settings + disappearing
messages (incl. the local purge job), basic group create/admin/invite, communities (rides the
existing Servers/Rooms `imserver`/`imchannel` infrastructure — see correction above).

**Large, architecture-touching** (save for last, or scope as its own mini-project):
status **posting** — receiving is done, but posting your own needs a genuinely new full-screen UI
paradigm (story viewer, capture flow, 24h expiry, view tracking) with no existing analog in the
app. This is the one item on the whole list that's closer to building a new feature than extending
an existing one.
