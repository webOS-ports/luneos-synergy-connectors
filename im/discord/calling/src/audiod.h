// audiod.h — drive webOS audiod so the phone audio scenario routes the call.
//
// Mirrors the wacallm / tdlib-purple recipe:
//   palm://com.palm.audio/phone/CallStatusUpdate  {lines:[{state:active,calls:[...]}]}
//   palm://com.palm.audio/phone/setCurrentScenario {scenario:"phone_back_speaker"}
//
// PRODUCTION NOTE: wacallm issues these via LSCallOneReply on a private luna handle.
// This foundation shells out to `luna-send` instead, so the client stays a standalone
// binary with no liblunaservice link dependency (which is not set up in this build).
// A packaged webOS SERVICE should switch to LSCallOneReply (see wacallm svc/main.c).
#pragma once

namespace dv {
void audiod_call_active(bool on);   // on=true -> phone scenario + loudspeaker; false -> off
}
