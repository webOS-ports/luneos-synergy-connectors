#include "ice_session.h"

#include <cstdio>

namespace tgcalls_lite {

IceSession::IceSession(GMainContext *ctx, bool controlling) {
	_agent = nice_agent_new(ctx, NICE_COMPATIBILITY_RFC5245);
	g_object_set(G_OBJECT(_agent), "controlling-mode", controlling ? TRUE : FALSE, nullptr);

	g_signal_connect(G_OBJECT(_agent), "candidate-gathering-done",
	                  G_CALLBACK(&IceSession::gatheringDoneCb), this);
	g_signal_connect(G_OBJECT(_agent), "component-state-changed",
	                  G_CALLBACK(&IceSession::stateChangedCb), this);
	g_signal_connect(G_OBJECT(_agent), "new-selected-pair-full",
	                  G_CALLBACK(&IceSession::selectedPairCb), this);

	_streamId = nice_agent_add_stream(_agent, 1);
	nice_agent_attach_recv(_agent, _streamId, kComponentId, ctx,
	                        &IceSession::recvCb, this);
}

IceSession::~IceSession() {
	if (_agent) {
		nice_agent_remove_stream(_agent, _streamId);
		g_object_unref(_agent);
	}
}

size_t IceSession::setServers(const std::vector<RtcServer> &servers) {
	size_t applied = 0;
	bool haveStun = false;
	for (const auto &s : servers) {
		NiceAddress addr;
		nice_address_init(&addr);
		if (s.port == 0 || !nice_address_set_from_string(&addr, s.host.c_str())) {
			g_warning("tgcalls-lite: skipping a call server whose address is not a literal IP");
			continue;
		}
		if (!s.isTurn) {
			if (haveStun) continue;
			g_object_set(G_OBJECT(_agent), "stun-server", s.host.c_str(),
			             "stun-server-port", (guint)s.port, nullptr);
			haveStun = true;
			applied++;
		} else if (!s.login.empty() && !s.password.empty()) {
			if (nice_agent_set_relay_info(_agent, _streamId, kComponentId, s.host.c_str(), s.port,
			                              s.login.c_str(), s.password.c_str(),
			                              s.isTcp ? NICE_RELAY_TYPE_TURN_TCP : NICE_RELAY_TYPE_TURN_UDP))
				applied++;
			else
				g_warning("tgcalls-lite: libnice rejected a TURN server");
		}
	}
	return applied;
}

void IceSession::gatherCandidates() {
	nice_agent_gather_candidates(_agent, _streamId);
}

void IceSession::getLocalCredentials(std::string *ufrag, std::string *pwd) const {
	gchar *u = nullptr;
	gchar *p = nullptr;
	if (nice_agent_get_local_credentials(_agent, _streamId, &u, &p)) {
		if (ufrag) *ufrag = u ? u : "";
		if (pwd) *pwd = p ? p : "";
	}
	g_free(u);
	g_free(p);
}

std::vector<std::string> IceSession::getLocalCandidateSdpStrings() const {
	std::vector<std::string> result;
	GSList *cands = nice_agent_get_local_candidates(_agent, _streamId, kComponentId);
	for (GSList *it = cands; it; it = it->next) {
		NiceCandidate *cand = (NiceCandidate *)it->data;
		gchar *sdp = nice_agent_generate_local_candidate_sdp(_agent, cand);
		if (sdp) {
			std::string s = sdp;
			// libnice emits "a=candidate:...", but tgcalls' own IceCandidate.sdpString
			// convention (matching WebRTC JS's RTCIceCandidate.candidate / cricket::Candidate::
			// ToString()) has no "a=" prefix -- strip it so what we put on the signaling channel
			// matches what a real peer's tgcalls expects (confirmed empirically: this loopback
			// test's own two libnice agents happily accept either form on the *receive* side, see
			// addRemoteCandidateSdp's defensive re-add below, but only ONE form should be the one
			// actually put on the wire).
			if (s.rfind("a=", 0) == 0) s = s.substr(2);
			result.push_back(s);
			g_free(sdp);
		}
	}
	g_slist_free_full(cands, (GDestroyNotify)nice_candidate_free);
	return result;
}

void IceSession::setRemoteCredentials(const std::string &ufrag, const std::string &pwd) {
	nice_agent_set_remote_credentials(_agent, _streamId, ufrag.c_str(), pwd.c_str());
}

bool IceSession::addRemoteCandidateSdp(const std::string &sdpString) {
	// tgcalls' own wire format has no "a=" prefix (see getLocalCandidateSdpStrings' comment);
	// libnice's parser expects the "a=candidate:..." form it itself generates, so re-add it here
	// rather than assuming the peer's string already has it.
	std::string withPrefix = (sdpString.rfind("a=", 0) == 0) ? sdpString : ("a=" + sdpString);
	NiceCandidate *cand = nice_agent_parse_remote_candidate_sdp(_agent, (gint)_streamId, withPrefix.c_str());
	if (!cand) return false;
	GSList list = {cand, nullptr};
	int added = nice_agent_set_remote_candidates(_agent, _streamId, kComponentId, &list);
	nice_candidate_free(cand);
	return added >= 0;
}

int IceSession::send(const uint8_t *data, size_t len) {
	return nice_agent_send(_agent, _streamId, kComponentId, (guint)len, (const gchar *)data);
}

void IceSession::gatheringDoneCb(NiceAgent *, guint, gpointer user_data) {
	auto *self = (IceSession *)user_data;
	if (self->onGatheringDone) self->onGatheringDone();
}

void IceSession::stateChangedCb(NiceAgent *, guint, guint component_id, guint state, gpointer user_data) {
	auto *self = (IceSession *)user_data;
	if (component_id != kComponentId) return;
	g_message("tgcalls-lite: ICE %s", nice_component_state_to_string((NiceComponentState)state));
	IceConnectionState mapped;
	switch (state) {
		case NICE_COMPONENT_STATE_GATHERING: mapped = IceConnectionState::Gathering; break;
		case NICE_COMPONENT_STATE_CONNECTING: mapped = IceConnectionState::Checking; break;
		case NICE_COMPONENT_STATE_CONNECTED:
		case NICE_COMPONENT_STATE_READY: mapped = IceConnectionState::Connected; break;
		case NICE_COMPONENT_STATE_FAILED: mapped = IceConnectionState::Failed; break;
		default: mapped = IceConnectionState::Disconnected; break;
	}
	if (self->onStateChanged) self->onStateChanged(mapped);
}

const char *candidate_type_name(int type) {
	switch (type) {
		case NICE_CANDIDATE_TYPE_HOST: return "host";
		case NICE_CANDIDATE_TYPE_SERVER_REFLEXIVE: return "srflx";
		case NICE_CANDIDATE_TYPE_PEER_REFLEXIVE: return "prflx";
		case NICE_CANDIDATE_TYPE_RELAYED: return "relay";
		default: return "unknown";
	}
}

void IceSession::selectedPairCb(NiceAgent *, guint, guint component_id, NiceCandidate *local,
                                NiceCandidate *remote, gpointer) {
	if (component_id != kComponentId || !local || !remote) return;
	// Types only: the addresses identify the user's network.
	g_message("tgcalls-lite: ICE selected pair %s/%s -> %s/%s", candidate_type_name(local->type),
	          local->transport == NICE_CANDIDATE_TRANSPORT_UDP ? "udp" : "tcp",
	          candidate_type_name(remote->type),
	          remote->transport == NICE_CANDIDATE_TRANSPORT_UDP ? "udp" : "tcp");
}

void IceSession::recvCb(NiceAgent *, guint, guint component_id, guint len, gchar *buf, gpointer user_data) {
	auto *self = (IceSession *)user_data;
	if (component_id != kComponentId) return;
	if (self->onDataReceived) self->onDataReceived((const uint8_t *)buf, len);
}

} // namespace tgcalls_lite
