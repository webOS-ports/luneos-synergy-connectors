package main

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/types"
)

/*
 * This function will try to query group information from WhatsApp servers.
 * Upon immediate success, the list of participants is returned.
 * In case of failure (e.g. due to timeout), the function will return nil and retry in background.
 * Upon delayed success, the response is fed to purple asynchronously.
 */
func (handler *Handler) query_group_participants_retry(group_jid types.JID, seconds_backoff int, max_retries int, retry_count int) []types.GroupParticipant {
	group, err := handler.client.GetGroupInfo(context.TODO(), group_jid)
	if err == nil && group != nil {
		// webOS: ALWAYS push the group name/subject, not only on a delayed retry. Previously the immediate
		// success path (retry_count==0, the common case) returned participants WITHOUT calling
		// purple_update_group, so a group whose info loaded on the first try never got its subject and the
		// chat showed the raw JID.
		purple_update_group(handler.account, group)
		if retry_count == 0 {
			return group.Participants
		}
	} else {
		consequence := "Giving up."
		if retry_count < max_retries {
			consequence = "Retrying…"
			go func() {
				time.Sleep(time.Duration(seconds_backoff) * time.Second)
				handler.query_group_participants_retry(group_jid, seconds_backoff, max_retries, retry_count+1)
			}()
		}
		handler.log.Infof("Cannot get group information due to %#v. %s", err, consequence)
	}
	return []types.GroupParticipant{}
}
