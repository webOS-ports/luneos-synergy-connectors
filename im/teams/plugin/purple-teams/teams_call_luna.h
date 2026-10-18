/*
 * Teams NGC calling - webOS LS2 bridge to the stock Phone app (CallSynergizer).
 * webOS Synergy Revival.
 *
 * Registers com.palm.teams.call (dial/answer/disconnect/callStateQuery), exactly like the
 * Telegram (com.palm.telegram.call) and WhatsApp mediators, so the stock dialer / in-call
 * screen / call log drive Teams calls with no custom UI. Runs inside imlibpurpletransport on
 * libpurple's glib mainloop. The signaling + (eventually) media live in teams_calling.c;
 * this only translates the webOS call contract to/from teams_calling_{dial,answer,hangup}
 * and pushes teams_calling's state transitions to callStateQuery subscribers.
 *
 * webOS-only: compiled by build-teams.sh (which links luna-service2), NOT by the upstream
 * Makefile.
 */

#ifndef TEAMS_CALL_LUNA_H
#define TEAMS_CALL_LUNA_H

#include "libteams.h"

/* Register the com.palm.teams.call service (idempotent) and bind it to this Teams account.
 * Also registers the teams_calling state callback so call-state transitions reach the Phone
 * app. Call when the account finishes logging in. Returns FALSE (and logs) on LS2 failure. */
gboolean teams_call_luna_init(TeamsAccount *sa);

/* Unbind the account (service stays registered for the process lifetime). */
void teams_call_luna_shutdown(TeamsAccount *sa);

/* Drive audiod's phone scenario so the media engine's voip/voipsource PCMs carry real
 * loudspeaker/mic audio. Called with TRUE when a call goes active, FALSE on hangup. */
void teams_call_luna_set_audio(gboolean active);

#endif /* TEAMS_CALL_LUNA_H */
