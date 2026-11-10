// Unit tests of the video pieces that need no network: RTCP keyframe requests, the RTP header
// with the orientation extension, the receiver's loss handling, and the negotiator's handling
// of contents that change (camera on/off) and of the orientation extension in answers.
#include <cstdio>
#include <cstring>
#include <vector>

#include "../content_negotiation.h"
#include "../signaling_message.h"
#include "../rtp_header.h"
#include "../video_receiver.h"
#include "../video_rtcp.h"
#include "../../tdlib-purple/h264_rtp.h"

using namespace tgcalls_lite;

static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
	fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static void put32(std::vector<uint8_t> &v, uint32_t x) {
	v.push_back((uint8_t)(x >> 24)); v.push_back((uint8_t)(x >> 16)); v.push_back((uint8_t)(x >> 8)); v.push_back((uint8_t)x);
}

static void test_rtcp() {
	uint8_t pli[kRtcpPliSize];
	rtcp_build_pli(pli, 0x11223344, 0xaabbccdd);
	const uint8_t want[] = {0x81, 206, 0, 2, 0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb, 0xcc, 0xdd};
	CHECK(!memcmp(pli, want, sizeof want), "PLI bytes");
	CHECK(rtcp_requests_keyframe(pli, sizeof pli, 0xaabbccdd), "our PLI asks for a keyframe of its media ssrc");
	CHECK(!rtcp_requests_keyframe(pli, sizeof pli, 0x11223344), "not of the sender ssrc");
	CHECK(!rtcp_requests_keyframe(pli, sizeof pli - 1, 0xaabbccdd), "truncated");
	CHECK(!rtcp_requests_keyframe(nullptr, 12, 0xaabbccdd), "NULL");

	// Compound: an empty receiver report, then the PLI.
	std::vector<uint8_t> c = {0x80, 201, 0, 1};
	put32(c, 0x55);
	c.insert(c.end(), pli, pli + sizeof pli);
	CHECK(rtcp_requests_keyframe(c.data(), c.size(), 0xaabbccdd), "PLI after an RR");
	// A NACK (generic feedback, PT 205 FMT 1) is no keyframe request.
	std::vector<uint8_t> nack = {0x81, 205, 0, 3};
	put32(nack, 1); put32(nack, 0xaabbccdd); put32(nack, 0x00010000);
	CHECK(!rtcp_requests_keyframe(nack.data(), nack.size(), 0xaabbccdd), "NACK");
	// FIR: media ssrc 0, our ssrc in the second FCI entry.
	std::vector<uint8_t> fir = {0x84, 206, 0, 6};
	put32(fir, 1); put32(fir, 0);
	put32(fir, 0x99); put32(fir, 0x01000000);
	put32(fir, 0xaabbccdd); put32(fir, 0x02000000);
	CHECK(rtcp_requests_keyframe(fir.data(), fir.size(), 0xaabbccdd), "FIR entry");
	CHECK(!rtcp_requests_keyframe(fir.data(), fir.size(), 0x77), "FIR for someone else");
	// A bad version or a length past the end stops the walk.
	std::vector<uint8_t> bad = c;
	bad[0] = 0x40;
	CHECK(!rtcp_requests_keyframe(bad.data(), bad.size(), 0xaabbccdd), "version 1 first");
	bad = c;
	bad[3] = 40;
	CHECK(!rtcp_requests_keyframe(bad.data(), bad.size(), 0xaabbccdd), "length past the end");
}

static void test_rtp_header() {
	uint8_t pkt[64];
	memset(pkt, 0xee, sizeof pkt);
	size_t n = write_rtp_header(pkt, 100, 0x1234, 0x01020304, 0x0a0b0c0d, true, 13, 1);
	CHECK(n == 20, "header with CVO is 20 bytes, not %zu", n);
	CHECK(pkt[0] == 0x90 && pkt[1] == (0x80 | 100), "X and M bits, PT");
	CHECK(find_rtp_one_byte_extension(pkt, 24, 13) == 1, "CVO value");
	CHECK(find_rtp_one_byte_extension(pkt, 24, 3) == -1, "another id");
	pkt[20] = 0x65; pkt[21] = 1; pkt[22] = 2; pkt[23] = 3;
	RtpPacketInfo info;
	CHECK(parse_rtp_header(pkt, 24, info) && info.payloadOffset == 20 && info.payloadLength == 4 &&
	      info.marker && info.payloadType == 100 && info.sequence == 0x1234 && info.timestamp == 0x01020304 &&
	      info.ssrc == 0x0a0b0c0d, "parsed back");
	n = write_rtp_header(pkt, 111, 1, 2, 3, false);
	CHECK(n == 12 && pkt[0] == 0x80 && pkt[1] == 111, "no extension, no marker");
	CHECK(find_rtp_one_byte_extension(pkt, 12, 13) == -1, "no extension to find");
	CHECK(write_rtp_header(pkt, 100, 1, 2, 3, true, 15, 1) == 12, "id 15 is reserved");
	CHECK(write_rtp_header(pkt, 100, 1, 2, 3, true, 14, 1) == 20, "id 14 is the last one");
	CHECK(write_rtp_header(pkt, 100, 1, 2, 3, true, 1, 1) == 20, "id 1 is the first one");
	// Another element first, then the CVO one.
	const uint8_t two[] = {0x90, 100, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0xbe, 0xde, 0, 1, 0x21, 7, 8, 0, 0xd0, 3, 0, 0};
	CHECK(find_rtp_one_byte_extension(two, sizeof two, 2) == -1, "a 2-byte element is not returned");
	const uint8_t two2[] = {0x90, 100, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0xbe, 0xde, 0, 2, 0x21, 7, 8, 0xd0, 3, 0, 0, 0};
	CHECK(find_rtp_one_byte_extension(two2, sizeof two2, 13) == 3, "CVO after another element");
}

// Annex-B helpers for the receiver tests.
static std::vector<uint8_t> nal(uint8_t type, size_t size, uint8_t fill) {
	std::vector<uint8_t> v = {0, 0, 0, 1, (uint8_t)(0x60 | type)};
	for (size_t i = 0; i < size; i++) v.push_back((uint8_t)(fill + i));
	return v;
}

struct Packet { std::vector<uint8_t> payload; bool marker; };

static std::vector<Packet> packetize(const std::vector<uint8_t> &au, size_t mtu) {
	std::vector<Packet> out;
	h264_packetize(au.data(), au.size(), mtu,
		[](void *ctx, const unsigned char *p, size_t n, int m) {
			static_cast<std::vector<Packet> *>(ctx)->push_back({std::vector<uint8_t>(p, p + n), m != 0});
		}, &out);
	return out;
}

struct Feeder {
	VideoReceiver rx;
	uint16_t seq = 65530; // wraps during the test
	std::vector<std::vector<uint8_t>> got;
	// Feeds the AU's packets with timestamp ts, skipping packet index `lose` (-1: none).
	void au(const std::vector<uint8_t> &a, uint32_t ts, int lose = -1, size_t mtu = 40) {
		auto pkts = packetize(a, mtu);
		for (size_t i = 0; i < pkts.size(); i++) {
			uint16_t s = seq++;
			if ((int)i == lose) continue;
			const uint8_t *out; size_t n;
			if (rx.feed(s, ts, pkts[i].payload.data(), pkts[i].payload.size(), pkts[i].marker, &out, &n))
				got.emplace_back(out, out + n);
		}
	}
};

static void test_receiver() {
	CHECK(h264_au_has_idr(nal(5, 3, 0).data(), 8), "IDR, 4-byte start code");
	const uint8_t three[] = {0, 0, 1, 0x65, 1};
	CHECK(h264_au_has_idr(three, sizeof three), "IDR, 3-byte start code");
	auto sps_idr = nal(7, 4, 0);
	auto idr = nal(5, 100, 9);
	sps_idr.insert(sps_idr.end(), idr.begin(), idr.end());
	CHECK(h264_au_has_idr(sps_idr.data(), sps_idr.size()), "IDR after SPS");
	CHECK(!h264_au_has_idr(nal(1, 50, 0).data(), 55), "P slice");
	CHECK(!h264_au_has_idr(three, 3), "start code alone");
	CHECK(!h264_au_has_idr(nullptr, 10), "NULL");

	Feeder f;
	auto p1 = nal(1, 200, 1), p2 = nal(1, 150, 2), p3 = nal(1, 120, 3);
	CHECK(f.rx.keyframeNeeded(), "starts waiting for an IDR");
	f.au(p1, 1000);
	CHECK(f.got.empty() && f.rx.stats().dropped == 1, "a P frame before any IDR is held back");
	f.au(sps_idr, 4000);
	CHECK(f.got.size() == 1 && f.got[0] == sps_idr, "the IDR passes whole (got %zu)", f.got.size());
	CHECK(!f.rx.keyframeNeeded(), "decodable now");
	f.au(p2, 7000);
	CHECK(f.got.size() == 2 && f.got[1] == p2, "P after the IDR passes");

	// Loss in the middle of an access unit: that one and the next P are dropped.
	f.au(p1, 10000, 1);
	CHECK(f.got.size() == 2 && f.rx.keyframeNeeded() && f.rx.stats().gaps == 1, "loss -> keyframe needed");
	f.au(p3, 13000);
	CHECK(f.got.size() == 2, "P after a loss held back");
	f.au(sps_idr, 16000);
	CHECK(f.got.size() == 3 && f.got[2] == sps_idr, "the next IDR passes whole");

	// The last packet (marker) of an access unit lost: the next access unit, with a new
	// timestamp, must not be glued onto the broken one.
	auto pk = packetize(p2, 40);
	f.au(p2, 19000, (int)pk.size() - 1);
	f.au(sps_idr, 22000);
	CHECK(f.got.size() == 4 && f.got[3] == sps_idr, "IDR after a lost marker packet is whole");

	// The first packet of a fragmented NAL lost: the rest of it (fragments with a new
	// timestamp) is skipped.
	f.au(p1, 25000, 0);
	CHECK(f.got.size() == 4 && f.rx.keyframeNeeded(), "P without its first fragment is dropped");
	// Two slices, the first fragmented: with the first packet of the access unit lost, the
	// second slice alone must not pass as a whole IDR.
	auto twoSlices = nal(5, 200, 4);
	auto slice2 = nal(5, 10, 6);
	twoSlices.insert(twoSlices.end(), slice2.begin(), slice2.end());
	f.au(twoSlices, 26500, 0);
	CHECK(f.got.size() == 4, "the second slice of an IDR alone does not pass (%zu)", f.got.size());
	// An IDR whose SPS packet was lost passes: the stream has had its SPS.
	f.au(sps_idr, 28000, 0);
	CHECK(f.got.size() == 5 && f.got[4] == idr, "IDR without the repeated SPS passes (%zu)", f.got.size());

	// Late and duplicate packets are dropped and break nothing.
	auto pp = packetize(p2, 40);
	const uint8_t *o; size_t n;
	uint16_t s0 = f.seq;
	for (size_t i = 0; i < pp.size(); i++) {
		if (f.rx.feed((uint16_t)(s0 + i), 31000, pp[i].payload.data(), pp[i].payload.size(), pp[i].marker, &o, &n))
			f.got.emplace_back(o, o + n);
	}
	f.seq = (uint16_t)(s0 + pp.size());
	const uint64_t late = f.rx.stats().late;
	CHECK(!f.rx.feed((uint16_t)(f.seq - 1), 31000, pp.back().payload.data(), pp.back().payload.size(), true, &o, &n),
	      "a duplicate does not complete anything");
	CHECK(!f.rx.feed((uint16_t)(f.seq - 3), 31000, pp[0].payload.data(), pp[0].payload.size(), false, &o, &n),
	      "nor does a late one");
	CHECK(f.rx.stats().late == late + 2 && !f.rx.keyframeNeeded(), "counted as late, stream still fine");
	f.au(p3, 34000);
	CHECK(f.got.size() == 7 && f.got[6] == p3, "the stream goes on");

	f.rx.reset();
	CHECK(f.rx.keyframeNeeded(), "reset waits for an IDR again");
	f.au(p3, 37000);
	CHECK(f.got.size() == 7, "P after reset held back");
	f.au(idr, 40000);
	CHECK(f.got.size() == 7, "a new stream's IDR without an SPS is held back");
	f.au(sps_idr, 43000);
	CHECK(f.got.size() == 8 && f.got[7] == sps_idr, "with its SPS it passes");
}

static MediaContent video(uint32_t ssrc, bool cvo) {
	MediaContent c;
	c.type = MediaContent::Type::Video;
	c.ssrc = ssrc;
	PayloadType h;
	h.id = 100; h.name = "H264"; h.clockrate = 90000;
	h.parameters.push_back({"packetization-mode", "1"});
	c.payloadTypes.push_back(h);
	if (cvo) c.rtpExtensions.push_back({13, kVideoRotationUri});
	return c;
}

static MediaContent audio(uint32_t ssrc) {
	MediaContent c;
	c.type = MediaContent::Type::Audio;
	c.ssrc = ssrc;
	PayloadType o;
	o.id = 111; o.name = "opus"; o.clockrate = 48000; o.channels = 2;
	c.payloadTypes.push_back(o);
	return c;
}

static void test_negotiation() {
	ContentNegotiator n(true, {audio(1)});
	auto first = n.takeOffer(10);
	CHECK(first && first->contents.size() == 1, "first offer: audio only");
	// Camera on while that offer is out: the pending one is old, renewOffer() carries video.
	n.setLocalContents({audio(1), video(2, true)});
	CHECK(n.offerPending() && !n.offerIsCurrent(), "the pending offer is out of date");
	CHECK(!n.takeOffer(11), "no second offer while one is out");
	auto renewed = n.renewOffer(12);
	CHECK(renewed && renewed->contents.size() == 2 && n.offerIsCurrent(), "renewed with video");
	// The answer to the old offer: audio accepted, the offer of video still out.
	NegotiateChannelsMessage oldAnswer;
	oldAnswer.exchangeId = 10;
	oldAnswer.contents = {audio(1)};
	CHECK(!n.handleRemote(oldAnswer), "no reply to an answer");
	CHECK(n.codecs().outgoingAudioPt == 111 && n.codecs().outgoingVideoPt == -1, "audio accepted only");
	CHECK(n.offerPending(), "the video offer is still out");
	// The answer to the new offer, keeping the orientation extension.
	NegotiateChannelsMessage answer;
	answer.exchangeId = 12;
	answer.contents = {audio(1), video(2, true)};
	n.handleRemote(answer);
	CHECK(!n.offerPending() && n.codecs().outgoingVideoPt == 100, "video accepted");
	CHECK(n.codecs().outgoingVideoRotationExtId == 13, "CVO id %d", n.codecs().outgoingVideoRotationExtId);
	// Without the extension in the answer, frames go upright: no id.
	n.setLocalContents({audio(1), video(3, true)});
	auto third = n.takeOffer(13);
	CHECK(third && third->contents.size() == 2 && third->contents[1].ssrc == 3, "camera change offered at once");
	answer.exchangeId = 13;
	answer.contents = {audio(1), video(3, false)};
	n.handleRemote(answer);
	CHECK(n.codecs().outgoingVideoPt == 100 && n.codecs().outgoingVideoRotationExtId == -1, "no CVO accepted");
	// An answer about an ssrc we no longer send does not enable video.
	n.setLocalContents({audio(1)});
	auto fourth = n.takeOffer(14);
	CHECK(fourth && fourth->contents.size() == 1, "camera off offered");
	answer.exchangeId = 14;
	answer.contents = {audio(1), video(3, true)};
	n.handleRemote(answer);
	CHECK(n.codecs().outgoingVideoPt == -1 && n.codecs().outgoingVideoRotationExtId == -1, "stale video ignored");
	// An out-of-range extension id is ignored.
	n.setLocalContents({audio(1), video(4, true)});
	n.takeOffer(15);
	answer.exchangeId = 15;
	answer.contents = {audio(1), video(4, false)};
	answer.contents[1].rtpExtensions.push_back({15, kVideoRotationUri});
	n.handleRemote(answer);
	CHECK(n.codecs().outgoingVideoPt == 100 && n.codecs().outgoingVideoRotationExtId == -1, "id 15 ignored");

	// The peer's camera: its offer with and without video.
	ContentNegotiator callee(false, {audio(5)});
	NegotiateChannelsMessage peer;
	peer.exchangeId = 99;
	peer.contents = {audio(7), video(8, true)};
	auto reply = callee.handleRemote(peer);
	CHECK(reply && reply->contents.size() == 2 && reply->contents[1].rtpExtensions.empty(),
	      "peer video accepted, without extensions");
	CHECK(callee.codecs().incomingVideoPt == 100 && callee.codecs().incomingVideoSsrc == 8, "incoming video");
	peer.exchangeId = 98;
	peer.contents = {audio(7)};
	callee.handleRemote(peer);
	CHECK(callee.codecs().incomingVideoPt == -1, "peer camera off");
}

// What tgcalls' IncomingV2VideoChannel does with a video content: the receive stream's SSRCs are
// the union of its ssrcGroups, and mediaContent.ssrc alone is never added.
static bool tgcalls_receiver_knows_ssrc(const MediaContent &c) {
	for (const auto &g : c.ssrcGroups)
		for (auto s : g.ssrcs)
			if (s == c.ssrc) return true;
	return false;
}

static void test_video_offer() {
	MediaContent v = make_video_content(0x11111111, 0x22222222);
	CHECK(tgcalls_receiver_knows_ssrc(v), "a tgcalls receiver can find our video ssrc in the groups");
	CHECK(v.ssrcGroups.size() == 1 && v.ssrcGroups[0].semantics == "FID" &&
	      v.ssrcGroups[0].ssrcs.size() == 2 && v.ssrcGroups[0].ssrcs[1] == 0x22222222, "FID group of ssrc and rtx ssrc");
	bool rtx = false;
	for (const auto &pt : v.payloadTypes)
		if (pt.name == "rtx")
			for (const auto &p : pt.parameters)
				if (p.first == "apt" && p.second == "100") rtx = true;
	CHECK(rtx, "rtx payload type associated with H264 100");
	auto chosen = choose_payload_type(v);
	CHECK(chosen && chosen->id == 100, "H264, not rtx, is the video payload type");
	// The group survives the signalling round trip.
	SignalingMessage msg;
	msg.type = SignalingMessageType::NegotiateChannels;
	msg.negotiateChannels.exchangeId = 5;
	msg.negotiateChannels.contents = {audio(1), v};
	auto bytes = signaling_message_serialize(msg);
	SignalingMessage back;
	CHECK(signaling_message_parse(bytes.data(), bytes.size(), &back), "offer parses");
	CHECK(back.negotiateChannels.contents.size() == 2 && tgcalls_receiver_knows_ssrc(back.negotiateChannels.contents[1]),
	      "the parsed offer still names our ssrc in a group");
	// An answer that keeps H264 and rtx (as WebRTC's answer does) enables H264 100 for sending.
	ContentNegotiator n(true, {audio(1), v});
	auto offer = n.takeOffer(9);
	CHECK(offer && offer->contents.size() == 2, "offer with video");
	NegotiateChannelsMessage answer;
	answer.exchangeId = 9;
	answer.contents = offer->contents;
	n.handleRemote(answer);
	CHECK(n.codecs().outgoingVideoPt == 100, "sending H264 100, got %d", n.codecs().outgoingVideoPt);
}

int main() {
	test_rtcp();
	test_rtp_header();
	test_receiver();
	test_negotiation();
	test_video_offer();
	if (failures) {
		fprintf(stderr, "%d failure(s)\n", failures);
		return 1;
	}
	fprintf(stderr, "ALL OK -- video unit tests\n");
	return 0;
}
