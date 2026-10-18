/*
 * Teams Plugin for libpurple/Pidgin - NGC (NextGenCalling) voice calling.
 * webOS Synergy Revival.
 *
 * Microsoft Teams 1:1 voice calls use "NGC" (NextGenCalling / SkypeNgc), the legacy
 * Skype media stack Teams inherited - NOT browser WebRTC. An incoming call arrives as
 * a Trouter notification on /NGCallManagerWin (or /SkypeSpacesWeb) carrying:
 *   - mediaContent.blob : an "application/sdp-ngc-0.5" SDP offer (RTP/SAVP, SDES-SRTP)
 *   - udpKey.sessionKey : the SRTP master keying material (base64; RFC 3711 AES-CM)
 *   - udpKey.ticket     : the MRAS token that authenticates to the MS-TURN media relay
 *   - links.udpTransport: udp://<relay-ip>:3478/   (the MS-TURN relay)
 *   - links.{attach,mediaAnswer("cc://ma"),progress,reject} : the HTTP control plane
 *
 * This module: (1) CAPTURES the full raw notification to a log so the exact SDP dialect,
 * codec list and key placement can be confirmed from a real call; (2) parses it into a
 * TeamsCall; (3) drives the call control plane (answer/reject/hangup/dial) over the
 * links; and (4) hands the media parameters to the separate media engine (teams_media,
 * a fork of the on-device-proven Signal gst-1.20 nice+srtp+alsa engine).
 *
 * The stock webOS Phone app drives this via the LS2 bridge (teams_call_luna).
 */

#ifndef TEAMS_CALLING_H
#define TEAMS_CALLING_H

#include "libteams.h"
#include <json-glib/json-glib.h>

typedef enum {
	TEAMS_CALL_IDLE = 0,
	TEAMS_CALL_INCOMING,
	TEAMS_CALL_DIALING,
	TEAMS_CALL_ACTIVE,
	TEAMS_CALL_DISCONNECTED
} TeamsCallState;

typedef struct _TeamsCall {
	TeamsAccount *sa;

	gchar *call_id;
	gchar *peer_mri;    /* the OTHER party's id, e.g. "8:orgid:..." (prefix-stripped for display) */
	gchar *peer_name;   /* resolved display name, may be NULL */
	gboolean is_outgoing;
	TeamsCallState state;

	/* --- media offer (callNotification.mediaContent) --- */
	gchar *sdp_offer;       /* the raw application/sdp-ngc-0.5 blob (plaintext SDP) */
	gchar *media_leg_id;

	/* --- keying / relay (callNotification.udpKey) --- */
	gchar *session_key_b64; /* SRTP master key||salt, base64 (RFC 3711 AES_CM_128_HMAC_SHA1_80) */
	gchar *ticket;          /* MRAS ticket for MS-TURN relay auth */

	/* --- control-plane links (callNotification.links) --- */
	gchar *link_attach;
	gchar *link_media_answer;  /* "cc://ma" - where the SDP answer is posted */
	gchar *link_progress;
	gchar *link_reject;
	gchar *udp_transport;      /* "udp://<ip>:3478/" MS-TURN relay */
	gchar *conversation_controller; /* conversationInvitation.conversationController */

	/* --- answer flow (incoming): the media controller answer is a two-step handshake -
	 * POST attach (offer's link_attach) -> parse callInvitation.links.acceptance from the
	 * response -> POST accept (callAcceptance.mediaContent.blob = our SDP answer). --- */
	gchar *our_answer_sdp;     /* the SDP answer our media engine produced (held across attach->accept) */
	gchar *our_endpoint_id;    /* our calling endpoint id (= sa->endpoint), used in acceptedBy */
	gchar *our_participant_id; /* our participantId (generated), reused in attach join + acceptedBy */
	gchar *callagent_id;       /* generated callAgent id for our control paths (end link, etc.) */

	/* Video: TRUE once video is actually negotiated active for this call (either present in the
	 * initial offer/answer, or added later via a mid-call renegotiation push - see
	 * teams_calling_handle_renegotiation in teams_calling.c). Drives both what SDP we build and
	 * teams_calling_set_video_cb()'s notifications (which teams_call_luna.c uses to open/close the
	 * clonk video bridge). NOT set for an outgoing dial-with-video request until the callee's
	 * answer actually confirms it - see TeamsMediaProc.want_video in teams_calling.c. */
	gboolean video_active;

	/* Video intent, known from the moment the call starts (unlike video_active above, which is
	 * confirmed-late: only true once actually negotiated). Incoming: whether the initial offer's
	 * SDP has a non-inactive m=video line, checked at parse_call_notification() time. Outgoing:
	 * the dial()'s own video param, set at call creation. This is what the webOS UI's video
	 * marker/switch-to-video affordance should be driven by - using video_active for this (as
	 * this file originally did, mirroring an equivalent bug already found and fixed in the
	 * Telegram/WhatsApp mediators) means an incoming ring or an outgoing dial never shows a video
	 * marker, since video_active only flips true well after answer/negotiation completes. */
	gboolean video_requested;

	/* CAPTURED LIVE (2026-08-01): TRUE when media_send_answer() has decided the call starts with
	 * video active (offer already wanted it) but has deliberately NOT yet fired g_video_cb() -
	 * doing so synchronously before the attach POST blocked the event loop long enough (bringing
	 * up the local Clonk camera pipeline is not cheap) that the attach request itself died with
	 * a bare connection failure (code 0, no response at all) - Teams/the peer never even saw an
	 * answer, so the call sat on "Calling..." forever. attach_resp_cb() fires the deferred
	 * callback once the attach round-trip has actually completed. */
	gboolean video_cb_pending;
} TeamsCall;

/* Called from teams_trouter.c's /NGCallManagerWin handler with the decoded callNotification
 * container (body_obj). Captures the raw notification, parses it, tracks call state and
 * notifies the Phone-app bridge. request_url distinguishes the notification kind
 * (/NGCallManagerWin incoming/outgoing, /end, /rosterUpdate). */
void teams_calling_handle_trouter(TeamsAccount *sa, JsonObject *body_obj, const gchar *request_url);

/* The LS2 bridge (teams_call_luna) registers this to receive call-state transitions to push
 * to the stock Phone app's CallSynergizer. state is one of the CallSynergizer strings:
 * "incoming"/"dialing"/"active"/"disconnected"/"" (idle). Kept as a hook (rather than a direct
 * call) so this module compiles/links without luna-service2 present. */
typedef void (*TeamsCallStateCb)(TeamsAccount *sa, const char *state, const char *peerAddress,
                                 const char *peerName, gboolean isOutgoing, const char *cause,
                                 gboolean isVideo);
void teams_calling_set_state_cb(TeamsCallStateCb cb);

/* Phone-app-facing actions (called by the LS2 bridge). Return FALSE if no such call / not
 * possible. answer/dial spin up the media engine; reject/hangup tear down + POST control.
 * dial's video param requests a video m-line in our offer (see TeamsMediaProc.want_video in
 * teams_calling.c) - whether it actually goes active depends on the callee's answer. */
gboolean teams_calling_answer(TeamsAccount *sa);
gboolean teams_calling_reject(TeamsAccount *sa);
gboolean teams_calling_hangup(TeamsAccount *sa);
gboolean teams_calling_dial(TeamsAccount *sa, const gchar *peer_mri, gboolean video);

/* The LS2 bridge registers this to learn when TeamsCall.video_active flips, in either direction
 * (an inbound renegotiation, video already active in the initial offer/answer, or the callee's
 * answer to an outgoing dial-with-video request). Drives teams_call_luna.c's clonk video bridge
 * lifecycle (teams_call_luna_open_clonk/close_clonk), which calls voipkit_video_start/stop()
 * directly - voipkit.cpp lives in this same process/library, not a separate subprocess. */
typedef void (*TeamsCallVideoCb)(TeamsAccount *sa, gboolean active);
void teams_calling_set_video_cb(TeamsCallVideoCb cb);

/* The account's current call (or NULL). */
TeamsCall *teams_calling_current(TeamsAccount *sa);

/* On-device trace to /media/internal/teams-call.log (purple_debug doesn't reach the webOS
 * system log). printf-style. */
void teams_call_log(const char *fmt, ...);

#endif /* TEAMS_CALLING_H */
