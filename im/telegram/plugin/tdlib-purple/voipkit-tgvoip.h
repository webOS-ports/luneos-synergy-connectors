// skypekit-tgvoip.h — thin adapter wiring voipkit.cpp's native SkypeKit/clonk video bridge
// into libtgvoip's VoIPController via its own video::VideoSource/video::VideoRenderer
// interfaces. See skypekit.h for the underlying bridge and
// messaging/whatsapp/calling/WHATSAPP_VIDEO_STATUS.md for the full reverse-engineering trail.
//
// Ownership/lifecycle note: voipkit_video_start()/_stop() (the actual thread lifecycle) are
// NOT tied to these classes' Start()/Stop() — VoIPController calls those at a time we don't
// control, but our bridge has a hard ordering requirement (voipkit_video_start() must run
// BEFORE videoPlayerStart's LS2 call, WHATSAPP_VIDEO_STATUS.md Part 17) that only the
// call-luna.cpp clonk-open/close sequence can satisfy. So Start()/Stop() here are no-ops; the
// real lifecycle is driven directly by callLunaOpenClonk()/callLunaCloseClonk() in call.cpp.
#ifndef SKYPEKIT_TGVOIP_H
#define SKYPEKIT_TGVOIP_H

#include <functional>
#include <video/VideoSource.h>
#include <video/VideoRenderer.h>

// VoipKitVideoSource — the capture->peer direction. Registers itself with voipkit.cpp so
// Thread A's decoded access units (mediaserver's own camera encoder output) reach
// VoIPController via the inherited `callback` member, exactly the shape VideoSource expects.
class VoipKitVideoSource : public tgvoip::video::VideoSource {
public:
	// requestKeyframeCb: invoked from RequestKeyFrame() (VoIPController's real PLI-equivalent
	// signal) — wired to callLunaRequestKeyframe() in call.cpp, which restarts capture to force
	// a fresh IDR (no direct native keyframe trigger exists on the clonk LS2 surface, same
	// workaround as WhatsApp's Call.OnVideoKeyframeRequest handling).
	explicit VoipKitVideoSource(std::function<void()> requestKeyframeCb);
	~VoipKitVideoSource() override;

	void Start() override;
	void Stop() override;
	void Reset(uint32_t codec, int maxResolution) override;
	void RequestKeyFrame() override;
	void SetBitrate(uint32_t bitrate) override;

	// Invokes the inherited (protected) `callback` member with one access unit — `callback`
	// isn't reachable from the free function voipkit_set_frame_out_callback() registers
	// (voipkit-tgvoip.cpp), so that function calls this public wrapper instead.
	void DeliverFrame(const unsigned char *data, unsigned int len);

private:
	std::function<void()> requestKeyframeCb_;
};

// VoipKitVideoRenderer — the peer->display direction. DecodeAndDisplay is VoIPController's
// call whenever it has a fully-reassembled peer access unit ready; forwards it straight to
// Thread B via voipkit_video_receive_frame for RTP-packetizing and delivery to mediaserver's
// native player.
class VoipKitVideoRenderer : public tgvoip::video::VideoRenderer {
public:
	VoipKitVideoRenderer();
	~VoipKitVideoRenderer() override;

	void Reset(uint32_t codec, unsigned int width, unsigned int height,
	           std::vector<tgvoip::Buffer> &csd) override;
	void DecodeAndDisplay(tgvoip::Buffer frame, uint32_t pts) override;
	void SetStreamEnabled(bool enabled) override;
	void SetRotation(uint16_t rotation) override;
	void SetStreamPaused(bool paused) override;
};

#endif
