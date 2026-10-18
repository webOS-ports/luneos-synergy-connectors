#ifndef WA_AEC_H
#define WA_AEC_H
// webOS WhatsApp calling: acoustic echo cancellation for the speakerphone. The TouchPad has no
// earpiece, so a call runs on the loudspeaker; the mic then re-captures the far-end voice coming out
// of the speaker and we send it back, so the peer hears themselves. WebRTC's mobile AEC (AECM, fixed
// point) removes it: it needs the far-end (what we PLAY) as a reference, buffered before we process
// the matching near-end (mic) frame. farend() and process() run on different threads (playback vs
// capture) so the wrapper serializes the AECM handle internally.
void wa_aec_start(int fs, int delay_ms); // create + init AECM for the capture rate; delay_ms = render->capture echo delay hint
void wa_aec_farend(const short *f, int n); // buffer the played loudspeaker reference (int16, n a multiple of 160)
void wa_aec_process(short *mic, int n);    // cancel the echo from the mic IN PLACE
void wa_aec_stop(void);
#endif
