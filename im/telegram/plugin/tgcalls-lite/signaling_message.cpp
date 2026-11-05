// Parts of this file are derived from TelegramMessenger/tgcalls (LGPL-3.0); see NOTICE.
#include "signaling_message.h"

#include <json-glib/json-glib.h>
#include <cstdlib>
#include <cstring>

namespace tgcalls_lite {

namespace {

std::string u32_to_str(uint32_t v) { return std::to_string(v); }

uint32_t str_to_u32(const char *s) {
	if (!s) return 0;
	return (uint32_t)strtoul(s, nullptr, 10);
}

// Accepts either a JSON string or a JSON number for an integer field -- tgcalls' own parse side
// (stringToUInt32/is_number branches in Signaling.cpp) tolerates both, even though its own
// serialize side always emits strings for ssrc/exchangeId.
uint32_t node_to_u32_lenient(JsonNode *node) {
	if (!node) return 0;
	if (JSON_NODE_HOLDS_VALUE(node)) {
		GType vt = json_node_get_value_type(node);
		if (vt == G_TYPE_STRING) return str_to_u32(json_node_get_string(node));
		if (vt == G_TYPE_INT64 || vt == G_TYPE_DOUBLE) return (uint32_t)json_node_get_int(node);
	}
	return 0;
}

void serialize_fingerprint(JsonBuilder *b, const DtlsFingerprint &fp) {
	json_builder_begin_object(b);
	json_builder_set_member_name(b, "hash");
	json_builder_add_string_value(b, fp.hash.c_str());
	json_builder_set_member_name(b, "setup");
	json_builder_add_string_value(b, fp.setup.c_str());
	json_builder_set_member_name(b, "fingerprint");
	json_builder_add_string_value(b, fp.fingerprint.c_str());
	json_builder_end_object(b);
}

void serialize_media_content(JsonBuilder *b, const MediaContent &c) {
	json_builder_begin_object(b);

	json_builder_set_member_name(b, "type");
	json_builder_add_string_value(b, c.type == MediaContent::Type::Video ? "video" : "audio");

	json_builder_set_member_name(b, "ssrc");
	json_builder_add_string_value(b, u32_to_str(c.ssrc).c_str());

	if (!c.ssrcGroups.empty()) {
		json_builder_set_member_name(b, "ssrcGroups");
		json_builder_begin_array(b);
		for (const auto &g : c.ssrcGroups) {
			json_builder_begin_object(b);
			json_builder_set_member_name(b, "semantics");
			json_builder_add_string_value(b, g.semantics.c_str());
			json_builder_set_member_name(b, "ssrcs");
			json_builder_begin_array(b);
			for (auto ssrc : g.ssrcs) json_builder_add_string_value(b, u32_to_str(ssrc).c_str());
			json_builder_end_array(b);
			json_builder_end_object(b);
		}
		json_builder_end_array(b);
	}

	if (!c.payloadTypes.empty()) {
		json_builder_set_member_name(b, "payloadTypes");
		json_builder_begin_array(b);
		for (const auto &pt : c.payloadTypes) {
			json_builder_begin_object(b);
			json_builder_set_member_name(b, "id");
			json_builder_add_int_value(b, (int)pt.id);
			json_builder_set_member_name(b, "name");
			json_builder_add_string_value(b, pt.name.c_str());
			json_builder_set_member_name(b, "clockrate");
			json_builder_add_int_value(b, (int)pt.clockrate);
			json_builder_set_member_name(b, "channels");
			json_builder_add_int_value(b, (int)pt.channels);

			json_builder_set_member_name(b, "feedbackTypes");
			json_builder_begin_array(b);
			for (const auto &fb : pt.feedbackTypes) {
				json_builder_begin_object(b);
				json_builder_set_member_name(b, "type");
				json_builder_add_string_value(b, fb.type.c_str());
				json_builder_set_member_name(b, "subtype");
				json_builder_add_string_value(b, fb.subtype.c_str());
				json_builder_end_object(b);
			}
			json_builder_end_array(b);

			json_builder_set_member_name(b, "parameters");
			json_builder_begin_object(b);
			for (const auto &kv : pt.parameters) {
				json_builder_set_member_name(b, kv.first.c_str());
				json_builder_add_string_value(b, kv.second.c_str());
			}
			json_builder_end_object(b);

			json_builder_end_object(b);
		}
		json_builder_end_array(b);
	}

	json_builder_set_member_name(b, "rtpExtensions");
	json_builder_begin_array(b);
	for (const auto &ext : c.rtpExtensions) {
		json_builder_begin_object(b);
		json_builder_set_member_name(b, "id");
		json_builder_add_int_value(b, ext.id);
		json_builder_set_member_name(b, "uri");
		json_builder_add_string_value(b, ext.uri.c_str());
		json_builder_end_object(b);
	}
	json_builder_end_array(b);

	json_builder_end_object(b);
}

std::vector<uint8_t> finish_and_serialize(JsonBuilder *b) {
	JsonGenerator *gen = json_generator_new();
	JsonNode *root = json_builder_get_root(b);
	json_generator_set_root(gen, root);
	gsize len = 0;
	gchar *str = json_generator_to_data(gen, &len);
	std::vector<uint8_t> result(str, str + len);
	g_free(str);
	json_node_free(root);
	g_object_unref(gen);
	return result;
}

std::vector<uint8_t> serialize_initial_setup(const InitialSetupMessage &m) {
	JsonBuilder *b = json_builder_new();
	json_builder_begin_object(b);
	json_builder_set_member_name(b, "@type");
	json_builder_add_string_value(b, "InitialSetup");
	json_builder_set_member_name(b, "ufrag");
	json_builder_add_string_value(b, m.ufrag.c_str());
	json_builder_set_member_name(b, "pwd");
	json_builder_add_string_value(b, m.pwd.c_str());
	json_builder_set_member_name(b, "renomination");
	json_builder_add_boolean_value(b, m.supportsRenomination);
	json_builder_set_member_name(b, "fingerprints");
	json_builder_begin_array(b);
	for (const auto &fp : m.fingerprints) serialize_fingerprint(b, fp);
	json_builder_end_array(b);
	json_builder_end_object(b);
	auto result = finish_and_serialize(b);
	g_object_unref(b);
	return result;
}

std::vector<uint8_t> serialize_negotiate_channels(const NegotiateChannelsMessage &m) {
	JsonBuilder *b = json_builder_new();
	json_builder_begin_object(b);
	json_builder_set_member_name(b, "@type");
	json_builder_add_string_value(b, "NegotiateChannels");
	json_builder_set_member_name(b, "exchangeId");
	json_builder_add_string_value(b, u32_to_str(m.exchangeId).c_str());
	json_builder_set_member_name(b, "contents");
	json_builder_begin_array(b);
	for (const auto &c : m.contents) serialize_media_content(b, c);
	json_builder_end_array(b);
	json_builder_end_object(b);
	auto result = finish_and_serialize(b);
	g_object_unref(b);
	return result;
}

std::vector<uint8_t> serialize_candidates(const CandidatesMessage &m) {
	JsonBuilder *b = json_builder_new();
	json_builder_begin_object(b);
	json_builder_set_member_name(b, "@type");
	json_builder_add_string_value(b, "Candidates");
	json_builder_set_member_name(b, "candidates");
	json_builder_begin_array(b);
	for (const auto &c : m.iceCandidates) {
		json_builder_begin_object(b);
		json_builder_set_member_name(b, "sdpString");
		json_builder_add_string_value(b, c.sdpString.c_str());
		json_builder_end_object(b);
	}
	json_builder_end_array(b);
	json_builder_end_object(b);
	auto result = finish_and_serialize(b);
	g_object_unref(b);
	return result;
}

const char *video_state_to_str(MediaStateMessage::VideoState s) {
	switch (s) {
		case MediaStateMessage::VideoState::Suspended: return "suspended";
		case MediaStateMessage::VideoState::Active: return "active";
		default: return "inactive";
	}
}

int video_rotation_to_int(MediaStateMessage::VideoRotation r) {
	switch (r) {
		case MediaStateMessage::VideoRotation::Rotation90: return 90;
		case MediaStateMessage::VideoRotation::Rotation180: return 180;
		case MediaStateMessage::VideoRotation::Rotation270: return 270;
		default: return 0;
	}
}

std::vector<uint8_t> serialize_media_state(const MediaStateMessage &m) {
	JsonBuilder *b = json_builder_new();
	json_builder_begin_object(b);
	json_builder_set_member_name(b, "@type");
	json_builder_add_string_value(b, "MediaState");
	json_builder_set_member_name(b, "muted");
	json_builder_add_boolean_value(b, m.isMuted);
	json_builder_set_member_name(b, "lowBattery");
	json_builder_add_boolean_value(b, m.isBatteryLow);
	json_builder_set_member_name(b, "videoState");
	json_builder_add_string_value(b, video_state_to_str(m.videoState));
	json_builder_set_member_name(b, "videoRotation");
	json_builder_add_int_value(b, video_rotation_to_int(m.videoRotation));
	json_builder_set_member_name(b, "screencastState");
	json_builder_add_string_value(b, video_state_to_str(m.screencastState));
	json_builder_end_object(b);
	auto result = finish_and_serialize(b);
	g_object_unref(b);
	return result;
}

MediaStateMessage::VideoState str_to_video_state(const char *s) {
	if (s && !strcmp(s, "suspended")) return MediaStateMessage::VideoState::Suspended;
	if (s && !strcmp(s, "active")) return MediaStateMessage::VideoState::Active;
	return MediaStateMessage::VideoState::Inactive;
}

MediaStateMessage::VideoRotation int_to_video_rotation(int v) {
	if (v == 90) return MediaStateMessage::VideoRotation::Rotation90;
	if (v == 180) return MediaStateMessage::VideoRotation::Rotation180;
	if (v == 270) return MediaStateMessage::VideoRotation::Rotation270;
	return MediaStateMessage::VideoRotation::Rotation0;
}

bool parse_initial_setup(JsonObject *obj, InitialSetupMessage *out) {
	if (!json_object_has_member(obj, "ufrag") || !json_object_has_member(obj, "pwd") ||
	    !json_object_has_member(obj, "fingerprints")) return false;
	out->ufrag = json_object_get_string_member(obj, "ufrag");
	out->pwd = json_object_get_string_member(obj, "pwd");
	out->supportsRenomination = json_object_has_member(obj, "renomination") &&
		json_object_get_boolean_member(obj, "renomination");

	JsonArray *arr = json_object_get_array_member(obj, "fingerprints");
	if (!arr) return false;
	guint n = json_array_get_length(arr);
	for (guint i = 0; i < n; i++) {
		JsonObject *fpObj = json_array_get_object_element(arr, i);
		if (!fpObj) return false;
		if (!json_object_has_member(fpObj, "hash") || !json_object_has_member(fpObj, "setup") ||
		    !json_object_has_member(fpObj, "fingerprint")) return false;
		DtlsFingerprint fp;
		fp.hash = json_object_get_string_member(fpObj, "hash");
		fp.setup = json_object_get_string_member(fpObj, "setup");
		fp.fingerprint = json_object_get_string_member(fpObj, "fingerprint");
		out->fingerprints.push_back(std::move(fp));
	}
	return true;
}

bool parse_candidates(JsonObject *obj, CandidatesMessage *out) {
	if (!json_object_has_member(obj, "candidates")) return false;
	JsonArray *arr = json_object_get_array_member(obj, "candidates");
	if (!arr) return false;
	guint n = json_array_get_length(arr);
	for (guint i = 0; i < n; i++) {
		JsonObject *candObj = json_array_get_object_element(arr, i);
		if (!candObj || !json_object_has_member(candObj, "sdpString")) return false;
		IceCandidate cand;
		cand.sdpString = json_object_get_string_member(candObj, "sdpString");
		out->iceCandidates.push_back(std::move(cand));
	}
	return true;
}

bool parse_media_content(JsonObject *obj, MediaContent *out) {
	if (!json_object_has_member(obj, "type") || !json_object_has_member(obj, "ssrc")) return false;
	const char *type = json_object_get_string_member(obj, "type");
	if (type && !strcmp(type, "video")) out->type = MediaContent::Type::Video;
	else out->type = MediaContent::Type::Audio;

	out->ssrc = node_to_u32_lenient(json_object_get_member(obj, "ssrc"));

	if (json_object_has_member(obj, "ssrcGroups")) {
		JsonArray *arr = json_object_get_array_member(obj, "ssrcGroups");
		guint n = arr ? json_array_get_length(arr) : 0;
		for (guint i = 0; i < n; i++) {
			JsonObject *gObj = json_array_get_object_element(arr, i);
			if (!gObj) continue;
			SsrcGroup g;
			if (json_object_has_member(gObj, "semantics"))
				g.semantics = json_object_get_string_member(gObj, "semantics");
			if (json_object_has_member(gObj, "ssrcs")) {
				JsonArray *ssrcArr = json_object_get_array_member(gObj, "ssrcs");
				guint sn = ssrcArr ? json_array_get_length(ssrcArr) : 0;
				for (guint j = 0; j < sn; j++) {
					g.ssrcs.push_back(node_to_u32_lenient(json_array_get_element(ssrcArr, j)));
				}
			}
			out->ssrcGroups.push_back(std::move(g));
		}
	}

	if (json_object_has_member(obj, "payloadTypes")) {
		JsonArray *arr = json_object_get_array_member(obj, "payloadTypes");
		guint n = arr ? json_array_get_length(arr) : 0;
		for (guint i = 0; i < n; i++) {
			JsonObject *ptObj = json_array_get_object_element(arr, i);
			if (!ptObj) continue;
			PayloadType pt;
			if (json_object_has_member(ptObj, "id")) pt.id = (uint32_t)json_object_get_int_member(ptObj, "id");
			if (json_object_has_member(ptObj, "name")) pt.name = json_object_get_string_member(ptObj, "name");
			if (json_object_has_member(ptObj, "clockrate")) pt.clockrate = (uint32_t)json_object_get_int_member(ptObj, "clockrate");
			if (json_object_has_member(ptObj, "channels")) pt.channels = (uint32_t)json_object_get_int_member(ptObj, "channels");
			if (json_object_has_member(ptObj, "feedbackTypes")) {
				JsonArray *fbArr = json_object_get_array_member(ptObj, "feedbackTypes");
				guint fn = fbArr ? json_array_get_length(fbArr) : 0;
				for (guint j = 0; j < fn; j++) {
					JsonObject *fbObj = json_array_get_object_element(fbArr, j);
					if (!fbObj) continue;
					FeedbackType fb;
					if (json_object_has_member(fbObj, "type")) fb.type = json_object_get_string_member(fbObj, "type");
					if (json_object_has_member(fbObj, "subtype")) fb.subtype = json_object_get_string_member(fbObj, "subtype");
					pt.feedbackTypes.push_back(std::move(fb));
				}
			}
			if (json_object_has_member(ptObj, "parameters")) {
				JsonObject *paramsObj = json_object_get_object_member(ptObj, "parameters");
				if (paramsObj) {
					JsonObjectIter iter;
					const gchar *key;
					JsonNode *valNode;
					json_object_iter_init(&iter, paramsObj);
					while (json_object_iter_next(&iter, &key, &valNode)) {
						pt.parameters.push_back(std::make_pair(std::string(key),
							std::string(json_node_get_string(valNode) ? json_node_get_string(valNode) : "")));
					}
				}
			}
			out->payloadTypes.push_back(std::move(pt));
		}
	}

	if (json_object_has_member(obj, "rtpExtensions")) {
		JsonArray *arr = json_object_get_array_member(obj, "rtpExtensions");
		guint n = arr ? json_array_get_length(arr) : 0;
		for (guint i = 0; i < n; i++) {
			JsonObject *extObj = json_array_get_object_element(arr, i);
			if (!extObj) continue;
			RtpExtension ext;
			if (json_object_has_member(extObj, "id")) {
				// RTP header extension ids are 1 to 255 (RFC 8285); anything else is not one.
				const gint64 id = json_object_get_int_member(extObj, "id");
				if (id < 1 || id > 255) continue;
				ext.id = (int)id;
			}
			if (json_object_has_member(extObj, "uri")) ext.uri = json_object_get_string_member(extObj, "uri");
			out->rtpExtensions.push_back(std::move(ext));
		}
	}

	return true;
}

bool parse_negotiate_channels(JsonObject *obj, NegotiateChannelsMessage *out) {
	if (!json_object_has_member(obj, "exchangeId")) return false;
	out->exchangeId = node_to_u32_lenient(json_object_get_member(obj, "exchangeId"));
	if (json_object_has_member(obj, "contents")) {
		JsonArray *arr = json_object_get_array_member(obj, "contents");
		guint n = arr ? json_array_get_length(arr) : 0;
		for (guint i = 0; i < n; i++) {
			JsonObject *cObj = json_array_get_object_element(arr, i);
			if (!cObj) continue;
			MediaContent c;
			if (!parse_media_content(cObj, &c)) return false;
			out->contents.push_back(std::move(c));
		}
	}
	return true;
}

bool parse_media_state(JsonObject *obj, MediaStateMessage *out) {
	if (json_object_has_member(obj, "muted"))
		out->isMuted = json_object_get_boolean_member(obj, "muted");
	if (json_object_has_member(obj, "lowBattery"))
		out->isBatteryLow = json_object_get_boolean_member(obj, "lowBattery");
	if (json_object_has_member(obj, "videoState"))
		out->videoState = str_to_video_state(json_object_get_string_member(obj, "videoState"));
	if (json_object_has_member(obj, "screencastState"))
		out->screencastState = str_to_video_state(json_object_get_string_member(obj, "screencastState"));
	if (json_object_has_member(obj, "videoRotation"))
		out->videoRotation = int_to_video_rotation((int)json_object_get_int_member(obj, "videoRotation"));
	return true;
}

} // namespace

std::vector<uint8_t> signaling_message_serialize(const SignalingMessage &msg) {
	switch (msg.type) {
		case SignalingMessageType::InitialSetup: return serialize_initial_setup(msg.initialSetup);
		case SignalingMessageType::NegotiateChannels: return serialize_negotiate_channels(msg.negotiateChannels);
		case SignalingMessageType::Candidates: return serialize_candidates(msg.candidates);
		case SignalingMessageType::MediaState: return serialize_media_state(msg.mediaState);
		default: return {};
	}
}

bool signaling_message_parse(const uint8_t *data, size_t len, SignalingMessage *out) {
	JsonParser *parser = json_parser_new();
	GError *error = nullptr;
	gboolean ok = json_parser_load_from_data(parser, (const gchar *)data, (gssize)len, &error);
	if (!ok) {
		if (error) g_error_free(error);
		g_object_unref(parser);
		return false;
	}
	JsonNode *root = json_parser_get_root(parser);
	bool result = false;
	if (root && JSON_NODE_HOLDS_OBJECT(root)) {
		JsonObject *obj = json_node_get_object(root);
		if (obj && json_object_has_member(obj, "@type")) {
			const char *type = json_object_get_string_member(obj, "@type");
			if (type && !strcmp(type, "InitialSetup")) {
				out->type = SignalingMessageType::InitialSetup;
				result = parse_initial_setup(obj, &out->initialSetup);
			} else if (type && !strcmp(type, "NegotiateChannels")) {
				out->type = SignalingMessageType::NegotiateChannels;
				result = parse_negotiate_channels(obj, &out->negotiateChannels);
			} else if (type && !strcmp(type, "Candidates")) {
				out->type = SignalingMessageType::Candidates;
				result = parse_candidates(obj, &out->candidates);
			} else if (type && !strcmp(type, "MediaState")) {
				out->type = SignalingMessageType::MediaState;
				result = parse_media_state(obj, &out->mediaState);
			}
		}
	}
	g_object_unref(parser);
	return result;
}

} // namespace tgcalls_lite
