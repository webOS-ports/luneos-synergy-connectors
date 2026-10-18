/*
 * Teams Plugin for libpurple/Pidgin - NGC (NextGenCalling) voice calling.
 * webOS Synergy Revival.  See teams_calling.h for the protocol overview.
 *
 * SCOPE (this file, initial drop):
 *   - CAPTURE: dump every raw NGC call notification (SDP blob, udpKey, links, codecs) to
 *     /media/internal/teams-call-capture.log  -> the ground truth for finishing media.
 *   - PARSE:   turn the callNotification into a TeamsCall (peer, sdp, key, ticket, links).
 *   - STATE:   drive incoming/dialing/active/disconnected and notify the Phone-app bridge.
 *   - CONTROL: reject (POST to the reject link) works today; answer posts the SDP answer to
 *     the mediaAnswer/attach link once the media engine produces one; dial (outgoing) is a
 *     documented stub (the outgoing-call control flow needs an outgoing-call capture).
 *   - MEDIA:   handed to the out-of-process teams_media engine; traced stubs until the
 *     capture confirms codec (SILK/Satin/G.722) + MS-TURN ticket auth.
 *
 * Everything marked "CONFIRM WITH CAPTURE" is a best-effort guess from Eion Robb's
 * reverse-engineered comments that a single real call will pin down.
 */

#include "teams_calling.h"
#include "teams_connection.h"
#include "teams_util.h"

#include <purple.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <time.h>
#include <unistd.h>

#define TEAMS_CALL_LOG      "/media/internal/teams-call.log"
#define TEAMS_CALL_CAPTURE  "/media/internal/teams-call-capture.log"

/* ------------------------------------------------------------------ logging */

void
teams_call_log(const char *fmt, ...)
{
	FILE *f = fopen(TEAMS_CALL_LOG, "a");
	va_list ap;
	time_t now = time(NULL);
	char ts[32];
	struct tm *tm = localtime(&now);
	strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", tm);

	if (f) {
		fprintf(f, "%s ", ts);
		va_start(ap, fmt);
		vfprintf(f, fmt, ap);
		va_end(ap);
		fputc('\n', f);
		fclose(f);
	}
	/* also to purple debug for the desktop build */
	{
		char buf[1024];
		va_start(ap, fmt);
		vsnprintf(buf, sizeof(buf), fmt, ap);
		va_end(ap);
		purple_debug_info("teams", "call: %s\n", buf);
	}
}

/* ------------------------------------------------------- NULL-safe JSON getters
 * NGC notifications are reverse-engineered and fields drop in/out between tenants;
 * json-glib's own getters assert on a missing/typed-wrong member, so guard everything. */

static const gchar *
sget(JsonObject *o, const gchar *k)
{
	JsonNode *n;
	if (!o || !json_object_has_member(o, k)) return NULL;
	n = json_object_get_member(o, k);
	if (n && JSON_NODE_HOLDS_VALUE(n)) return json_node_get_string(n);
	return NULL;
}

static JsonObject *
oget(JsonObject *o, const gchar *k)
{
	JsonNode *n;
	if (!o || !json_object_has_member(o, k)) return NULL;
	n = json_object_get_member(o, k);
	if (n && JSON_NODE_HOLDS_OBJECT(n)) return json_node_get_object(n);
	return NULL;
}

/* --------------------------------------------------------- state / media hooks */

static TeamsCallStateCb g_state_cb = NULL;

void
teams_calling_set_state_cb(TeamsCallStateCb cb)
{
	g_state_cb = cb;
}

/* ---- media engine integration (teams_media, out-of-process) -----------------------------
 * On answer we: parse the offer SDP (peer ice-ufrag/pwd, a=crypto GCM key, opus PT, candidates),
 * spawn `teams_media --answer`, feed it START + the peer candidates, read back OUR ice creds +
 * TX SRTP key + local candidates, build an SDP answer and POST it to links.attach. teams_media
 * does the ICE + SRTP + Opus <-> ALSA voip. FIRST-ATTEMPT wiring - the exact answer-SDP shape and
 * the POST body/auth need on-device iteration (heavily logged). */
#define TEAMS_MEDIA_BIN "/media/internal/teams_media"

typedef struct {
	TeamsCall  *call;
	GPid        pid;
	int         in_fd;         /* -> child stdin */
	GIOChannel *out_ch;        /* <- child stdout */
	guint       out_watch;
	gchar      *our_ufrag, *our_pwd, *our_txkey;
	GString    *our_cands;     /* accumulated "candidate:..." lines, one per line */
	gboolean    ready, answered;
	guint       answer_timer;
	gboolean    is_caller;      /* TRUE = outgoing (we build+POST the offer via cpconv) */
	gchar      *callagent_id;   /* our client-generated callAgent uuid (outgoing) */

	/* want_video is the OUTGOING request (dial-with-video), read by media_send_offer() to decide
	 * whether to add a video m-line - NOT the same as call->video_active, which only goes TRUE once
	 * the callee's answer actually confirms it (teams_calling_handle_media_answer). The skypekit/
	 * clonk video bridge itself lives in this same process (teams_call_luna.c calls it directly,
	 * same as Telegram) - no cross-process ack needed here anymore. */
	gboolean          want_video;

	/* Set by teams_calling_handle_renegotiation() right after it sends a RESTART to the engine;
	 * consumed by media_on_output() when the engine's matching RESTARTED line arrives. We can't
	 * build+POST the renegotiation answer synchronously in the same call as the RESTART write -
	 * nice_agent_restart_stream() regenerates OUR OWN local ice-ufrag/pwd (see teams_media.c's
	 * RESTART handler), and build_answer_sdp() needs those NEW values, which only reach us
	 * asynchronously over the pipe (the same UFRAG/PWD lines media_on_output already parses for
	 * the initial START). Answering immediately would race and very likely still send the STALE
	 * pre-restart local creds. */
	gchar            *pending_reneg_answer_link;

	/* Last remote ice-ufrag we actually applied via RESTART. Teams' trouter redelivers the same
	 * renegotiation push (observed live: 3 identical-ufrag frames within ~2s of each other) - see
	 * teams_calling_handle_renegotiation()'s dedup check. Without this, every redelivery tears
	 * down and rebuilds the ICE agent, so no single ICE session ever gets enough uninterrupted
	 * time to finish connectivity checks before being restarted again. */
	gchar            *last_restarted_ufrag;
} TeamsMediaProc;

static TeamsCallVideoCb g_video_cb = NULL;

void
teams_calling_set_video_cb(TeamsCallVideoCb cb)
{
	g_video_cb = cb;
}

/* POST JSON to a flightproxy/calling URL WITH the x-skypetoken auth header (teams_post_or_get does
 * not add it for api.flightproxy.skype.com -> "Anonymous access is not allowed" 403). Logs the
 * response. Used for both the cpconv create (offer) and the mediaAnswer/attach POST (answer). */
static void
flightproxy_resp_cb(PurpleHttpConnection *hc, PurpleHttpResponse *resp, gpointer u)
{
	int code; size_t len = 0; const gchar *data;
	(void) hc; (void) u;
	code = purple_http_response_get_code(resp);
	data = purple_http_response_get_data(resp, &len);
	if (code <= 0)
		teams_call_log("FLIGHTPROXY resp code=%d err=%s", code,
		               purple_http_response_get_error(resp) ? purple_http_response_get_error(resp) : "(none)");
	else
		teams_call_log("FLIGHTPROXY resp code=%d body=%.300s", code, data ? data : "(none)");
}

/* Teams calling client identity (matches teams.live.com's SkypeSpacesWeb TFL client string). */
#define TEAMS_SKYPE_CLIENT "SkypeSpaces/1415/26070217343/os=linux; osVer=undefined; " \
	"deviceType=computer; browser=chrome; browserVer=150.0.0.0/TsCallingVersion=2026.24.01.6/Ovb=0"

/* Full form: POST with the calling headers + a caller-supplied response callback and user data.
 * cb may be NULL (falls back to flightproxy_resp_cb which just logs). */
static void
flightproxy_post_cb(TeamsAccount *sa, const gchar *url, const gchar *body,
                    PurpleHttpCallback cb, gpointer user)
{
	gchar *chain = purple_uuid_random(), *msgid = purple_uuid_random();
	PurpleHttpRequest *req = purple_http_request_new(url);
	purple_http_request_set_method(req, "POST");
	purple_http_request_set_keepalive_pool(req, sa->keepalive_pool);
	purple_http_request_header_set(req, "Content-Type", "application/json");
	purple_http_request_header_set(req, "X-Skypetoken", sa->skype_token);
	/* calling backend rejects requests without a client identity as 400 Bad Request */
	purple_http_request_header_set(req, "X-Microsoft-Skype-Client", TEAMS_SKYPE_CLIENT);
	purple_http_request_header_set(req, "X-Microsoft-Skype-Chain-Id", chain);
	purple_http_request_header_set(req, "X-Microsoft-Skype-Message-Id", msgid);
	purple_http_request_header_set(req, "ms-teams-ring", "general");
	purple_http_request_set_contents(req, body, strlen(body));
	purple_http_request(sa->pc, req, cb ? cb : flightproxy_resp_cb, user);
	purple_http_request_unref(req);
	g_free(chain); g_free(msgid);
}

static void
flightproxy_post(TeamsAccount *sa, const gchar *url, const gchar *body)
{
	flightproxy_post_cb(sa, url, body, NULL, NULL);
}

/* DELETE (leave/end) a conversation-controller resource - same auth headers as flightproxy_post_cb,
 * just a different HTTP method and no body. CONFIRM WITH CAPTURE: no HAR of an actual client-
 * initiated hangup exists yet; DELETE on the "conv/<id>" REST resource matches the conversation-
 * service's naming (leaving/ending a conversation) and is the best-effort guess used by
 * teams_calling_hangup() for an ACTIVE call - untested against a live backend. */
static void
flightproxy_delete(TeamsAccount *sa, const gchar *url)
{
	gchar *chain, *msgid;
	PurpleHttpRequest *req;
	if (!url) return;
	chain = purple_uuid_random(); msgid = purple_uuid_random();
	req = purple_http_request_new(url);
	purple_http_request_set_method(req, "DELETE");
	purple_http_request_set_keepalive_pool(req, sa->keepalive_pool);
	purple_http_request_header_set(req, "X-Skypetoken", sa->skype_token);
	purple_http_request_header_set(req, "X-Microsoft-Skype-Client", TEAMS_SKYPE_CLIENT);
	purple_http_request_header_set(req, "X-Microsoft-Skype-Chain-Id", chain);
	purple_http_request_header_set(req, "X-Microsoft-Skype-Message-Id", msgid);
	purple_http_request(sa->pc, req, flightproxy_resp_cb, NULL);
	purple_http_request_unref(req);
	g_free(chain); g_free(msgid);
}

/* build a callAgent trouter control path: <surl>callAgent/<agent>/<hash8>/<kind>/<name>/ */
static gchar *
callagent_path(TeamsCall *call, const char *agent, const char *kind, const char *name)
{
	gchar *hash = g_strdup_printf("%08x", g_random_int());
	gchar *surl = call->sa->trouter_surl ? call->sa->trouter_surl : "";
	gchar *p = g_strdup_printf("%scallAgent/%s/%s/%s/%s/", surl, agent, hash, kind, name);
	g_free(hash);
	return p;
}

static TeamsMediaProc *g_mproc;

/* return the value after "a=<prefix>:" on the first matching line (newly-allocated), or NULL */
static gchar *
sdp_line_val(const char *sdp, const char *prefix)
{
	gchar **lines, *ret = NULL;
	int i;
	if (!sdp) return NULL;
	lines = g_strsplit(sdp, "\n", -1);
	for (i = 0; lines[i]; i++) {
		gchar *l = g_strstrip(lines[i]);
		if (g_str_has_prefix(l, prefix)) { ret = g_strdup(l + strlen(prefix)); break; }
	}
	g_strfreev(lines);
	return ret;
}

/* the AEAD_AES_256_GCM inline key (base64, up to the '|') from the offer's a=crypto lines */
static gchar *
sdp_gcm_key(const char *sdp)
{
	gchar **lines; int i; gchar *ret = NULL;
	if (!sdp) return NULL;
	lines = g_strsplit(sdp, "\n", -1);
	for (i = 0; lines[i]; i++) {
		gchar *l = g_strstrip(lines[i]);
		if (strstr(l, "AEAD_AES_256_GCM") && strstr(l, "inline:")) {
			gchar *k = strstr(l, "inline:") + 7;
			gchar *bar = strchr(k, '|');
			ret = bar ? g_strndup(k, bar - k) : g_strdup(k);
			break;
		}
	}
	g_strfreev(lines);
	return ret;
}

/* Direction attribute ("sendrecv"/"recvonly"/"sendonly"/"inactive") from the FIRST m=video
 * section only - sdp_line_val() alone would find the audio section's a=sendrecv first, since
 * it scans the whole SDP and audio comes before video in every SDP this codebase builds/parses.
 * Returns NULL if the SDP has no m=video line at all (no video offered/negotiated). */
static gchar *
sdp_video_direction(const char *sdp)
{
	gchar **lines; int i; gboolean in_video = FALSE, found_video = FALSE; gchar *ret = NULL;
	if (!sdp) return NULL;
	lines = g_strsplit(sdp, "\n", -1);
	for (i = 0; lines[i]; i++) {
		gchar *l = g_strstrip(lines[i]);
		if (g_str_has_prefix(l, "m=video")) { in_video = TRUE; found_video = TRUE; continue; }
		if (l[0] == 'm' && l[1] == '=') { if (in_video) break; continue; }
		if (!in_video) continue;
		if (!strcmp(l, "a=sendrecv") || !strcmp(l, "a=recvonly") ||
		    !strcmp(l, "a=sendonly") || !strcmp(l, "a=inactive")) {
			ret = g_strdup(l + 2); break;
		}
	}
	g_strfreev(lines);
	/* RFC 3264 3.7: an m-line with no explicit direction attribute defaults to sendrecv - it does
	 * NOT mean "no video". CAPTURED LIVE (2026-08-05): real Android/Teams mediaRenegotiation pushes
	 * routinely omit this line despite fully negotiating H.264 codecs/ICE/crypto for the video
	 * m-line (callModalities explicitly listing "video"), which every caller of this function was
	 * silently reading as "peer doesn't want video" - call->video_active never flipped, our video
	 * RTP bridge never activated, while the peer believed video was live and kept escalating until
	 * it gave up with MediaError/410. Only fall back to NULL when there's truly no m=video section. */
	if (!ret && found_video) ret = g_strdup("sendrecv");
	return ret;
}

static void teams_calling_post_answer(TeamsCall *call, const char *answer_sdp);
static void call_http_post(TeamsAccount *sa, const gchar *full_url, const gchar *body);

/* dump the exact SDP answer we send, for offline diffing against the web client's accepted answer */
static void
teams_calling_log_sdp(const char *sdp)
{
	g_file_set_contents("/media/internal/teams-answer.sdp", sdp ? sdp : "", -1, NULL);
}

static void answer_ok_cb(TeamsAccount *sa, JsonNode *node, gpointer u);
static void answer_err_cb(TeamsAccount *sa, const gchar *data, gssize len, gpointer u);

/* Build the SDP answer from our media params + the offer (SDES-GCM path; the offer supports both
 * SDES a=crypto and DTLS, and our engine keys via SDES). Shape mirrors the web client's accepted
 * answer: BUNDLE + mid:audio_0/video_1 + rtcp-mux + label, a=crypto instead of DTLS fingerprint.
 * CAPTURED LIVE (2026-08-01, rtcstats_dump from a real teams.live.com call - see
 * messaging/teams/calling/captures/): the video m-line's direction is ALWAYS a=sendrecv in every
 * one of a real client's answers, including the very first one before video is ever "on" and
 * across all 5 renegotiation rounds of a normal call - direction never toggles to a=inactive.
 * Actual video flow is controlled at the track/encoding level (whether H.264 RTP is actually being
 * sent), not by the SDP m-line direction. Gating this on call->video_active (mirroring the offer's
 * direction back to the peer instead of always sendrecv) is what the previous version of this
 * function did, and is the leading suspect for the MediaError-410 storm every call has hit: it's
 * simply not what Teams' backend expects to see. The offer/answer m-line-mirroring requirement
 * still means we must ALWAYS emit the m-line at all (or the peer rejects the whole answer,
 * FinalAnswerError 406/4122) - only the direction attribute's conditional was wrong.
 * Codec/fmtp/rtcp-fb values are the real ones from a captured live Teams video call (H264/90000
 * PT 107, rtx PT 99, packetization-mode=1, profile-level-id=42e01f). Shared by the initial answer
 * (media_send_answer, below) and any later mid-call renegotiation
 * (teams_calling_handle_renegotiation) - both reuse the SAME bundled ICE/crypto, only the
 * direction/content changes. Caller owns the returned GString. */
static GString *
build_answer_sdp(TeamsMediaProc *mp)
{
	GString *a;
	gchar *our_ip = NULL; int our_port = 3480;

	/* Derive our OWN connection address for c=/m= from the first UDP host candidate (NOT the offerer's
	 * relay IP - advertising the peer's address as ours confuses the NGC validator). */
	if (mp->our_cands) {
		gchar **cl = g_strsplit(mp->our_cands->str, "\n", -1); int i;
		for (i = 0; cl[i]; i++) {
			/* "candidate:<f> <comp> UDP <pri> <ip> <port> typ host ..." */
			if (strstr(cl[i], " UDP ") && strstr(cl[i], "typ host")) {
				gchar **t = g_strsplit(g_strstrip(cl[i]), " ", -1);
				if (t[0] && t[1] && t[2] && t[3] && t[4] && t[5]) {
					our_ip = g_strdup(t[4]); our_port = atoi(t[5]);
				}
				g_strfreev(t);
				break;
			}
		}
		g_strfreev(cl);
	}

	a = g_string_new("");
	g_string_append(a, "v=0\r\n");
	g_string_append_printf(a, "o=- %u 2 IN IP4 %s\r\n", g_random_int(), our_ip ? our_ip : "127.0.0.1");
	g_string_append(a, "s=-\r\n");
	g_string_append(a, "b=CT:4000\r\nt=0 0\r\n");
	g_string_append(a, "a=extmap-allow-mixed\r\n");
	g_string_append(a, "a=msid-semantic: WMS *\r\n");
	g_string_append(a, "a=group:BUNDLE audio_0 video_1\r\n");
	g_string_append_printf(a, "m=audio %d RTP/SAVP 102 9 0 8 101\r\n", our_port);
	g_string_append_printf(a, "c=IN IP4 %s\r\n", our_ip ? our_ip : "127.0.0.1");
	g_string_append(a, "a=rtpmap:102 opus/48000/2\r\n");
	g_string_append(a, "a=rtpmap:9 G722/8000\r\n");
	g_string_append(a, "a=rtpmap:0 PCMU/8000\r\n");
	g_string_append(a, "a=rtpmap:8 PCMA/8000\r\n");
	g_string_append(a, "a=rtpmap:101 telephone-event/8000\r\n");
	g_string_append(a, "a=fmtp:102 minptime=10;useinbandfec=1\r\n");
	g_string_append(a, "a=mid:audio_0\r\n");
	g_string_append(a, "a=sendrecv\r\n");
	g_string_append_printf(a, "a=ice-ufrag:%s\r\n", mp->our_ufrag);
	g_string_append_printf(a, "a=ice-pwd:%s\r\n", mp->our_pwd);
	g_string_append_printf(a, "a=crypto:4 AEAD_AES_256_GCM inline:%s|2^31\r\n", mp->our_txkey);
	/* Emit UDP candidates only - Teams' NGC parser can reject the whole answer over ICE-TCP lines. */
	if (mp->our_cands) {
		gchar **cl = g_strsplit(mp->our_cands->str, "\n", -1); int i;
		for (i = 0; cl[i]; i++)
			if (cl[i][0] && strstr(cl[i], " UDP ")) g_string_append_printf(a, "a=%s\r\n", cl[i]);
		g_strfreev(cl);
	}
	g_string_append(a, "a=ice-options:trickle\r\n");
	g_string_append(a, "a=rtcp-mux\r\n");
	g_string_append(a, "a=label:main-audio\r\n");

	g_string_append_printf(a, "m=video %d RTP/SAVP 107 99\r\n", our_port);
	g_string_append_printf(a, "c=IN IP4 %s\r\n", our_ip ? our_ip : "127.0.0.1");
	g_string_append(a, "a=rtpmap:107 H264/90000\r\n");
	g_string_append(a, "a=rtpmap:99 rtx/90000\r\n");
	g_string_append(a, "a=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;"
	                    "profile-level-id=42e01f;max-fs=8160;max-mbps=244800;max-fps=3000\r\n");
	g_string_append(a, "a=fmtp:99 apt=107\r\n");
	g_string_append(a, "a=rtcp-fb:107 goog-remb\r\n");
	g_string_append(a, "a=rtcp-fb:107 transport-cc\r\n");
	g_string_append(a, "a=rtcp-fb:107 nack\r\n");
	g_string_append(a, "a=rtcp-fb:107 nack pli\r\n");
	g_string_append(a, "a=mid:video_1\r\n");
	g_string_append(a, "a=sendrecv\r\n");   /* always - see this function's header comment */
	g_string_append_printf(a, "a=ice-ufrag:%s\r\n", mp->our_ufrag);
	g_string_append_printf(a, "a=ice-pwd:%s\r\n", mp->our_pwd);
	g_string_append_printf(a, "a=crypto:4 AEAD_AES_256_GCM inline:%s|2^31\r\n", mp->our_txkey);
	g_string_append(a, "a=rtcp-mux\r\n");
	g_string_append(a, "a=rtcp-rsize\r\n");
	g_string_append(a, "a=label:main-video\r\n");

	g_free(our_ip);
	return a;
}

/* Kicks off the two-step media-controller handshake (attach -> parse acceptance link -> accept
 * w/ SDP) using build_answer_sdp() above. If the peer's OFFER already has an active m=video line,
 * activates video from this very first answer rather than waiting for a later renegotiation. */
static void
media_send_answer(TeamsMediaProc *mp)
{
	TeamsCall *call = mp->call;
	GString *a;

	if (mp->answered || !mp->our_ufrag || !mp->our_pwd || !mp->our_txkey) return;
	mp->answered = TRUE;

	{ gchar *dir = sdp_video_direction(call->sdp_offer);
	  if (dir && strcmp(dir, "inactive") != 0 && !call->video_active) {
	      call->video_active = TRUE;   /* needed now - build_answer_sdp() below reads it */
	      teams_call_log("answer: offer already wants video (a=%s), activating from the start", dir);
	      /* Defer the actual g_video_cb() (Clonk camera pipeline bring-up) until attach_resp_cb()
	       * confirms the attach POST succeeded - see video_cb_pending's comment in teams_calling.h. */
	      call->video_cb_pending = TRUE;
	  }
	  g_free(dir); }

	a = build_answer_sdp(mp);

	g_free(call->our_answer_sdp);
	call->our_answer_sdp = g_strdup(a->str);
	teams_call_log("ANSWER SDP built (%d bytes, video=%d) - starting attach->accept handshake",
	               (int) a->len, call->video_active);
	teams_calling_log_sdp(call->our_answer_sdp);   /* dump full answer for offline diffing */
	teams_calling_post_answer(call, a->str);   /* now = attach then accept */
	g_string_free(a, TRUE);
}

/* CALLER: build the OFFER SDP from our media params + POST the cpconv create request to place the
 * call (mirrors the teams.live.com web client's api/v2/cpconv flow). FIRST-ATTEMPT. */
static void
media_send_offer(TeamsMediaProc *mp)
{
	TeamsCall *call = mp->call;
	const char *agent = mp->callagent_id;
	GString *sdp, *body;
	gchar *offer_esc, *legid, *epid, *pid, *to_pid;
	int i;
	if (mp->answered || !mp->our_ufrag || !mp->our_pwd || !mp->our_txkey) return;
	mp->answered = TRUE;

	/* Derive our OWN connection address for c=/m= from the first UDP host candidate, same as
	 * build_answer_sdp() - a hardcoded 0.0.0.0:3480 placeholder (the previous version of this
	 * offer) is not what a real client sends. */
	gchar *our_ip = NULL; int our_port = 3480;
	if (mp->our_cands) {
		gchar **cl = g_strsplit(mp->our_cands->str, "\n", -1); int j;
		for (j = 0; cl[j]; j++) {
			if (strstr(cl[j], " UDP ") && strstr(cl[j], "typ host")) {
				gchar **t = g_strsplit(g_strstrip(cl[j]), " ", -1);
				if (t[0] && t[1] && t[2] && t[3] && t[4] && t[5]) {
					our_ip = g_strdup(t[4]); our_port = atoi(t[5]);
				}
				g_strfreev(t);
				break;
			}
		}
		g_strfreev(cl);
	}

	sdp = g_string_new(mp->want_video
		? "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nb=CT:4000\r\nt=0 0\r\na=group:BUNDLE 0 1\r\n"
		: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nb=CT:4000\r\nt=0 0\r\na=group:BUNDLE 0\r\n");
	g_string_append_printf(sdp, "m=audio %d RTP/SAVP 102 9 0 8\r\n", our_port);
	g_string_append_printf(sdp, "c=IN IP4 %s\r\n", our_ip ? our_ip : "0.0.0.0");
	g_string_append(sdp, "a=rtpmap:102 opus/48000/2\r\na=rtpmap:9 G722/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\n");
	g_string_append(sdp, "a=fmtp:102 minptime=10;useinbandfec=1\r\na=rtcp-mux\r\na=mid:0\r\na=sendrecv\r\na=label:main-audio\r\n");
	g_string_append_printf(sdp, "a=ice-ufrag:%s\r\na=ice-pwd:%s\r\n", mp->our_ufrag, mp->our_pwd);
	g_string_append_printf(sdp, "a=crypto:4 AEAD_AES_256_GCM inline:%s|2^31\r\n", mp->our_txkey);
	/* Emit UDP candidates only - same fix as build_answer_sdp(): Teams' NGC parser can reject the
	 * WHOLE blob over ICE-TCP lines. This offer previously included every candidate unfiltered
	 * (TCP included), which is the leading suspect for outgoing calls consistently getting
	 * "attached" (rung, answered) but then timing out with no signaling ever coming back from the
	 * callee (code 408) - matches a parser silently rejecting our SDP wholesale, not a real
	 * connectivity failure. */
	if (mp->our_cands) { gchar **cl = g_strsplit(mp->our_cands->str, "\n", -1);
		for (i = 0; cl[i]; i++) if (cl[i][0] && strstr(cl[i], " UDP ")) g_string_append_printf(sdp, "a=%s\r\n", cl[i]);
		g_strfreev(cl); }
	g_string_append(sdp, "a=ice-options:trickle\r\n");

	/* Outgoing video (dial-with-video): add a second m-line matching build_answer_sdp's video
	 * codec shape - no HAR reference for an outgoing-with-video offer (only incoming was
	 * captured), so this is first-attempt, same as the rest of this offer's own documented
	 * "CONFIRM WITH CAPTURE" status. call->video_active only goes TRUE once the callee's answer
	 * confirms it (teams_calling_handle_media_answer) - this just reflects our OWN request. */
	if (mp->want_video) {
		g_string_append_printf(sdp, "m=video %d RTP/SAVP 107 99\r\n", our_port);
		g_string_append_printf(sdp, "c=IN IP4 %s\r\n", our_ip ? our_ip : "0.0.0.0");
		g_string_append(sdp, "a=rtpmap:107 H264/90000\r\na=rtpmap:99 rtx/90000\r\n");
		g_string_append(sdp, "a=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;"
		                     "profile-level-id=42e01f;max-fs=8160;max-mbps=244800;max-fps=3000\r\n");
		g_string_append(sdp, "a=fmtp:99 apt=107\r\n");
		g_string_append(sdp, "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\n");
		g_string_append(sdp, "a=rtcp-fb:107 nack\r\na=rtcp-fb:107 nack pli\r\n");
		g_string_append(sdp, "a=rtcp-mux\r\na=rtcp-rsize\r\na=mid:1\r\na=sendrecv\r\na=label:main-video\r\n");
		g_string_append_printf(sdp, "a=ice-ufrag:%s\r\na=ice-pwd:%s\r\n", mp->our_ufrag, mp->our_pwd);
		g_string_append_printf(sdp, "a=crypto:4 AEAD_AES_256_GCM inline:%s|2^31\r\n", mp->our_txkey);
	}
	g_free(our_ip);

	/* Dump the exact bytes we sent, mirroring build_answer_sdp()'s teams-answer.sdp - lets a real
	 * test call be checked for whether the video m-line actually went out as intended, instead of
	 * inferring it from the want_video bool + byte count alone. */
	g_file_set_contents("/media/internal/teams-offer.sdp", sdp->str, -1, NULL);

	offer_esc = g_strescape(sdp->str, "");
	legid = g_strdup_printf("%08X%08X%08X%08X", g_random_int(), g_random_int(), g_random_int(), g_random_int());
	/* endpointId must be our REGISTERED calling endpoint so callAgent response frames route back. */
	epid = g_strdup(call->sa->endpoint ? call->sa->endpoint : "");
	pid = purple_uuid_random(); to_pid = purple_uuid_random();

/* append "name":"<callagent path>", to body for the given control kind (conversation|call) */
#define AGL(kind, nm) do { gchar *_p = callagent_path(call, agent, kind, nm); \
	g_string_append_printf(body, "\"%s\":\"%s\",", nm, _p); g_free(_p); } while (0)

	/* conversationRequest holds ONLY {type,subject,suppressDialout,applicationType,roster,properties,links};
	 * participants/callInvitation/endpoint* are TOP-LEVEL siblings of conversationRequest (not nested). */
	body = g_string_new("{\"conversationRequest\":{\"conversationType\":null,\"subject\":null,"
		"\"suppressDialout\":false,\"applicationType\":\"TFL\",");
	{ gchar *r = callagent_path(call, agent, "conversation", "rosterUpdate");
	  g_string_append_printf(body, "\"roster\":{\"type\":\"Delta\",\"rosterUpdate\":\"%s\"},", r); g_free(r); }
	g_string_append(body, "\"properties\":{\"allowConversationWithoutHost\":true,"
		"\"enableGroupCallEventMessages\":true,\"enableGroupCallUpgradeMessage\":false,"
		"\"enableGroupCallMeetupGeneration\":false},");
	g_string_append(body, "\"links\":{");
	AGL("conversation", "conversationEnd"); AGL("conversation", "conversationUpdate");
	AGL("conversation", "localParticipantUpdate"); AGL("conversation", "addParticipantSuccess");
	AGL("conversation", "addParticipantFailure"); AGL("conversation", "addModalitySuccess");
	AGL("conversation", "addModalityFailure"); AGL("conversation", "confirmUnmute");
	AGL("conversation", "receiveMessage");
	g_string_truncate(body, body->len - 1);   /* drop trailing comma */
	g_string_append(body, "}},");              /* close links, close conversationRequest */

	/* ---- top-level siblings ---- */
	g_string_append(body, "\"contentSharing\":null,");
	g_string_append_printf(body, "\"participants\":{\"from\":{\"id\":\"8:%s\",\"displayName\":\"webOS\","
		"\"endpointId\":\"%s\",\"participantId\":\"%s\",\"languageId\":\"en-us\"},",
		call->sa->username ? call->sa->username : "", epid, pid);
	g_string_append_printf(body, "\"to\":[{\"id\":\"%s\",\"participantId\":\"%s\"}]},",
		call->peer_mri ? call->peer_mri : "", to_pid);
	g_string_append(body, "\"capabilities\":null,\"endpointCapabilities\":73463,"
		"\"clientEndpointCapabilities\":42876960,\"endpointMetadata\":{\"holographicCapabilities\":3},"
		"\"groupContext\":null,\"groupChat\":null,\"meetingInfo\":null,\"meetingData\":null,"
		"\"endpointState\":{\"endpointStateSequenceNumber\":2,\"endpointProperties\":"
		"{\"additionalEndpointProperties\":{\"infoShownInReportMode\":\"FullInformation\"}}},");
	g_string_append_printf(body, "\"callInvitation\":{\"callModalities\":[%s],\"replaces\":null,"
		"\"transferor\":null,\"clientTransferContext\":null,\"customContext\":null,\"links\":{",
		mp->want_video ? "\"Audio\",\"Video\"" : "\"Audio\"");
	AGL("call", "progress"); AGL("call", "mediaAnswer"); AGL("call", "acceptance");
	AGL("call", "redirection"); AGL("call", "end");
	g_string_truncate(body, body->len - 1);
	g_string_append(body, "},\"clientContentForMediaController\":{");
	AGL("call", "controlVideoStreaming"); AGL("call", "csrcInfo");
	g_string_truncate(body, body->len - 1);
	g_string_append(body, "},\"pstnContent\":{\"emergencyCallCountry\":\"\","
		"\"platformName\":\"" TEAMS_SKYPE_CLIENT "\",\"publicApiCall\":false},\"emergencyContent\":null,");
	g_string_append_printf(body, "\"mediaContent\":{\"blob\":\"%s\",\"contentType\":\"application/sdp-ngc-1.0\","
		"\"requiredFeatures\":\"nonByPass\",\"clientLocation\":\"NL\",\"mediaLegId\":\"%s\"},",
		offer_esc, legid);
	g_string_append(body, "\"voicemailSettings\":{},\"locationContent\":null,"
		"\"networkContent\":null,\"areaContent\":null},");   /* close callInvitation */
	g_string_append(body, "\"debugContent\":{},\"participantPropertyBag\":{}}");   /* close outer */
#undef AGL

	teams_call_log("dial: OFFER built (%d bytes sdp, %d body), POSTing cpconv to place call to %s",
	               (int) sdp->len, (int) body->len, call->peer_mri ? call->peer_mri : "?");
	flightproxy_post(call->sa, "https://api.flightproxy.skype.com/api/v2/cpconv", body->str);

	g_string_free(sdp, TRUE); g_string_free(body, TRUE);
	g_free(offer_esc); g_free(legid); g_free(epid); g_free(pid); g_free(to_pid);
}

static gboolean
media_answer_timeout(gpointer user)
{
	TeamsMediaProc *mp = user;
	mp->answer_timer = 0;
	if (mp->is_caller) media_send_offer(mp);   /* outgoing: build+POST the offer (place the call) */
	else               media_send_answer(mp);  /* incoming: build+POST the answer */
	return G_SOURCE_REMOVE;
}

/* Build + POST a mid-call renegotiation answer using WHATEVER local ufrag/pwd/cands mp currently
 * holds. Shared by teams_calling_handle_renegotiation() (the no-restart-needed fallback, answered
 * immediately) and media_on_output()'s RESTARTED handler (answered only once the engine's fresh
 * post-restart local creds have actually arrived - see pending_reneg_answer_link's comment). */
static void
send_reneg_answer(TeamsMediaProc *mp, const gchar *answer_link)
{
	TeamsCall *call = mp->call;
	GString *a = build_answer_sdp(mp);
	gchar *esc = g_strescape(a->str, "");
	gchar *body = g_strdup_printf(
	    "{\"mediaAnswer\":{\"callModalities\":[%s],"
	      "\"mediaContent\":{\"blob\":\"%s\",\"contentType\":\"application/sdp-ngc-1.0\"}}}",
	    call->video_active ? "\"Audio\",\"Video\"" : "\"Audio\"", esc);
	teams_call_log("renegotiate: POSTing updated answer (%d bytes, video=%d) to %s",
	               (int) strlen(body), call->video_active, answer_link);
	flightproxy_post_cb(call->sa, answer_link, body, flightproxy_resp_cb, NULL);
	g_free(body); g_free(esc); g_string_free(a, TRUE);
}

/* read UFRAG/PWD/TXKEY/CAND/READY/RESTARTED/AUDIOD from teams_media's stdout */
static gboolean
media_on_output(GIOChannel *ch, GIOCondition cond, gpointer user)
{
	TeamsMediaProc *mp = user;
	gchar *line = NULL; gsize len = 0;
	if (cond & (G_IO_HUP | G_IO_ERR)) return FALSE;
	while (g_io_channel_read_line(ch, &line, &len, NULL, NULL) == G_IO_STATUS_NORMAL && line) {
		g_strchomp(line);
		if (g_str_has_prefix(line, "UFRAG ")) { g_free(mp->our_ufrag); mp->our_ufrag = g_strdup(line + 6); }
		else if (g_str_has_prefix(line, "PWD ")) { g_free(mp->our_pwd); mp->our_pwd = g_strdup(line + 4); }
		else if (g_str_has_prefix(line, "TXKEY ")) { g_free(mp->our_txkey); mp->our_txkey = g_strdup(line + 6); }
		else if (g_str_has_prefix(line, "CAND ")) { if (mp->our_cands) g_string_append_printf(mp->our_cands, "%s\n", line + 5); }
		else if (!strcmp(line, "RESTARTED")) {
			/* The RESTART's fresh UFRAG/PWD lines are always emitted BEFORE this marker (see
			 * teams_media.c), so mp->our_ufrag/our_pwd are already the new post-restart values
			 * by the time we get here - safe to answer now. */
			if (mp->pending_reneg_answer_link) {
				gchar *link = mp->pending_reneg_answer_link;
				mp->pending_reneg_answer_link = NULL;
				send_reneg_answer(mp, link);
				g_free(link);
			}
		}
		else if (g_str_has_prefix(line, "ERR ")) {
			teams_call_log("media engine ERR: %s", line + 4);
			if (mp->pending_reneg_answer_link) {
				teams_call_log("renegotiate: engine restart failed, dropping pending answer");
				g_free(mp->pending_reneg_answer_link);
				mp->pending_reneg_answer_link = NULL;
			}
		}
		else if (g_str_has_prefix(line, "READY")) {
			mp->ready = TRUE;
			teams_call_log("media engine READY; gathering candidates before answer");
			/* give ICE ~1.5s to gather candidates, then build + POST the answer */
			if (!mp->answer_timer) mp->answer_timer = g_timeout_add(1500, media_answer_timeout, mp);
		}
		else if (g_str_has_prefix(line, "AUDIOD ")) teams_call_log("media audiod %s", line + 7);
		g_free(line); line = NULL;
	}
	return TRUE;
}

static void
teams_media_start(TeamsCall *call)
{
	TeamsMediaProc *mp;
	gchar *ruf, *rpw, *rxkey, *pt_s = NULL;
	int pt = 102;
	gchar **lines; int i;
	const gchar *argv[] = { TEAMS_MEDIA_BIN, "--answer", NULL };
	/* teams_media needs the WPE gst runtime env (it runs patchelf'd to the wpe-glibc loader). The
	 * transport already has LD_LIBRARY_PATH from imwrap.sh; add the gst plugin path + registry. */
	const gchar *W = "/media/cryptofs/apps/usr/palm/applications/org.webosports.app.atlas/deviceroot/wpe-252/lib";
	gchar *gstenv = g_strdup_printf("GST_PLUGIN_SYSTEM_PATH_1_0=%s/gstreamer-1.0", W);
	gchar *regenv = g_strdup("GST_REGISTRY=/media/internal/teams-gst-registry.bin");
	gchar **envp = g_get_environ();
	GError *err = NULL;
	GPid pid; int in_fd = -1, out_fd = -1;

	ruf   = sdp_line_val(call->sdp_offer, "a=ice-ufrag:");
	rpw   = sdp_line_val(call->sdp_offer, "a=ice-pwd:");
	rxkey = sdp_gcm_key(call->sdp_offer);
	pt_s  = sdp_line_val(call->sdp_offer, "a=rtpmap:"); /* not exact; opus is 102 in practice */
	g_free(pt_s);
	if (!ruf || !rpw || !rxkey) {
		teams_call_log("media_start: offer missing ice/crypto (uf=%d pw=%d key=%d) - cannot answer",
		               ruf != NULL, rpw != NULL, rxkey != NULL);
		g_free(ruf); g_free(rpw); g_free(rxkey); g_strfreev(envp); g_free(gstenv); g_free(regenv);
		return;
	}

	envp = g_environ_setenv(envp, "GST_PLUGIN_SYSTEM_PATH_1_0", strchr(gstenv, '=') + 1, TRUE);
	envp = g_environ_setenv(envp, "GST_REGISTRY", strchr(regenv, '=') + 1, TRUE);
	/* capture detailed GStreamer errors (esp. srtp decrypt / rtp depay) to a file for diagnosis */
	envp = g_environ_setenv(envp, "GST_DEBUG", "2,GST_PADS:5,srtpdec:5,rtpopusdepay:5,opusdec:4,nicesrc:5,appsink:5", TRUE);
	envp = g_environ_setenv(envp, "GST_DEBUG_FILE", "/media/internal/teams-gst.log", TRUE);
	envp = g_environ_setenv(envp, "GST_DEBUG_NO_COLOR", "1", TRUE);
	/* ALSA "voip"/"voipsource" are PulseAudio PCMs defined ONLY in the system /etc/asound.conf, which
	 * only the SYSTEM libasound reads. The wpe-252 libasound (in our RUNPATH) uses its own config that
	 * lacks them -> "Unknown PCM voip". Force the system libasound (via LD_PRELOAD, same as the
	 * transport) + the system ALSA config so alsasink/alsasrc can open voip/voipsource -> PulseAudio. */
	envp = g_environ_setenv(envp, "LD_PRELOAD",
		"/usr/lib/synergy-runtime/libstdc++.so.6 "
		"/media/cryptofs/wpe-glibc/lib/librt.so.1 /usr/lib/libasound.so.2", TRUE);
	envp = g_environ_setenv(envp, "ALSA_CONFIG_PATH", "/usr/share/alsa/alsa.conf", TRUE);
	envp = g_environ_setenv(envp, "ALSA_PLUGIN_DIR", "/usr/lib/alsa-lib", TRUE);
	/* teams_media (unlike imlibpurpletransport/WhatsApp/Telegram) is NOT patched to the wpe-glibc
	 * interpreter - it uses the stock /lib/ld-linux.so.3 (confirmed via readelf -l). Spawned as our
	 * child, it just inherits OUR OWN LD_LIBRARY_PATH (set by imwrap.sh) unmodified - no override
	 * needed. An explicit override was tried once, to route around a libpalmgstskype.so ->
	 * libmedia-clonk.so -> libpbnjson_cpp.so GLIBCXX conflict, when this subprocess linked the
	 * H.264/skypekit video bridge directly - but that approach was abandoned (the bridge now lives
	 * in the plugin process instead; see teams_media.c's top-of-file comment) and this subprocess is
	 * back to a pure gst-1.20/nice build with no libpalmgstskype.so dependency, so the inherited
	 * environment (already proven for audio-only calls) is sufficient again. */

	if (!g_spawn_async_with_pipes(NULL, (gchar **) argv, envp,
	                              G_SPAWN_DO_NOT_REAP_CHILD, NULL, NULL,
	                              &pid, &in_fd, &out_fd, NULL, &err)) {
		teams_call_log("media_start: spawn %s failed: %s", TEAMS_MEDIA_BIN, err ? err->message : "?");
		if (err) g_error_free(err);
		g_free(ruf); g_free(rpw); g_free(rxkey); g_strfreev(envp); g_free(gstenv); g_free(regenv);
		return;
	}
	g_strfreev(envp); g_free(gstenv); g_free(regenv);

	mp = g_new0(TeamsMediaProc, 1);
	mp->call = call; mp->pid = pid; mp->in_fd = in_fd;
	mp->our_cands = g_string_new("");
	mp->out_ch = g_io_channel_unix_new(out_fd);
	g_io_channel_set_flags(mp->out_ch, G_IO_FLAG_NONBLOCK, NULL);
	mp->out_watch = g_io_add_watch(mp->out_ch, G_IO_IN | G_IO_HUP | G_IO_ERR, media_on_output, mp);
	g_mproc = mp;

	/* Give the engine a STUN server so it gathers server-reflexive (srflx) candidates - host-only
	 * ICE can't traverse NAT to Teams' relay. Teams' media relay (udpTransport, :3478) also answers
	 * STUN binding requests, so point STUN at it. Must precede START. */
	if (call->udp_transport) {
		const gchar *h = call->udp_transport;
		gchar *hc, *slash, *colon; int rport = 3478;
		if (g_str_has_prefix(h, "udp://")) h += 6;
		hc = g_strdup(h);
		if ((slash = strchr(hc, '/'))) *slash = '\0';
		if ((colon = strrchr(hc, ':'))) { rport = atoi(colon + 1); *colon = '\0'; }
		{ gchar *r = g_strdup_printf("RELAY stun %s %d\n", hc, rport);
		  if (write(in_fd, r, strlen(r)) < 0) {} g_free(r); }
		teams_call_log("media_start: RELAY stun %s %d", hc, rport);
		g_free(hc);
	}

	/* START <rx_master_b64> <remote_ufrag> <remote_pwd> <pt> */
	{ gchar *s = g_strdup_printf("START %s %s %s %d\n", rxkey, ruf, rpw, pt);
	  if (write(in_fd, s, strlen(s)) < 0) teams_call_log("media_start: write START failed"); g_free(s); }
	/* feed the peer's ICE candidates from the offer */
	lines = g_strsplit(call->sdp_offer, "\n", -1);
	for (i = 0; lines[i]; i++) {
		gchar *l = g_strstrip(lines[i]);
		if (g_str_has_prefix(l, "a=candidate:")) {
			gchar *r = g_strdup_printf("RCAND %s\n", l + 2); /* strip "a=" -> "candidate:..." */
			if (write(in_fd, r, strlen(r)) < 0) {} g_free(r);
		}
	}
	g_strfreev(lines);
	teams_call_log("media_start: spawned teams_media pid=%d, START sent (pt=%d relay=%s)", (int) pid, pt,
	               call->udp_transport ? call->udp_transport : "(none)");
	g_free(ruf); g_free(rpw); g_free(rxkey);
}

static void
teams_media_stop(void)
{
	TeamsMediaProc *mp = g_mproc;
	if (!mp) return;
	g_mproc = NULL;
	if (mp->answer_timer) g_source_remove(mp->answer_timer);
	if (mp->in_fd >= 0) { const char *s = "STOP\n"; if (write(mp->in_fd, s, 5) < 0) {} close(mp->in_fd); }
	if (mp->out_watch) g_source_remove(mp->out_watch);
	if (mp->out_ch) g_io_channel_unref(mp->out_ch);
	if (mp->pid) { g_spawn_close_pid(mp->pid); }
	g_string_free(mp->our_cands, TRUE);
	g_free(mp->our_ufrag); g_free(mp->our_pwd); g_free(mp->our_txkey); g_free(mp->callagent_id);
	g_free(mp->pending_reneg_answer_link);
	g_free(mp->last_restarted_ufrag);
	g_free(mp);
	teams_call_log("media stopped");
}

/* POST the SDP answer to the call's attach link (resolves the mediaAnswer "cc://ma"). Body shape is
 * a best-effort mirror of the offer's mediaContent - CONFIRM/iterate against a web-client answer. */
/* log whether Teams accepted our SDP answer - critical: if rejected, Teams never runs ICE with us. */
static void answer_ok_cb(TeamsAccount *sa, JsonNode *node, gpointer u)
{ (void)sa;(void)u; { gchar *s = node ? json_to_string(node, FALSE) : NULL;
  teams_call_log("ANSWER POST: ACCEPTED (2xx) resp=%.200s", s ? s : "(empty)"); g_free(s); } }
static void answer_err_cb(TeamsAccount *sa, const gchar *data, gssize len, gpointer u)
{ (void)sa;(void)len;(void)u; teams_call_log("ANSWER POST: REJECTED/err resp=%.260s", data ? data : "(no body)"); }

/* Step 2: POST the accept (with our SDP answer) to the acceptance link parsed from the attach
 * response. Body = callAcceptance{acceptedBy, acceptedCallModalities, caps, mediaContent{blob,...}}.
 * acceptedCallModalities was hardcoded to ["Audio"] always (found+fixed 2026-08-05): once
 * sdp_video_direction()'s missing-direction-defaults-to-sendrecv fix started making media_send_answer
 * correctly build an active m=video line (call->video_active TRUE) for offers that want video from the
 * start, this POST's own SDP blob and its acceptedCallModalities list contradicted each other - video
 * active in the SDP, but only "Audio" declared accepted. CAPTURED LIVE: every incoming call that
 * reached this path with call->video_active TRUE died within the same second with "Call Controller
 * timed out while waiting for acknowledgement" (408), while plain audio-only accepts (video_active
 * FALSE, so this mismatch didn't exist) continued working - matches Teams' backend treating a
 * modalities/SDP mismatch as a malformed acceptance rather than acknowledging it. Mirrors the same
 * conditional already used for the OUTGOING offer's callModalities in media_send_offer(). */
static void
teams_calling_post_accept(TeamsCall *call, const gchar *acceptance_url)
{
	TeamsAccount *sa = call->sa;
	const char *agent = call->callagent_id;
	gchar *esc, *legid, *body;
	gchar *l_reneg, *l_xfer, *l_repl, *l_bal, *l_retgt, *l_ctlvid, *l_updmd, *cc_ctlvid, *cc_csrc;
	if (!call->our_answer_sdp) { teams_call_log("accept: no answer SDP"); return; }
	esc = g_strescape(call->our_answer_sdp, "");
	legid = g_strdup_printf("%08X%08X%08X%08X", g_random_int(), g_random_int(), g_random_int(), g_random_int());
	l_reneg  = callagent_path(call, agent, "call", "mediaRenegotiation");
	l_xfer   = callagent_path(call, agent, "call", "transfer");
	l_repl   = callagent_path(call, agent, "call", "replacement");
	l_bal    = callagent_path(call, agent, "call", "balanceUpdate");
	l_retgt  = callagent_path(call, agent, "call", "retargetCompletion");
	l_ctlvid = callagent_path(call, agent, "call", "controlVideoStreaming");
	l_updmd  = callagent_path(call, agent, "call", "updateMediaDescriptions");
	cc_ctlvid = callagent_path(call, agent, "call", "controlVideoStreaming");
	cc_csrc   = callagent_path(call, agent, "call", "csrcInfo");
	body = g_strdup_printf(
		"{\"callAcceptance\":{"
		  "\"acceptedBy\":{\"id\":\"8:%s\",\"displayName\":\"webOS\",\"endpointId\":\"%s\","
		    "\"participantId\":\"%s\",\"languageId\":\"en-us\"},"
		  "\"acceptedCallModalities\":[%s],"
		  "\"capabilities\":null,\"endpointCapabilities\":73463,\"clientEndpointCapabilities\":42876960,"
		  "\"links\":{\"mediaRenegotiation\":\"%s\",\"transfer\":\"%s\",\"replacement\":\"%s\","
		    "\"balanceUpdate\":\"%s\",\"retargetCompletion\":\"%s\",\"controlVideoStreaming\":\"%s\","
		    "\"updateMediaDescriptions\":\"%s\"},"
		  "\"clientContentForMediaController\":{\"controlVideoStreaming\":\"%s\",\"csrcInfo\":\"%s\"},"
		  "\"mediaContent\":{\"blob\":\"%s\",\"contentType\":\"application/sdp-ngc-1.0\","
		    "\"clientLocation\":\"NL\",\"mediaLegId\":\"%s\"},"
		  "\"pstnContent\":{\"emergencyCallCountry\":\"\",\"platformName\":\"" TEAMS_SKYPE_CLIENT "\","
		    "\"publicApiCall\":false},"
		  "\"callKeepAliveInterval\":null,"
		  "\"applicationType\":\"TFL\"}}",
		sa->username ? sa->username : "",
		call->our_endpoint_id ? call->our_endpoint_id : "",
		call->our_participant_id ? call->our_participant_id : "",
		call->video_active ? "\"Audio\",\"Video\"" : "\"Audio\"",
		l_reneg, l_xfer, l_repl, l_bal, l_retgt, l_ctlvid, l_updmd, cc_ctlvid, cc_csrc,
		esc, legid);
	teams_call_log("accept -> POST %d-byte body to acceptance link", (int) strlen(body));
	flightproxy_post_cb(sa, acceptance_url, body, flightproxy_resp_cb, NULL);
	g_free(esc); g_free(legid); g_free(body);
	g_free(l_reneg); g_free(l_xfer); g_free(l_repl); g_free(l_bal); g_free(l_retgt);
	g_free(l_ctlvid); g_free(l_updmd); g_free(cc_ctlvid); g_free(cc_csrc);
}

/* Step 1 response handler: parse callInvitation.links.acceptance from the attach response, then
 * POST the accept (our SDP answer). */
static void
attach_resp_cb(PurpleHttpConnection *hc, PurpleHttpResponse *resp, gpointer u)
{
	TeamsCall *call = (TeamsCall *) u;
	int code; const gchar *data; size_t len = 0;
	JsonObject *root, *ci, *links; const gchar *acc = NULL;
	(void) hc;
	code = purple_http_response_get_code(resp);
	data = purple_http_response_get_data(resp, &len);
	teams_call_log("attach resp code=%d (%d bytes) success=%d err=%s", code, (int) len,
	               (int) purple_http_response_is_successful(resp),
	               purple_http_response_get_error(resp) ? purple_http_response_get_error(resp) : "(none)");
	if (code < 200 || code >= 300 || !data) {
		teams_call_log("attach FAILED: %.240s", data ? data : "(no body)");
		return;
	}
	root = json_decode_object(data, len);
	if (root && (ci = oget(root, "callInvitation")) && (links = oget(ci, "links")))
		acc = sget(links, "acceptance");
	if (acc) {
		gchar *acc_dup = g_strdup(acc);
		teams_call_log("attach OK -> acceptance link acquired, posting accept");
		teams_calling_post_accept(call, acc_dup);
		g_free(acc_dup);
	} else {
		teams_call_log("attach OK but no callInvitation.links.acceptance in response");
	}
	/* Attach (and the accept POST just fired above) are both now in flight - safe to bring up the
	 * local camera pipeline. See video_cb_pending's comment: doing this any earlier risked
	 * blocking the event loop long enough to kill the attach request outright. */
	if (call->video_cb_pending) {
		call->video_cb_pending = FALSE;
		if (g_video_cb) g_video_cb(call->sa, TRUE);
	}
	if (root) json_object_unref(root);
}

/* Incoming answer = two-step media-controller handshake (see media_send_answer). Step 1 here:
 * POST attach to the offer's link_attach; the response yields the acceptance link (step 2). */
static void
teams_calling_post_answer(TeamsCall *call, const char *answer_sdp)
{
	const char *agent;
	gchar *end_link, *body;
	(void) answer_sdp;   /* already stored on call->our_answer_sdp; posted in step 2 */
	if (!call->link_attach) { teams_call_log("post_answer: no attach link"); return; }

	/* generate our endpoint/participant/callAgent identity for this call (reused in accept) */
	if (!call->our_endpoint_id)    call->our_endpoint_id = g_strdup(call->sa->endpoint ? call->sa->endpoint : "");
	if (!call->our_participant_id) call->our_participant_id = purple_uuid_random();
	if (!call->callagent_id)       call->callagent_id = purple_uuid_random();
	agent = call->callagent_id;
	end_link = callagent_path(call, agent, "call", "end");

	body = g_strdup_printf(
		"{\"attach\":{\"requireMediaContent\":false,\"links\":{\"end\":\"%s\"},"
		  "\"locationContent\":null,\"networkContent\":null,\"areaContent\":null,"
		  "\"applicationType\":\"TFL\"},"
		"\"capabilities\":null,\"endpointCapabilities\":73463}",
		end_link);
	teams_call_log("post_answer: attach (step 1/2) -> %d-byte body, url=%s", (int) strlen(body), call->link_attach);
	flightproxy_post_cb(call->sa, call->link_attach, body, attach_resp_cb, call);
	g_free(end_link); g_free(body);
}

/* ------------------------------------------------------------------ TeamsCall */

static const char *
state_str(TeamsCallState s)
{
	switch (s) {
		case TEAMS_CALL_INCOMING:     return "incoming";
		case TEAMS_CALL_DIALING:      return "dialing";
		case TEAMS_CALL_ACTIVE:       return "active";
		case TEAMS_CALL_DISCONNECTED: return "disconnected";
		default:                      return ""; /* idle */
	}
}

static void
push_state(TeamsCall *call, const char *cause)
{
	if (!g_state_cb || !call) return;
	g_state_cb(call->sa, state_str(call->state),
	           call->peer_mri ? teams_strip_user_prefix(call->peer_mri) : NULL,
	           call->peer_name, call->is_outgoing, cause,
	           call->video_requested);
}

static void
teams_call_free(TeamsCall *call)
{
	if (!call) return;
	g_free(call->call_id);
	g_free(call->peer_mri);
	g_free(call->peer_name);
	g_free(call->sdp_offer);
	g_free(call->media_leg_id);
	g_free(call->session_key_b64);
	g_free(call->ticket);
	g_free(call->link_attach);
	g_free(call->link_media_answer);
	g_free(call->link_progress);
	g_free(call->link_reject);
	g_free(call->udp_transport);
	g_free(call->conversation_controller);
	g_free(call->our_answer_sdp);
	g_free(call->our_endpoint_id);
	g_free(call->our_participant_id);
	g_free(call->callagent_id);
	g_free(call);
}

TeamsCall *
teams_calling_current(TeamsAccount *sa)
{
	return sa ? (TeamsCall *) sa->active_call : NULL;
}

static void
set_current(TeamsAccount *sa, TeamsCall *call)
{
	TeamsCall *old = (TeamsCall *) sa->active_call;
	if (old && old != call) teams_call_free(old);
	sa->active_call = call;
}

/* ------------------------------------------------------------------- capture */

/* Append the full raw notification (pretty-printed) plus a decoded summary to the capture
 * log. This is the single most important output of the initial drop: it lets us confirm
 * the exact sdp-ngc dialect, the codec/payload list, and whether the SRTP key rides in the
 * SDP a=crypto line or only in udpKey.sessionKey - none of which are documented. */
static void
capture_notification(TeamsAccount *sa, JsonObject *body_obj, const gchar *request_url)
{
	FILE *f = fopen(TEAMS_CALL_CAPTURE, "a");
	gchar *pretty;
	time_t now = time(NULL);
	char ts[32];
	struct tm *tm = localtime(&now);
	strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", tm);

	if (!f) return;
	pretty = teams_jsonobj_to_string(body_obj); /* pretty JSON */
	fprintf(f, "\n===== %s  url=%s  account=%s =====\n", ts, request_url ? request_url : "?",
	        sa && sa->username ? sa->username : "?");
	if (pretty) {
		fputs(pretty, f);
		fputc('\n', f);
		g_free(pretty);
	}
	fclose(f);
}

/* --------------------------------------------------------------- parse offer */

static TeamsCall *
parse_call_notification(TeamsAccount *sa, JsonObject *body_obj)
{
	JsonObject *cn = oget(body_obj, "callNotification");
	JsonObject *from, *to, *links, *media, *udpKey, *convInv, *debug;
	const gchar *fromId, *toId;
	TeamsCall *call;

	if (!cn) return NULL;

	from   = oget(cn, "from");
	to     = oget(cn, "to");
	links  = oget(cn, "links");
	media  = oget(cn, "mediaContent");
	udpKey = oget(cn, "udpKey");
	convInv = oget(body_obj, "conversationInvitation");
	debug  = oget(body_obj, "debugContent");

	fromId = from ? sget(from, "id") : NULL;
	toId   = to ? sget(to, "id") : NULL;

	call = g_new0(TeamsCall, 1);
	call->sa = sa;

	/* incoming vs outgoing: if WE are the caller it's an outgoing call notification (a fork
	 * / carbon of our own placed call), and the peer is the callee. */
	if (fromId && teams_is_user_self(sa, fromId)) {
		call->is_outgoing = TRUE;
		call->peer_mri  = g_strdup(toId);
		call->peer_name = g_strdup(to ? sget(to, "displayName") : NULL);
	} else {
		call->is_outgoing = FALSE;
		call->peer_mri  = g_strdup(fromId);
		call->peer_name = g_strdup(from ? sget(from, "displayName") : NULL);
	}

	if (debug)  call->call_id = g_strdup(sget(debug, "callId"));

	if (media) {
		call->sdp_offer    = g_strdup(sget(media, "blob"));
		call->media_leg_id = g_strdup(sget(media, "mediaLegId"));
		if (call->sdp_offer) {
			gchar *dir = sdp_video_direction(call->sdp_offer);
			call->video_requested = dir && strcmp(dir, "inactive") != 0;
			g_free(dir);
		}
	}
	if (udpKey) {
		call->session_key_b64 = g_strdup(sget(udpKey, "sessionKey"));
		call->ticket          = g_strdup(sget(udpKey, "ticket"));
	}
	if (links) {
		call->link_attach       = g_strdup(sget(links, "attach"));
		call->link_media_answer = g_strdup(sget(links, "mediaAnswer"));
		call->link_progress     = g_strdup(sget(links, "progress"));
		call->link_reject       = g_strdup(sget(links, "reject"));
		call->udp_transport     = g_strdup(sget(links, "udpTransport"));
	}
	if (convInv)
		call->conversation_controller = g_strdup(sget(convInv, "conversationController"));

	return call;
}

/* --------------------------------------------------------------- HTTP control */

/* POST (empty or small body) to a full https URL from the notification's links. Splits the
 * URL into host + path for teams_post_or_get. Auth headers are added by teams_post_or_get
 * for skype/teams hosts; CONFIRM WITH CAPTURE that flightproxy accepts the same token. */
static void
call_http_post(TeamsAccount *sa, const gchar *full_url, const gchar *body)
{
	const gchar *p;
	gchar *host, *path;
	const gchar *slash;

	if (!full_url) return;
	if (g_str_has_prefix(full_url, "https://")) p = full_url + 8;
	else if (g_str_has_prefix(full_url, "http://")) p = full_url + 7;
	else { teams_call_log("http_post: non-http link '%s' (skipped)", full_url); return; }

	slash = strchr(p, '/');
	if (slash) {
		host = g_strndup(p, slash - p);
		path = g_strdup(slash);
	} else {
		host = g_strdup(p);
		path = g_strdup("/");
	}
	teams_call_log("http_post host=%s path=%.80s body=%d bytes", host, path, body ? (int) strlen(body) : 0);
	teams_post_or_get(sa, TEAMS_METHOD_POST | TEAMS_METHOD_SSL, host, path, body, NULL, NULL, FALSE);
	g_free(host);
	g_free(path);
}

/* --------------------------------------------------------------- trouter entry */

/* DEBUG auto-answer timer: answer the current incoming call (see the toggle in handle_trouter). */
static gboolean
teams_calling_autoanswer_cb(gpointer user)
{
	TeamsAccount *sa = user;
	teams_call_log("AUTO-ANSWER firing");
	teams_calling_answer(sa);
	return G_SOURCE_REMOVE;
}

/* Outgoing call: the callee accepted and Teams delivered their SDP answer on our callAgent
 * mediaAnswer link. Extract ice-ufrag/pwd + the a=crypto RX key + candidates, and feed them to the
 * caller media engine (ANSWER + RCAND) so it applies the peer's key, sets remote creds and connects
 * ICE. The exact frame shape isn't fully known yet, so probe a few likely blob locations. */
static void
teams_calling_handle_media_answer(TeamsAccount *sa, JsonObject *body_obj)
{
	TeamsCall *call = teams_calling_current(sa);
	TeamsMediaProc *mp = g_mproc;
	JsonObject *mc = NULL, *sub;
	const gchar *blob = NULL;
	gchar *ruf, *rpw, *rxkey, **lines; int i;

	if (!call || !mp || !mp->is_caller || mp->in_fd < 0) {
		teams_call_log("mediaAnswer: no outgoing caller engine to apply it to"); return;
	}
	if ((mc = oget(body_obj, "mediaContent")))            blob = sget(mc, "blob");
	if (!blob && (sub = oget(body_obj, "mediaAnswer")) && (mc = oget(sub, "mediaContent"))) blob = sget(mc, "blob");
	if (!blob && (sub = oget(body_obj, "callNotification")) && (mc = oget(sub, "mediaContent"))) blob = sget(mc, "blob");
	if (!blob) { teams_call_log("mediaAnswer: no SDP blob found (see capture log for shape)"); return; }

	ruf = sdp_line_val(blob, "a=ice-ufrag:");
	rpw = sdp_line_val(blob, "a=ice-pwd:");
	rxkey = sdp_gcm_key(blob);
	if (!ruf || !rpw || !rxkey) {
		teams_call_log("mediaAnswer: answer missing ice/crypto (uf=%d pw=%d key=%d)",
		               ruf != NULL, rpw != NULL, rxkey != NULL);
		g_free(ruf); g_free(rpw); g_free(rxkey); return;
	}
	teams_call_log("mediaAnswer: applying peer answer -> ANSWER + RCAND to caller engine");
	{ gchar *s = g_strdup_printf("ANSWER %s %s %s\n", rxkey, ruf, rpw);
	  if (write(mp->in_fd, s, strlen(s)) < 0) {} g_free(s); }
	lines = g_strsplit(blob, "\n", -1);
	for (i = 0; lines[i]; i++) {
		gchar *l = g_strstrip(lines[i]);
		if (g_str_has_prefix(l, "a=candidate:")) {
			gchar *r = g_strdup_printf("RCAND %s\n", l + 2);
			if (write(mp->in_fd, r, strlen(r)) < 0) {} g_free(r);
		}
	}
	g_strfreev(lines);
	call->state = TEAMS_CALL_ACTIVE;
	push_state(call, NULL);

	/* Outgoing dial-with-video: only now, once the callee's OWN answer confirms an active video
	 * m-line, do we consider video actually negotiated (mp->want_video alone was just our request -
	 * see media_send_offer). Mirrors the incoming path's "activate on real negotiated state, not
	 * on request alone" principle. */
	if (mp->want_video && !call->video_active) {
		gchar *dir = sdp_video_direction(blob);
		if (dir && strcmp(dir, "inactive") != 0) {
			call->video_active = TRUE;
			teams_call_log("mediaAnswer: callee confirmed video (a=%s)", dir);
			if (g_video_cb) g_video_cb(sa, TRUE);
		} else {
			teams_call_log("mediaAnswer: video was requested but callee's answer didn't confirm it");
		}
		g_free(dir);
	}
	g_free(ruf); g_free(rpw); g_free(rxkey);
}

/* Peer pushed a mid-call renegotiation offer (e.g. they turned their camera on/off), delivered via
 * the mediaRenegotiation link we generated and handed them in our own accept
 * (teams_calling_post_accept's l_reneg). Real, captured behavior of an actual Teams client: video
 * is commonly added AFTER an audio-only accept this way, not always present in the initial offer -
 * see media_send_answer's offer-time check for the other case. CONFIRM WITH CAPTURE: the exact
 * mediaAnswer link resolution is inferred from a HAR of this flow (mediaNegotiation.links.mediaAnswer
 * in the push body), not yet exercised against a live Teams backend by this code. */
static void
teams_calling_handle_renegotiation(TeamsAccount *sa, JsonObject *body_obj, const gchar *request_url)
{
	TeamsCall *call = teams_calling_current(sa);
	TeamsMediaProc *mp = g_mproc;
	JsonObject *mn, *mc, *links;
	const gchar *blob = NULL, *answer_link = NULL;
	gchar *dir;
	gboolean peer_wants_video;
	(void) request_url;

	if (!call || !mp) { teams_call_log("renegotiate: no active call/engine"); return; }
	mn = oget(body_obj, "mediaNegotiation");
	if (!mn) { teams_call_log("renegotiate: no mediaNegotiation object (see capture log)"); return; }
	if ((mc = oget(mn, "mediaContent"))) blob = sget(mc, "blob");
	if ((links = oget(mn, "links")))     answer_link = sget(links, "mediaAnswer");
	if (!blob) { teams_call_log("renegotiate: no SDP blob in mediaNegotiation"); return; }

	dir = sdp_video_direction(blob);
	peer_wants_video = dir && strcmp(dir, "inactive") != 0;
	teams_call_log("renegotiate: video m-line direction=%s", dir ? dir : "(none)");
	g_free(dir);

	/* CAPTURED LIVE (2026-08-01): a renegotiation push commonly swaps the peer to a brand-new
	 * media leg - fresh ice-ufrag/pwd (and sometimes a whole new a=crypto key/mediaLegId/relay),
	 * not just a direction flip. Previously we only read the video direction out of this blob and
	 * never told the running media engine about the new remote ICE creds/candidates, so the engine
	 * kept trying to reach the STALE leg while we happily POSTed back an "answer" to the new one -
	 * every leg after the first was a silent no-op. Teams cycles a few times, then kills the whole
	 * call as MediaError (code 410) once none of them ever connect. Apply the new creds/key +
	 * candidates via RESTART/RCAND (see teams_media.c) before replying, same as the initial-answer
	 * path (teams_calling_handle_media_answer) already does for the caller side. */
	gboolean sent_restart = FALSE;
	if (mp->in_fd >= 0) {
		gchar *ruf = sdp_line_val(blob, "a=ice-ufrag:");
		gchar *rpw = sdp_line_val(blob, "a=ice-pwd:");
		gchar *rxkey = sdp_gcm_key(blob);
		if (ruf && rpw) {
			/* Dedup: Teams' trouter can redeliver the identical renegotiation push (same remote
			 * ufrag) - a real client only actually changes ICE creds when it genuinely moves to a
			 * new leg. Restarting the ICE agent on every redelivery never lets a session finish
			 * connectivity checks before being torn down again. Skip the RESTART (but still update
			 * video_active/answer below) when the ufrag hasn't actually changed. */
			if (mp->last_restarted_ufrag && !strcmp(mp->last_restarted_ufrag, ruf)) {
				teams_call_log("renegotiate: same ufrag as last RESTART (uf=%s) - skipping, "
				               "ICE session already in progress", ruf);
			} else {
				gchar *s = g_strdup_printf("RESTART %s %s %s\n", rxkey ? rxkey : "-", ruf, rpw);
				if (write(mp->in_fd, s, strlen(s)) < 0) {}
				g_free(s);
				{ gchar **rlines = g_strsplit(blob, "\n", -1); int j;
				  for (j = 0; rlines[j]; j++) {
					  gchar *l = g_strstrip(rlines[j]);
					  if (g_str_has_prefix(l, "a=candidate:")) {
						  gchar *r = g_strdup_printf("RCAND %s\n", l + 2);
						  if (write(mp->in_fd, r, strlen(r)) < 0) {}
						  g_free(r);
					  }
				  }
				  g_strfreev(rlines);
				}
				teams_call_log("renegotiate: sent RESTART+cands to engine (uf=%s)", ruf);
				g_free(mp->last_restarted_ufrag);
				mp->last_restarted_ufrag = g_strdup(ruf);
				sent_restart = TRUE;
			}
		} else {
			teams_call_log("renegotiate: offer missing ice-ufrag/pwd, cannot restart ICE (uf=%d pw=%d)",
			               ruf != NULL, rpw != NULL);
		}
		g_free(ruf); g_free(rpw); g_free(rxkey);
	}

	if (peer_wants_video && !call->video_active) {
		call->video_active = TRUE;
		teams_call_log("renegotiate: video ADDED mid-call");
		if (g_video_cb) g_video_cb(sa, TRUE);
	} else if (!peer_wants_video && call->video_active) {
		call->video_active = FALSE;
		teams_call_log("renegotiate: video REMOVED mid-call");
		if (g_video_cb) g_video_cb(sa, FALSE);
	}

	if (!answer_link || !mp->our_ufrag || !mp->our_pwd || !mp->our_txkey) {
		teams_call_log("renegotiate: missing answer link or media params (uf=%d pw=%d key=%d link=%d), "
		               "cannot respond", mp->our_ufrag != NULL, mp->our_pwd != NULL,
		               mp->our_txkey != NULL, answer_link != NULL);
		return;
	}

	if (sent_restart) {
		/* Engine's RESTART is in flight - it's about to regenerate OUR OWN local ice-ufrag/pwd
		 * (real RFC 5245 restart, see teams_media.c), so mp->our_ufrag/our_pwd are stale RIGHT
		 * NOW and answering with them would hand the peer credentials our own agent no longer
		 * recognizes. Defer: media_on_output() calls send_reneg_answer() once the engine's
		 * RESTARTED line confirms the fresh local creds have already landed in mp. A second
		 * renegotiation arriving before the first's RESTARTED comes back simply supersedes it. */
		g_free(mp->pending_reneg_answer_link);
		mp->pending_reneg_answer_link = g_strdup(answer_link);
		return;
	}
	send_reneg_answer(mp, answer_link);
}

void
teams_calling_handle_trouter(TeamsAccount *sa, JsonObject *body_obj, const gchar *request_url)
{
	/* Always capture first - even notifications we don't yet model are ground truth. */
	capture_notification(sa, body_obj, request_url);

	if (request_url && strstr(request_url, "callAgent/"))
		teams_call_log("callAgent frame: %s", strstr(request_url, "callAgent/"));

	/* Outgoing call: callee is ringing (progress) or has answered (mediaAnswer). */
	if (request_url && (strstr(request_url, "/mediaAnswer") || strstr(request_url, "/mediaanswer"))) {
		teams_call_log("outgoing: MEDIA ANSWER frame received");
		teams_calling_handle_media_answer(sa, body_obj);
		return;
	}
	/* Mid-call renegotiation push (e.g. peer turns their camera on/off) on the mediaRenegotiation
	 * link we generated in our own accept - see teams_calling_post_accept's l_reneg. */
	if (request_url && strstr(request_url, "/mediaRenegotiation")) {
		teams_call_log("RENEGOTIATION frame received");
		teams_calling_handle_renegotiation(sa, body_obj, request_url);
		return;
	}
	if (request_url && strstr(request_url, "/progress")) {
		TeamsCall *call = teams_calling_current(sa);
		teams_call_log("outgoing: PROGRESS frame (callee ringing)");
		if (call) push_state(call, "ringing");
		return;
	}

	/* Call ended */
	if (request_url && (strstr(request_url, "/call/end") || g_str_has_suffix(request_url, "/end")
	                    || g_str_has_suffix(request_url, "/end/"))) {
		TeamsCall *call = teams_calling_current(sa);
		if (call) {
			JsonObject *ce = oget(body_obj, "callEnd");
			const gchar *phrase = ce ? sget(ce, "phrase") : NULL;
			const gchar *reason = ce ? sget(ce, "reason") : NULL;
			gint64 code = ce && json_object_has_member(ce, "code") ? json_object_get_int_member(ce, "code") : 0;
			/* Map the Teams callEnd to a webOS Phone-app cause. The Phone app shows "Call dropped" for
			 * any cause string it doesn't recognise (e.g. the raw "LocalUserInitiated"). Recognised
			 * causes: "normal"/"rejected"/"missed"/"busy"/"error". A normal hang-up (either side) or a
			 * successfully-connected call that ended = "normal"; declines/timeouts map accordingly. */
			const gchar *cause = "normal";
			if (phrase && (strstr(phrase, "Decline") || strstr(phrase, "Reject")))      cause = "rejected";
			else if (phrase && (strstr(phrase, "Unanswer") || strstr(phrase, "Timeout") ||
			                    strstr(phrase, "NoAnswer") || strstr(phrase, "Ring")))   cause = "missed";
			else if (phrase && strstr(phrase, "Busy"))                                   cause = "busy";
			else if (phrase && (strstr(phrase, "UserInitiated") || strstr(phrase, "Success"))) cause = "normal";
			else if (g_strcmp0(reason, "clientError") == 0 && code && code != 0 && code != 200 &&
			         call->state != TEAMS_CALL_ACTIVE)                                    cause = "error";
			call->state = TEAMS_CALL_DISCONNECTED;
			teams_call_log("call ended: phrase=%s reason=%s code=%d -> cause=%s",
			               phrase ? phrase : "(none)", reason ? reason : "(none)", (int) code, cause);
			push_state(call, cause);
			teams_media_stop();
			set_current(sa, NULL);
		}
		return;
	}

	/* Roster update mid-call - not modeled yet, capture only. */
	if (request_url && g_str_has_suffix(request_url, "/rosterUpdate"))
		return;

	/* Incoming/outgoing call setup (callNotification present). */
	if (json_object_has_member(body_obj, "callNotification")) {
		TeamsCall *call = parse_call_notification(sa, body_obj);
		if (!call) return;

		call->state = call->is_outgoing ? TEAMS_CALL_DIALING : TEAMS_CALL_INCOMING;
		set_current(sa, call);

		teams_call_log("%s call  peer=%s (%s)  sdp=%d bytes  key=%s  ticket=%s  relay=%s  reject=%s",
		               call->is_outgoing ? "OUTGOING" : "INCOMING",
		               call->peer_mri ? call->peer_mri : "?",
		               call->peer_name ? call->peer_name : "?",
		               call->sdp_offer ? (int) strlen(call->sdp_offer) : 0,
		               call->session_key_b64 ? "yes" : "no",
		               call->ticket ? "yes" : "no",
		               call->udp_transport ? call->udp_transport : "?",
		               call->link_reject ? "yes" : "no");

		/* Ring the Phone app (incoming) / show dialing (outgoing carbon). */
		push_state(call, NULL);

		/* DEBUG auto-answer: if /media/internal/teams-autoanswer exists, answer an INCOMING call
		 * automatically after 3s. Lets the media path be tested by just placing a call (no physical
		 * tap on the device). Toggle by creating/removing the file; no rebuild needed. */
		if (!call->is_outgoing && g_file_test("/media/internal/teams-autoanswer", G_FILE_TEST_EXISTS)) {
			teams_call_log("AUTO-ANSWER armed (toggle present) - answering in 3s");
			g_timeout_add_seconds(3, teams_calling_autoanswer_cb, sa);
		}
		return;
	}
}

/* --------------------------------------------------------------- actions (LS2) */

gboolean
teams_calling_answer(TeamsAccount *sa)
{
	TeamsCall *call = teams_calling_current(sa);
	if (!call || call->state != TEAMS_CALL_INCOMING) {
		teams_call_log("answer: no incoming call");
		return FALSE;
	}
	teams_call_log("answer: starting media for call with %s", call->peer_mri ? call->peer_mri : "?");

	/* Start the media engine. It will (once wired) allocate on the MS-TURN relay with the
	 * ticket, set up SRTP from sessionKey, negotiate the offered codec, and hand back an
	 * SDP answer. That answer then gets POSTed to link_media_answer/attach. For now the
	 * media start is a stub, so we only transition state so the flow is exercisable. */
	teams_media_start(call);

	/* TODO(capture): POST the produced SDP answer to call->link_media_answer ("cc://ma" is
	 * an alias resolved via link_attach on api.flightproxy...). Exact body shape =
	 * { "mediaContent": { "contentType": "application/sdp-ngc-0.5", "blob": <answer>,
	 *   "mediaLegId": <call->media_leg_id> } } - CONFIRM WITH CAPTURE. */

	call->state = TEAMS_CALL_ACTIVE;
	push_state(call, NULL);
	return TRUE;
}

gboolean
teams_calling_reject(TeamsAccount *sa)
{
	TeamsCall *call = teams_calling_current(sa);
	if (!call) { teams_call_log("reject: no call"); return FALSE; }
	teams_call_log("reject: rejecting call from %s", call->peer_mri ? call->peer_mri : "?");

	if (call->link_reject)
		call_http_post(sa, call->link_reject, NULL); /* reject is a bare POST, no body */

	call->state = TEAMS_CALL_DISCONNECTED;
	push_state(call, "rejected");
	teams_media_stop();
	set_current(sa, NULL);
	return TRUE;
}

gboolean
teams_calling_hangup(TeamsAccount *sa)
{
	TeamsCall *call = teams_calling_current(sa);
	if (!call) { teams_call_log("hangup: no call"); return FALSE; }
	teams_call_log("hangup: ending call with %s", call->peer_mri ? call->peer_mri : "?");

	/* CAPTURED LIVE (2026-08-01): this used to be a no-op for an ACTIVE call - only the
	 * still-ringing/not-yet-accepted case (link_reject) sent anything to Teams. Hanging up an
	 * ACTIVE call tore down our own media/state locally but told Teams' backend and the peer
	 * NOTHING, so the peer's client (e.g. the Android app) kept sitting there mid-negotiation
	 * after we'd already disconnected. An active call is ended via the conversation controller
	 * (conversationInvitation.conversationController, parsed into call->conversation_controller
	 * at notification time but never previously used anywhere). CONFIRM WITH CAPTURE the exact
	 * end/hangup shape - flightproxy_delete()'s DELETE-with-no-body is a best-effort guess
	 * (REST "leave/end this conversation" semantics), not yet verified against a live backend. */
	if (call->state == TEAMS_CALL_INCOMING && call->link_reject)
		call_http_post(sa, call->link_reject, NULL);
	else if (call->conversation_controller)
		flightproxy_delete(sa, call->conversation_controller);

	call->state = TEAMS_CALL_DISCONNECTED;
	push_state(call, "normal");
	teams_media_stop();
	set_current(sa, NULL);
	return TRUE;
}

gboolean
teams_calling_dial(TeamsAccount *sa, const gchar *peer_mri, gboolean video)
{
	/* Outgoing (caller): spawn teams_media --caller to gather our ICE + generate the offer's SRTP
	 * key, then media_send_offer() builds the SDP offer and POSTs the cpconv create request (which
	 * makes the peer ring). The answer comes back over the trouter callAgent path. FIRST-ATTEMPT. */
	TeamsCall *call;
	TeamsMediaProc *mp;
	const gchar *argv[] = { TEAMS_MEDIA_BIN, "--caller", NULL };
	const gchar *W = "/media/cryptofs/apps/usr/palm/applications/org.webosports.app.atlas/deviceroot/wpe-252/lib";
	gchar *gstpath = g_strdup_printf("%s/gstreamer-1.0", W);
	gchar **envp = g_get_environ();
	GError *err = NULL;
	GPid pid; int in_fd = -1, out_fd = -1;

	if (!sa->trouter_surl) { teams_call_log("dial: no trouter surl - cannot place call"); g_strfreev(envp); g_free(gstpath); return FALSE; }

	envp = g_environ_setenv(envp, "GST_PLUGIN_SYSTEM_PATH_1_0", gstpath, TRUE);
	envp = g_environ_setenv(envp, "GST_REGISTRY", "/media/internal/teams-gst-registry.bin", TRUE);
	g_free(gstpath);
	/* Same ALSA voip/voipsource PCM fix as teams_media_start() (answerer path) - see that copy's
	 * comment. No LD_LIBRARY_PATH override here either, for the same reason: teams_media is back to
	 * a pure gst-1.20/nice build (no libpalmgstskype.so), so simply inheriting our own environment
	 * (set by imwrap.sh) is sufficient. */
	envp = g_environ_setenv(envp, "LD_PRELOAD",
		"/usr/lib/synergy-runtime/libstdc++.so.6 "
		"/media/cryptofs/wpe-glibc/lib/librt.so.1 /usr/lib/libasound.so.2", TRUE);
	envp = g_environ_setenv(envp, "ALSA_CONFIG_PATH", "/usr/share/alsa/alsa.conf", TRUE);
	envp = g_environ_setenv(envp, "ALSA_PLUGIN_DIR", "/usr/lib/alsa-lib", TRUE);

	if (!g_spawn_async_with_pipes(NULL, (gchar **) argv, envp, G_SPAWN_DO_NOT_REAP_CHILD, NULL, NULL,
	                              &pid, &in_fd, &out_fd, NULL, &err)) {
		teams_call_log("dial: spawn %s --caller failed: %s", TEAMS_MEDIA_BIN, err ? err->message : "?");
		if (err) g_error_free(err); g_strfreev(envp); return FALSE;
	}
	g_strfreev(envp);

	call = g_new0(TeamsCall, 1);
	call->sa = sa;
	call->is_outgoing = TRUE;
	call->state = TEAMS_CALL_DIALING;
	call->peer_mri = g_str_has_prefix(peer_mri, "8:") ? g_strdup(peer_mri) : g_strdup_printf("8:%s", peer_mri);
	call->video_requested = video;
	set_current(sa, call);

	mp = g_new0(TeamsMediaProc, 1);
	mp->call = call; mp->pid = pid; mp->in_fd = in_fd; mp->is_caller = TRUE;
	mp->want_video = video;
	mp->callagent_id = purple_uuid_random();
	mp->our_cands = g_string_new("");
	mp->out_ch = g_io_channel_unix_new(out_fd);
	g_io_channel_set_flags(mp->out_ch, G_IO_FLAG_NONBLOCK, NULL);
	mp->out_watch = g_io_add_watch(mp->out_ch, G_IO_IN | G_IO_HUP | G_IO_ERR, media_on_output, mp);
	g_mproc = mp;

	/* CALLER START: no rx key (we produce the offer). pt=102 for opus. */
	{ const char *s = "START 102\n"; if (write(in_fd, s, strlen(s)) < 0) teams_call_log("dial: write START failed"); }

	teams_call_log("dial: spawned teams_media --caller pid=%d, calling %s (callAgent=%s)",
	               (int) pid, call->peer_mri, mp->callagent_id);
	push_state(call, NULL);   /* dialing */
	return TRUE;
}
