#include "aec.h"
#include "modules/audio_processing/aecm/echo_control_mobile.h"
#include <pthread.h>
#include <string.h>

// AECM processes fixed 10ms blocks: 160 samples at 16kHz. The mic frame (WA_FRAME=320) is 2 blocks;
// a played frame (960) is 6. farend()/process() are called from different threads, so one mutex
// guards the single AECM handle (WebRTC's AECM is not internally thread-safe across the two calls).
#define AEC_BLK 160
static void *g_aecm = NULL;
static int g_delay_ms = 0;
static pthread_mutex_t g_aec_mx = PTHREAD_MUTEX_INITIALIZER;

void wa_aec_start(int fs, int delay_ms) {
	wa_aec_stop();
	if (fs != 16000 && fs != 8000) return;
	pthread_mutex_lock(&g_aec_mx);
	g_aecm = WebRtcAecm_Create();
	if (g_aecm) {
		if (WebRtcAecm_Init(g_aecm, fs) != 0) {
			WebRtcAecm_Free(g_aecm);
			g_aecm = NULL;
		} else {
			AecmConfig cfg;
			cfg.cngMode = AecmTrue; // comfort noise in the cancelled gaps
			cfg.echoMode = 3;       // 0..4; 3 = default aggressiveness, 4 = most
			WebRtcAecm_set_config(g_aecm, cfg);
			g_delay_ms = delay_ms;
		}
	}
	pthread_mutex_unlock(&g_aec_mx);
}

void wa_aec_farend(const short *f, int n) {
	pthread_mutex_lock(&g_aec_mx);
	if (g_aecm) {
		int off = 0;
		while (off + AEC_BLK <= n) {
			WebRtcAecm_BufferFarend(g_aecm, f + off, AEC_BLK);
			off += AEC_BLK;
		}
	}
	pthread_mutex_unlock(&g_aec_mx);
}

void wa_aec_process(short *mic, int n) {
	pthread_mutex_lock(&g_aec_mx);
	if (g_aecm) {
		short out[AEC_BLK];
		int off = 0;
		while (off + AEC_BLK <= n) {
			if (WebRtcAecm_Process(g_aecm, mic + off, NULL, out, AEC_BLK, (short)g_delay_ms) == 0)
				memcpy(mic + off, out, AEC_BLK * sizeof(short));
			off += AEC_BLK;
		}
	}
	pthread_mutex_unlock(&g_aec_mx);
}

void wa_aec_stop(void) {
	pthread_mutex_lock(&g_aec_mx);
	if (g_aecm) {
		WebRtcAecm_Free(g_aecm);
		g_aecm = NULL;
	}
	pthread_mutex_unlock(&g_aec_mx);
}
