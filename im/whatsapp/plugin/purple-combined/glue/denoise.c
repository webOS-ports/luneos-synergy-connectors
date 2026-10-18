#include "denoise.h"
#include "modules/audio_processing/ns/noise_suppression.h"
#include <stddef.h>
#include <math.h>
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// WebRTC float NS processes exactly one 10ms frame (fs/100 samples) per call, in the int16 value
// range as float (NOT normalized to +/-1). For <=16kHz it is a single band. The WhatsApp mic frame
// is 320 samples @ 16kHz (20ms) -> 2 sub-frames of 160.
// NS_ENABLE default OFF. Objective measurement (PESQ MOS over the real MLow round-trip, see
// scratchpad quality.py) proved the pre-codec WebRTC NS HURTS: it drops MLow output ~1 MOS on clean
// input (3.35->2.27) AND on noisy input (2.31->1.94), monotonically worse with a higher policy. MLow
// is CELP with its own internal noise model (mlow/noise.go); pre-suppressing corrupts the signal
// statistics its LPC/pitch analysis relies on -- double-processing. A real WhatsApp client feeds the
// mic straight to MLow, so we do too. Kept behind the flag for a future Opus path (Opus is waveform,
// not parametric, and may benefit from NS).
#define NS_ENABLE 0
static NsHandle *g_ns = NULL;
static int g_frame = 160; // fs/100

// ---- OPTIONAL low-shelf (default OFF). Offline measurement of the raw voipsource mic showed it is
// already WARM (tilt -3.1 dB/oct, centroid 637Hz, full 102..7898Hz band) and the NS keeps it warm at
// every policy -- so a low-shelf here only ADDS mud. Left in, gated by EQ_ENABLE, for the day a
// different mic route needs spectral shaping. RBJ biquad, Direct Form II transposed. ----
#define EQ_ENABLE 0
#define EQ_LOWSHELF_HZ 320.0
#define EQ_LOWSHELF_DB 6.0
#define EQ_OUTPUT_GAIN 0.85
static double eq_b0, eq_b1, eq_b2, eq_a1, eq_a2, eq_z1, eq_z2;

static void eq_init(int fs) {
	double A = pow(10.0, EQ_LOWSHELF_DB / 40.0);
	double w0 = 2.0 * M_PI * EQ_LOWSHELF_HZ / (double)fs;
	double cw = cos(w0), sw = sin(w0);
	double S = 0.9; // shelf slope
	double alpha = sw / 2.0 * sqrt((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0);
	double sqrtA = sqrt(A);
	double a0 = (A + 1) + (A - 1) * cw + 2 * sqrtA * alpha;
	eq_b0 =        A * ((A + 1) - (A - 1) * cw + 2 * sqrtA * alpha) / a0;
	eq_b1 =    2 * A * ((A - 1) - (A + 1) * cw)                     / a0;
	eq_b2 =        A * ((A + 1) - (A - 1) * cw - 2 * sqrtA * alpha) / a0;
	eq_a1 =       -2 * ((A - 1) + (A + 1) * cw)                     / a0;
	eq_a2 =           ((A + 1) + (A - 1) * cw - 2 * sqrtA * alpha)  / a0;
	eq_z1 = eq_z2 = 0.0;
}
static float eq_sample(float x) {
	double y = eq_b0 * x + eq_z1;
	eq_z1 = eq_b1 * x - eq_a1 * y + eq_z2;
	eq_z2 = eq_b2 * x - eq_a2 * y;
	return (float)(y * EQ_OUTPUT_GAIN);
}

void wa_ns_start(int fs) {
	wa_ns_stop();
	if (!NS_ENABLE || fs <= 0) return; // NS off -> g_ns stays NULL -> wa_ns_process is a pass-through
	g_frame = fs / 100;
	if (EQ_ENABLE) eq_init(fs);
	g_ns = WebRtcNs_Create();
	if (g_ns) {
		if (WebRtcNs_Init(g_ns, (unsigned int)fs) != 0) { WebRtcNs_Free(g_ns); g_ns = NULL; return; }
		// policy 0..3 = mild..very aggressive. 2 balances noise removal against musical-noise/voice
		// artifacts on this analog mic; bump to 3 if the peer still hears too much floor.
		WebRtcNs_set_policy(g_ns, 2);
	}
}

void wa_ns_process(short *buf, int n) {
	if (!g_ns || g_frame <= 0) return;
	float in[480], out[480]; // max one 10ms frame @ 48kHz
	int off = 0;
	while (off + g_frame <= n) {
		int i;
		for (i = 0; i < g_frame; i++) in[i] = (float)buf[off + i];
		WebRtcNs_Analyze(g_ns, in);
		{
			const float *const bands_in[1] = { in };
			float *const bands_out[1] = { out };
			WebRtcNs_Process(g_ns, bands_in, 1, bands_out);
		}
		for (i = 0; i < g_frame; i++) {
			float v = EQ_ENABLE ? eq_sample(out[i]) : out[i]; // optional low-shelf AFTER noise suppression
			if (v > 32767.0f) v = 32767.0f; else if (v < -32768.0f) v = -32768.0f;
			buf[off + i] = (short)v;
		}
		off += g_frame;
	}
	// any tail < one frame (rare short read) passes through un-processed
}

void wa_ns_stop(void) {
	if (g_ns) { WebRtcNs_Free(g_ns); g_ns = NULL; }
}
