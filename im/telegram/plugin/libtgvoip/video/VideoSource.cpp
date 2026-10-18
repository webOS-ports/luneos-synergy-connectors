//
// Created by Grishka on 10.08.2018.
//

#include "VideoSource.h"
#include "../PrivateDefines.h"

#ifdef __ANDROID__
#include "../os/android/VideoSourceAndroid.h"
#elif defined(__APPLE__) && !defined(TARGET_OSX32)
#include "../os/darwin/VideoToolboxEncoderSource.h"
#endif

using namespace tgvoip;
using namespace tgvoip::video;

std::shared_ptr<VideoSource> VideoSource::Create(){
#ifdef __ANDROID__
	//return std::make_shared<VideoSourceAndroid>();
	return nullptr;
#endif
	return nullptr;
}

bool VideoSource::Failed(){
	return failed;
}

std::string VideoSource::GetErrorDescription(){
	return error;
}

std::vector<uint32_t> VideoSource::GetAvailableEncoders(){
#ifdef __ANDROID__
	return VideoSourceAndroid::availableEncoders;
#elif defined(__APPLE__) && !defined(TARGET_OSX32)
	return VideoToolboxEncoderSource::GetAvailableEncoders();
#else
	// webOS: real H.264 encode happens natively via mediaserver's clonk pipeline, bridged in
	// by VoipKitVideoSource (see voipkit-tgvoip.cpp) -- this platform was never given its own
	// VideoSource subclass upstream, so without this branch SetupOutgoingVideoStream() always
	// finds zero codecs in common and our own PKT_INIT always advertises zero encoders.
	return std::vector<uint32_t>{CODEC_AVC};
#endif
}
