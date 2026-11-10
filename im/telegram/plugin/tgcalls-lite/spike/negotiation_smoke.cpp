// NegotiateChannels offer/answer (content_negotiation.h) and RTP header parsing (rtp_header.h).
#include <cstdio>
#include <vector>

#include "../content_negotiation.h"
#include "../rtp_header.h"

using namespace tgcalls_lite;

static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); failures++; } } while (0)
// For a result the rest of the test dereferences: stop the test function if it is missing.
#define REQUIRE(cond, msg) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); failures++; return; } } while (0)

static PayloadType pt(uint32_t id, const char *name, uint32_t clock, uint32_t ch = 0) {
	PayloadType p;
	p.id = id;
	p.name = name;
	p.clockrate = clock;
	p.channels = ch;
	return p;
}

static MediaContent audio(uint32_t ssrc, std::vector<PayloadType> pts) {
	MediaContent c;
	c.type = MediaContent::Type::Audio;
	c.ssrc = ssrc;
	c.payloadTypes = std::move(pts);
	return c;
}

static MediaContent video(uint32_t ssrc, std::vector<PayloadType> pts) {
	MediaContent c;
	c.type = MediaContent::Type::Video;
	c.ssrc = ssrc;
	c.payloadTypes = std::move(pts);
	return c;
}

static void test_choose() {
	auto a = choose_payload_type(audio(1, {pt(0, "PCMU", 8000), pt(109, "OPUS", 48000, 2)}));
	CHECK(a && a->id == 109, "opus chosen, case-insensitive, offerer's id kept");
	CHECK(!choose_payload_type(audio(1, {pt(109, "opus", 16000)})), "opus at a wrong clock rate refused");
	CHECK(!choose_payload_type(audio(1, {})), "no payload types, nothing chosen");

	PayloadType mode0 = pt(102, "H264", 90000);
	PayloadType mode1 = pt(104, "H264", 90000);
	mode1.parameters.push_back({"packetization-mode", "1"});
	auto v = choose_payload_type(video(2, {pt(96, "VP8", 90000), mode0, mode1}));
	CHECK(v && v->id == 104, "H264 packetization-mode=1 preferred");
	v = choose_payload_type(video(2, {pt(96, "VP8", 90000), mode0}));
	CHECK(v && v->id == 102, "H264 mode 0 taken when it is the only H264");
	CHECK(!choose_payload_type(video(2, {pt(96, "VP8", 90000), pt(98, "VP9", 90000)})), "no H264, video refused");
	CHECK(!choose_payload_type(audio(1, {pt(200, "opus", 48000)})), "payload type id above 127 refused");
}

static void test_exchange() {
	ContentNegotiator caller(true, {audio(11, {pt(111, "opus", 48000, 2)})});
	ContentNegotiator callee(false, {audio(22, {pt(111, "opus", 48000, 2)})});

	auto offer = caller.takeOffer(5);
	REQUIRE(offer && offer->exchangeId == 5 && offer->contents.size() == 1, "caller offers its audio");
	CHECK(!caller.takeOffer(6), "no second offer while one is pending");
	CHECK(caller.codecs().outgoingAudioPt == -1, "nothing sent before an answer");

	auto answer = callee.handleRemote(*offer);
	REQUIRE(answer && answer->exchangeId == 5, "callee answers with the offer's exchangeId");
	CHECK(answer && answer->contents.size() == 1 && answer->contents[0].ssrc == 11, "answer names the caller's ssrc");
	CHECK(callee.codecs().incomingAudioPt == 111 && callee.codecs().incomingAudioSsrc == 11, "callee knows what it receives");

	auto calleeOffer = callee.takeOffer(7);
	REQUIRE(calleeOffer && !calleeOffer->contents.empty() && calleeOffer->contents[0].ssrc == 22, "callee offers after answering");

	CHECK(!caller.handleRemote(*answer), "an answer gets no reply");
	CHECK(caller.codecs().outgoingAudioPt == 111, "caller sends what the callee accepted");
	CHECK(!caller.offerPending(), "answer clears the pending offer");

	auto answer2 = caller.handleRemote(*calleeOffer);
	REQUIRE(answer2 && answer2->exchangeId == 7, "caller answers the callee's offer");
	CHECK(caller.codecs().incomingAudioPt == 111 && caller.codecs().incomingAudioSsrc == 22, "caller knows what it receives");
	CHECK(caller.codecs().outgoingAudioPt == 111, "answering keeps the outgoing codec");
	CHECK(!callee.handleRemote(*answer2), "callee takes the answer");
	CHECK(callee.codecs().outgoingAudioPt == 111, "callee sends what the caller accepted");
}

static void test_peer_ids_and_feedback() {
	ContentNegotiator us(false, {audio(1, {pt(111, "opus", 48000, 2)})});
	PayloadType opus = pt(109, "opus", 48000, 2);
	FeedbackType tcc; tcc.type = "transport-cc";
	FeedbackType nack; nack.type = "nack";
	opus.feedbackTypes = {tcc, nack};
	NegotiateChannelsMessage offer;
	offer.exchangeId = 42;
	PayloadType h264 = pt(100, "H264", 90000);
	h264.parameters.push_back({"packetization-mode", "1"});
	offer.contents = {audio(77, {pt(0, "PCMU", 8000), opus}), video(78, {pt(96, "VP8", 90000)}),
	                  video(79, {h264})};
	auto answer = us.handleRemote(offer);
	CHECK(answer && answer->contents.size() == 2, "audio and the H264 video accepted, VP8-only video left out");
	if (answer && answer->contents.size() == 2) {
		const auto &a = answer->contents[0];
		CHECK(a.payloadTypes.size() == 1 && a.payloadTypes[0].id == 109, "answer keeps the peer's opus id");
		CHECK(a.payloadTypes[0].feedbackTypes.size() == 1 && a.payloadTypes[0].feedbackTypes[0].type == "nack",
		      "transport-cc dropped, nack kept");
		CHECK(answer->contents[1].ssrc == 79, "the H264 content is the one answered");
	}
	CHECK(us.codecs().incomingAudioPt == 109 && us.codecs().incomingVideoPt == 100, "incoming ids recorded");
	CHECK(us.codecs().incomingVideoSsrc == 79, "incoming video ssrc recorded");

	// A later offer replaces the incoming set, like tgcalls' getAnswer().
	NegotiateChannelsMessage audioOnly;
	audioOnly.exchangeId = 43;
	audioOnly.contents = {audio(77, {opus})};
	us.handleRemote(audioOnly);
	CHECK(us.codecs().incomingVideoPt == -1, "video gone after an audio-only offer");
}

static void test_race() {
	ContentNegotiator callee(false, {audio(22, {pt(111, "opus", 48000)})});
	ContentNegotiator caller(true, {audio(11, {pt(111, "opus", 48000)})});
	auto calleeOffer = callee.takeOffer(9);
	auto callerOffer = caller.takeOffer(5);
	REQUIRE(calleeOffer && callerOffer, "both offer at once");

	CHECK(!caller.handleRemote(*calleeOffer), "caller ignores the callee's offer in a race");
	CHECK(caller.offerPending(), "caller keeps its own offer");

	auto answer = callee.handleRemote(*callerOffer);
	REQUIRE(answer && answer->exchangeId == 5, "callee drops its offer and answers the caller's");
	CHECK(!callee.offerPending(), "callee's offer withdrawn");
	auto again = callee.takeOffer(10);
	REQUIRE(again && again->exchangeId == 10, "callee offers again afterwards");

	CHECK(!caller.handleRemote(*answer), "caller takes the answer");
	CHECK(caller.codecs().outgoingAudioPt == 111, "caller's audio accepted");
	auto answer2 = caller.handleRemote(*again);
	REQUIRE(answer2 && answer2->exchangeId == 10, "caller answers the repeated offer");
	CHECK(!callee.handleRemote(*answer2), "callee takes the answer");
	CHECK(callee.codecs().outgoingAudioPt == 111, "callee's audio accepted");
}

// sargo, 2026-11-04: the callee's answer and its own offer reached the caller in the wrong order,
// the caller dropped the offer while its own was pending, and the callee never sent audio.
static void test_renew() {
	ContentNegotiator caller(true, {audio(11, {pt(111, "opus", 48000)})});
	ContentNegotiator callee(false, {audio(22, {pt(111, "opus", 48000)})});
	CHECK(!callee.renewOffer(3), "nothing to renew before an offer");

	auto callerOffer = caller.takeOffer(5);
	REQUIRE(callerOffer, "caller offers");
	auto answer = callee.handleRemote(*callerOffer);
	auto calleeOffer = callee.takeOffer(9);
	REQUIRE(answer && calleeOffer, "callee answers and offers");

	CHECK(!caller.handleRemote(*calleeOffer), "offer arriving first is dropped");
	CHECK(!caller.handleRemote(*answer), "caller takes the answer");
	CHECK(callee.codecs().outgoingAudioPt == -1, "callee has nothing to send yet");

	CHECK(!callee.renewOffer(9), "renewing under the same exchangeId refused");
	CHECK(!callee.renewOffer(0), "renewing under exchangeId 0 refused");
	auto renewed = callee.renewOffer(12);
	REQUIRE(renewed && renewed->exchangeId == 12 && renewed->contents.size() == 1 && renewed->contents[0].ssrc == 22,
	        "callee repeats its offer under a new exchangeId");
	CHECK(callee.offerPending(), "renewed offer pending");

	auto answer2 = caller.handleRemote(*renewed);
	REQUIRE(answer2 && answer2->exchangeId == 12, "caller answers the renewed offer");
	CHECK(!callee.handleRemote(*answer2), "callee takes the answer");
	CHECK(callee.codecs().outgoingAudioPt == 111, "callee's audio accepted");
	CHECK(!callee.offerPending(), "nothing pending any more");
	CHECK(!callee.renewOffer(13), "nothing to renew after the answer");

	// A late answer to the replaced offer is an answer, not a new offer to answer.
	ContentNegotiator late(false, {audio(33, {pt(111, "opus", 48000)})});
	auto first = late.takeOffer(20);
	auto second = late.renewOffer(21);
	REQUIRE(first && second, "offer and its renewal");
	ContentNegotiator peer(true, {audio(44, {pt(111, "opus", 48000)})});
	auto lateAnswer = peer.handleRemote(*first);
	REQUIRE(lateAnswer && lateAnswer->exchangeId == 20, "peer answers the first offer");
	CHECK(!late.handleRemote(*lateAnswer), "late answer gets no reply");
	CHECK(late.codecs().outgoingAudioPt == 111 && !late.offerPending(), "late answer settles the offer");
	CHECK(late.codecs().incomingAudioPt == -1, "late answer not taken for an offer");
}

static void test_partial_answer() {
	PayloadType h264 = pt(100, "H264", 90000);
	h264.parameters.push_back({"packetization-mode", "1"});
	ContentNegotiator us(true, {audio(1, {pt(111, "opus", 48000)}), video(2, {h264})});
	auto offer = us.takeOffer(3);
	NegotiateChannelsMessage answer;
	answer.exchangeId = 3;
	answer.contents = {audio(1, {pt(111, "opus", 48000)})};
	us.handleRemote(answer);
	CHECK(us.codecs().outgoingAudioPt == 111, "audio accepted");
	CHECK(us.codecs().outgoingVideoPt == -1, "video not accepted, not sent");

	CHECK(!us.takeOffer(0), "exchangeId 0 refused");

	// An answer that names someone else's ssrc does not enable our audio.
	ContentNegotiator other(true, {audio(1, {pt(111, "opus", 48000)})});
	other.takeOffer(4);
	NegotiateChannelsMessage wrong;
	wrong.exchangeId = 4;
	wrong.contents = {audio(99, {pt(111, "opus", 48000)})};
	other.handleRemote(wrong);
	CHECK(other.codecs().outgoingAudioPt == -1, "answer for another ssrc ignored");
	(void)offer;
}

static void test_rtp() {
	// V=2, P=1, X=1, CC=2; PT 111 with marker; seq 0x1234; ts 0x01020304; ssrc 0xAABBCCDD.
	std::vector<uint8_t> p = {0xB2, 0xEF, 0x12, 0x34, 1, 2, 3, 4, 0xAA, 0xBB, 0xCC, 0xDD,
	                          0, 0, 0, 1, 0, 0, 0, 2,   // two CSRCs
	                          0xBE, 0xDE, 0, 1, 9, 9, 9, 9, // one-byte header extension, 1 word
	                          'h', 'i', '!', 0, 0, 3}; // payload "hi!" + 3 bytes of padding
	RtpPacketInfo r;
	CHECK(parse_rtp_header(p.data(), p.size(), r), "full header parses");
	CHECK(r.payloadOffset == 28 && r.payloadLength == 3, "payload found behind CSRCs and extension, padding removed");
	CHECK(r.payloadType == 111 && r.marker && r.sequence == 0x1234 && r.timestamp == 0x01020304 && r.ssrc == 0xAABBCCDDu,
	      "fixed fields");

	std::vector<uint8_t> plain = {0x80, 100, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 7};
	CHECK(parse_rtp_header(plain.data(), plain.size(), r) && r.payloadOffset == 12 && r.payloadLength == 1 && !r.marker,
	      "plain header");

	auto bad = p;
	bad[22] = 0xff; // extension longer than the packet
	CHECK(!parse_rtp_header(bad.data(), bad.size(), r), "overlong extension refused");
	bad = p;
	bad.back() = 0;
	CHECK(!parse_rtp_header(bad.data(), bad.size(), r), "zero padding count refused");
	bad = p;
	bad.back() = 40;
	CHECK(!parse_rtp_header(bad.data(), bad.size(), r), "padding longer than the payload refused");
	bad = plain;
	bad[0] = 0x40;
	CHECK(!parse_rtp_header(bad.data(), bad.size(), r), "RTP version 1 refused");
	bad = plain;
	bad[0] = 0x8f; // 15 CSRCs in a 13-byte packet
	CHECK(!parse_rtp_header(bad.data(), bad.size(), r), "CSRC list past the end refused");
	CHECK(!parse_rtp_header(plain.data(), 11, r), "short packet refused");
}

// A callee like current Telegram apps (tgcalls v2): it offers at once, and when the caller's offer
// meets its own it drops its offer and never sends it again. The caller holds its first offer, so
// the callee's offer is answered first and the callee's media is negotiated too.
static void test_caller_holds_first_offer() {
	ContentNegotiator caller(true, {audio(11, {pt(111, "opus", 48000)})});
	ContentNegotiator callee(false, {audio(22, {pt(111, "opus", 48000)})});
	caller.holdFirstOffer();
	CHECK(caller.firstOfferHeld(), "the caller's first offer is held");
	CHECK(!caller.takeOffer(5), "no offer while it is held");

	auto calleeOffer = callee.takeOffer(9);
	REQUIRE(calleeOffer, "callee offers at once");
	auto answer = caller.handleRemote(*calleeOffer);
	REQUIRE(answer && answer->exchangeId == 9, "caller answers the callee's offer");
	CHECK(caller.codecs().incomingAudioPt == 111 && caller.codecs().incomingAudioSsrc == 22,
	      "caller receives the callee's audio");
	CHECK(!caller.firstOfferHeld(), "answering releases the hold");

	auto callerOffer = caller.takeOffer(5);
	REQUIRE(callerOffer && callerOffer->exchangeId == 5, "caller offers after answering");
	CHECK(!callee.handleRemote(*answer), "callee takes the answer");
	CHECK(callee.codecs().outgoingAudioPt == 111, "callee's audio accepted");
	auto answer2 = callee.handleRemote(*callerOffer);
	REQUIRE(answer2 && answer2->exchangeId == 5, "callee answers the caller's offer");
	CHECK(!caller.handleRemote(*answer2), "caller takes the answer");
	CHECK(caller.codecs().outgoingAudioPt == 111, "caller's audio accepted");
	CHECK(caller.codecs().incomingAudioPt == 111, "caller still receives the callee's audio");
}

// No offer from the callee: the hold times out (the engine calls releaseFirstOffer()), and the
// offer then carries contents changed meanwhile.
static void test_first_offer_hold_released() {
	ContentNegotiator caller(true, {audio(11, {pt(111, "opus", 48000)})});
	caller.holdFirstOffer();
	PayloadType h264 = pt(100, "H264", 90000);
	h264.parameters.push_back({"packetization-mode", "1"});
	caller.setLocalContents({audio(11, {pt(111, "opus", 48000)}), video(12, {h264})});
	CHECK(!caller.takeOffer(5), "still held after a contents change");
	caller.releaseFirstOffer();
	auto offer = caller.takeOffer(5);
	REQUIRE(offer && offer->contents.size() == 2, "after the timeout the offer goes, with the video");
	CHECK(caller.offerPending(), "the offer is pending");
}

int main() {
	test_choose();
	test_exchange();
	test_peer_ids_and_feedback();
	test_race();
	test_renew();
	test_partial_answer();
	test_caller_holds_first_offer();
	test_first_offer_hold_released();
	test_rtp();
	if (failures) {
		fprintf(stderr, "%d check(s) FAILED\n", failures);
		return 1;
	}
	fprintf(stderr, "ALL OK -- negotiation and RTP header parsing\n");
	return 0;
}
