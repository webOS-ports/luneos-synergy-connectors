package mlow

// webOS device patch (NOT upstream): adaptive encoder complexity to hold the 60ms real-time budget on
// a slow ARMv7 core. The MLow reference always encodes at full complexity 8 / 100 FCB survivors; on
// dense music that pushes a frame's encode past 60ms and the send loop drops it. Here the encoder
// watches its own per-frame time and lowers the two cost knobs (FCB survivor budget + the bitrate
// controller's Complexity) when it runs long, then restores them on light frames. Lower survivors just
// pick a slightly less-optimal codeword -- the bitstream stays valid, quality dips marginally only on
// the heaviest frames. Only the single send-loop goroutine reads/writes these, so no locking.
import "time"

var (
	adaptiveFcbSurvMax = int32(smplFcbTotSurv20msMax) // 100 (max); floor adaptiveFcbSurvFloor
	adaptiveComplexity = int32(smplComplexity)        // 8 (max); floor adaptiveComplexityFloor
)

const (
	adaptiveFcbSurvFloor    = 12
	adaptiveComplexityFloor = 2
	adaptiveHighMs          = 50 // frame ran long -> back off for headroom under the 60ms budget
	adaptiveLowMs           = 38 // frame was cheap -> recover quality
)

// adaptObserve feeds one frame's measured encode time back into the complexity knobs (for the NEXT
// frame). Reactive with one frame of lag, which converges within a few frames on sustained music.
func adaptObserve(d time.Duration) {
	ms := d.Milliseconds()
	switch {
	case ms > adaptiveHighMs:
		if adaptiveFcbSurvMax > adaptiveFcbSurvFloor {
			adaptiveFcbSurvMax = adaptiveFcbSurvMax * 3 / 4
			if adaptiveFcbSurvMax < adaptiveFcbSurvFloor {
				adaptiveFcbSurvMax = adaptiveFcbSurvFloor
			}
		}
		if adaptiveComplexity > adaptiveComplexityFloor {
			adaptiveComplexity--
		}
	case ms < adaptiveLowMs:
		if adaptiveFcbSurvMax < int32(smplFcbTotSurv20msMax) {
			adaptiveFcbSurvMax += 8
			if adaptiveFcbSurvMax > int32(smplFcbTotSurv20msMax) {
				adaptiveFcbSurvMax = int32(smplFcbTotSurv20msMax)
			}
		}
		if adaptiveComplexity < int32(smplComplexity) {
			adaptiveComplexity++
		}
	}
}
