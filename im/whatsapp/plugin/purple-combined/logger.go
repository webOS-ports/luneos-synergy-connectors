package main

import (
	"fmt"
	"strings"
	"sync/atomic"

	waLog "go.mau.fi/whatsmeow/util/log"
)

// Diagnostic: proves whether whatsmeow's own Debugf calls (cli.sendLog/cli.recvLog, every
// outgoing node as marshaled and every incoming node as parsed) reach this function at all,
// independent of the call-signaling content filter below -- despite firing on every single
// stanza, none were ever observed in imstdout.log, and this isolates "never called" from
// "filter doesn't match every shape we expect."
var debugfCallCount atomic.Uint64

type purpleLogger struct {
	account *PurpleAccount
	topic   string
}

func (l *purpleLogger) formatf(msg string, args ...interface{}) string {
	return fmt.Sprintf("[%s] %s\n", l.topic, fmt.Sprintf(msg, args...))
}

// numeric error level values corresponding to PurpleDebugLevel defined in libpurple/debug.h.

func (l *purpleLogger) Debugf(msg string, args ...interface{}) {
	// Diagnostic: level 1 (MISC/debug) is filtered out somewhere in libpurple's own debug
	// plumbing -- every "wire-level" fmt.Fprintln/log.Info in this codebase has always used
	// level 2+, and whatsmeow's own cli.sendLog/cli.recvLog.Debugf calls (client.go:914,835 --
	// every outgoing node as ACTUALLY marshaled and every incoming node as ACTUALLY parsed)
	// were never once observed in imstdout.log despite firing on every single stanza all
	// session. Promote only lines that look like call signaling to level 2, so this stays
	// quiet (and low-volume) for the rest of the account's traffic (messages, receipts,
	// presence) while giving direct wire-level visibility into the offer/accept/preaccept
	// exchange -- something never directly inspected before, only our own Node-construction
	// code and the already-parsed ev.Data our other diagnostic logging separately dumped.
	formatted := l.formatf(msg, args...)
	if strings.Contains(formatted, "call-id") || strings.Contains(formatted, "<offer") ||
		strings.Contains(formatted, "<accept") || strings.Contains(formatted, "<preaccept") ||
		strings.Contains(formatted, "<call ") {
		purple_debug(2, formatted)
		return
	}
	if n := debugfCallCount.Add(1); n <= 5 || n%200 == 0 {
		purple_debug(2, fmt.Sprintf("[DebugfProbe #%d topic=%s] %s", n, l.topic, formatted))
	}
	purple_debug(1, formatted)
}
func (l *purpleLogger) Infof(msg string, args ...interface{}) {
	purple_debug(2, l.formatf(msg, args...))
}
func (l *purpleLogger) Warnf(msg string, args ...interface{}) {
	purple_debug(3, l.formatf(msg, args...))
}
func (l *purpleLogger) Errorf(msg string, args ...interface{}) {
	// TODO: find out which calls to Log.Errorf need to be handled with purple_error
	purple_debug(4, l.formatf(msg, args...))
}

func (l *purpleLogger) Sub(topic string) waLog.Logger {
	return &purpleLogger{account: l.account, topic: fmt.Sprintf("%s/%s", l.topic, topic)}
}

func PurpleLogger(account *PurpleAccount, topic string) waLog.Logger {
	return &purpleLogger{account: account, topic: topic}
}
