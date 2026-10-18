#!/bin/sh
# Run ON THE DEVICE from a root shell, AFTER closing Atlas / when the device is idle (load < ~2).
# Restarts the plugin host so Signal re-logs-in and callLunaInit registers com.palm.signal.call,
# then verifies. (luna-send writes its reply to STDERR, hence 2>&1 everywhere.)
echo "load before: $(cat /proc/loadavg)"

echo "restarting imlibpurpletransport..."
kill $(pidof imlibpurpletransport) 2>/dev/null
sleep 2

echo "waiting for Signal to log back in + the call service to register (up to ~3 min)..."
i=0
while [ $i -lt 45 ]; do
  if ls-monitor -l 2>/dev/null | grep -qi 'com.palm.signal.call'; then
    echo "com.palm.signal.call REGISTERED after ~$((i*4))s"
    break
  fi
  i=$((i+1)); sleep 4
done

echo "=== verify ==="
ls-monitor -l 2>/dev/null | grep -i 'signal.call' || echo "  still not on bus - check /var/log/messages for prpl-signal login + 'com.palm.signal.call registered'"
echo "callStateQuery (expect returnValue:true, lines:[]):"
luna-send -n 1 -f palm://com.palm.signal.call/callStateQuery '{}' 2>&1 | sed -n 's/.*payload //p' | head -1
echo "load after: $(cat /proc/loadavg)"
echo "=== if registered: place a Signal voice call to this account -> the Phone app should ring ==="
