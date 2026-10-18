#ifndef WA_DENOISE_H
#define WA_DENOISE_H
// webOS WhatsApp calling: WebRTC noise-suppression on the outbound mic. The mic captures via the
// analog IN1L route with NO audiod DSP (the voip capture path applies none, unlike the recording
// path voice notes use), so the peer hears heavy background noise. Run the raw int16 mic frames
// through WebRTC's float NS (harvested from libtgvoip/webrtc_dsp) before they reach meowcaller.
// Called only from the capture thread (single-threaded w.r.t. the NS handle).
void wa_ns_start(int fs);              // create + init the NS for the capture rate (16000)
void wa_ns_process(short *buf, int n); // denoise n int16 samples IN PLACE (processes floor(n/frame) 10ms frames)
void wa_ns_stop(void);                 // free the NS handle
#endif
