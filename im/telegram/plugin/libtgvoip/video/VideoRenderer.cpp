//
// Created by Grishka on 10.08.2018.
//

#include "VideoRenderer.h"
#include "../PrivateDefines.h"

#ifdef __ANDROID__
#include "../os/android/VideoRendererAndroid.h"
#elif defined(__APPLE__) && !defined(TARGET_OSX32)
#include "../os/darwin/SampleBufferDisplayLayerRenderer.h"
#endif

std::vector<uint32_t> tgvoip::video::VideoRenderer::GetAvailableDecoders(){
#ifdef __ANDROID__
	return VideoRendererAndroid::availableDecoders;
#elif defined(__APPLE__)
	return SampleBufferDisplayLayerRenderer::GetAvailableDecoders();
#else
	// webOS: real H.264 decode happens natively via mediaserver's clonk pipeline, bridged in by
	// VoipKitVideoRenderer (see voipkit-tgvoip.cpp). Without this branch, our own outgoing
	// PKT_INIT declares zero decoders, so the peer's client has no reason to ever send us video.
	return std::vector<uint32_t>{CODEC_AVC};
#endif
}

int tgvoip::video::VideoRenderer::GetMaximumResolution(){
#ifdef __ANDROID__
	return VideoRendererAndroid::maxResolution;
#elif defined(__APPLE__) && !defined(TARGET_OSX32)
	return SampleBufferDisplayLayerRenderer::GetMaximumResolution();
#else
	// Matches the clonk capture pipeline's actual capture size (WHATSAPP_VIDEO_STATUS.md's
	// videoCaptureStart args use 320x240) -- scale value picked conservatively low; adjust if
	// real traffic shows the peer mis-negotiating resolution off this.
	return 2;
#endif
}
