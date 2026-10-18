#include "voipkit-tgvoip.h"
#include "voipkit.h"

// voipkit.cpp's frame-out callback is a plain C function pointer (no captured state, since
// Thread A calls it from a raw pthread with no C++ closure context) — route it through a
// single static instance pointer. Only one call (and therefore one VoipKitVideoSource) is
// ever active at a time in this plugin, matching the rest of its calling code's assumptions.
static VoipKitVideoSource *g_active_source = nullptr;

static void on_frame_out(const unsigned char *data, unsigned int len) {
	if (!g_active_source) return;
	g_active_source->DeliverFrame(data, len);
}

void VoipKitVideoSource::DeliverFrame(const unsigned char *data, unsigned int len) {
	tgvoip::Buffer buf(len);
	if (len > 0) buf.CopyFrom(data, 0, len);
	// flags=0, rotation=0: mediaserver's own camera source has a fixed physical mounting
	// orientation (its own caps already report angle=270 internally) and this bridge doesn't
	// currently track live device rotation — matches WhatsApp's SetVideoOrientation deferral.
	if (callback) callback(buf, 0, 0);
}

VoipKitVideoSource::VoipKitVideoSource(std::function<void()> requestKeyframeCb)
    : requestKeyframeCb_(std::move(requestKeyframeCb)) {
	g_active_source = this;
	voipkit_set_frame_out_callback(on_frame_out);
}

VoipKitVideoSource::~VoipKitVideoSource() {
	if (g_active_source == this) g_active_source = nullptr;
}

// Thread lifecycle is owned by callLunaOpenClonk()/callLunaCloseClonk() (see skypekit-tgvoip.h)
// -- VoIPController calls Start()/Stop() at a time that doesn't line up with the clonk LS2
// sequencing this bridge needs, so these are deliberately no-ops.
void VoipKitVideoSource::Start() {}
void VoipKitVideoSource::Stop() {}

void VoipKitVideoSource::Reset(uint32_t, int) {}

void VoipKitVideoSource::RequestKeyFrame() {
	if (requestKeyframeCb_) requestKeyframeCb_();
}

void VoipKitVideoSource::SetBitrate(uint32_t) {
	// Not wired: the clonk capture pipeline is started with a fixed bitrate (see
	// callLunaOpenClonk's videoCaptureStart args). Revisit if VoIPController's own bandwidth
	// estimation needs to actually throttle the native encoder mid-call.
}

VoipKitVideoRenderer::VoipKitVideoRenderer() {}
VoipKitVideoRenderer::~VoipKitVideoRenderer() {}

void VoipKitVideoRenderer::Reset(uint32_t, unsigned int, unsigned int, std::vector<tgvoip::Buffer> &) {}

void VoipKitVideoRenderer::DecodeAndDisplay(tgvoip::Buffer frame, uint32_t) {
	voipkit_video_receive_frame(*frame, (unsigned int)frame.Length());
}

void VoipKitVideoRenderer::SetStreamEnabled(bool) {}
void VoipKitVideoRenderer::SetRotation(uint16_t) {}
void VoipKitVideoRenderer::SetStreamPaused(bool) {}
