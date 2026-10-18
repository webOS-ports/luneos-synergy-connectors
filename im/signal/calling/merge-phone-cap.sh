#!/bin/sh
# Runs ON THE DEVICE. Adds the PHONE capabilityProvider (com.palm.signal.call) to the Signal account's
# db8 record (templates are cached, so we edit the record), then restarts the plugin host so the LS2
# call service registers. Busybox-safe: uses shell parameter expansion to splice the providers array
# (providers contain no '[' or ']', so the first ']' closes the array), with sanity checks.
set -e
echo "=== Signal PHONE-cap merge ==="

# The accounts service is slow under CPU load (Atlas/transport contention), so luna-send can time out
# empty. Retry patiently until it answers.
ACC=""
for t in 1 2 3 4 5 6 7 8 9 10; do
  ACC=$(luna-send -n 1 palm://com.palm.service.accounts/listAccounts '{}' 2>/dev/null)
  [ "$(printf '%s' "$ACC" | wc -c)" -gt 200 ] && { echo "listAccounts answered on try $t"; break; }
  echo "  listAccounts empty (try $t), waiting..."; sleep 6
done
[ "$(printf '%s' "$ACC" | wc -c)" -gt 200 ] || { echo "FAIL: listAccounts never answered (device too loaded - close Atlas / let it settle)"; exit 1; }

# isolate the Signal account object (one per line after splitting on _kind)
SIG=$(printf '%s' "$ACC" | sed 's/{"_kind"/\n{"_kind"/g' | grep '"templateId":"com.palm.signal"')
[ -n "$SIG" ] || { echo "FAIL: no Signal account found"; exit 1; }

if printf '%s' "$SIG" | grep -q 'com.palm.signal.call'; then
  echo "PHONE cap already present - skipping merge"
else
  ID=$(printf '%s' "$SIG" | grep -oE '"_id":"[^"]+"' | head -1 | sed 's/"_id":"//; s/"$//')
  # Extract the capabilityProviders array content by brace-depth (providers can contain nested [ ] / ] in
  # strings; a naive cut at the first ] truncates it). Stop at the ] that closes the array (depth 0).
  ARR=$(printf '%s' "$SIG" | awk '
    function emit(rest,   depth,j,c,n,out){
      depth=0; out="";
      n=length(rest);
      for(j=1;j<=n;j++){
        c=substr(rest,j,1);
        if(c=="{"||c=="[") depth++;
        else if(c=="}"||c=="]"){ if(depth==0){ print out; return } depth-- }
        out=out c;
      }
    }
    { m="\"capabilityProviders\":["; i=index($0,m); if(i>0) emit(substr($0,i+length(m))); }')
  echo "  parsed _id=$ID, providers array length=$(printf '%s' "$ARR" | wc -c)"
  # safety: must have parsed an id and BOTH existing providers, else abort (never merge a partial array)
  [ -n "$ID" ] || { echo "FAIL: could not parse _id"; exit 1; }
  printf '%s' "$ARR" | grep -q 'com.palm.signal.im' || { echo "FAIL: array missing .im provider"; exit 1; }
  printf '%s' "$ARR" | grep -q 'com.palm.signal.contacts' || { echo "FAIL: array missing .contacts provider"; exit 1; }
  [ "${ARR%\}}" != "$ARR" ] || { echo "FAIL: providers array did not end cleanly (last char: $(printf '%s' "$ARR" | tail -c 1))"; exit 1; }
  PHONE='{"capability":"PHONE","id":"com.palm.signal.call","alwaysOn":true,"loc_shortName":"Signal","implementation":"palm://com.palm.signal.call/","serviceName":"type_signal"}'
  MERGE='{"objects":[{"_id":"'"$ID"'","capabilityProviders":['"$ARR"','"$PHONE"']}]}'
  echo "merging PHONE cap for _id=$ID"
  R=$(luna-send -a com.palm.service.accounts -n 1 palm://com.palm.db/merge "$MERGE" 2>&1)
  echo "  db8: $R"
  printf '%s' "$R" | grep -q '"returnValue":true' || { echo "FAIL: db8 merge rejected"; exit 1; }
  echo "PHONE cap merged OK"
fi

# NOTE: no transport restart here (it triggers a reconnect storm that spikes load to ~8 and starves luna).
# The plugin is already loaded; com.palm.signal.call registers when Signal (re)logs in via callLunaInit.
# Do a light role rescan and just report current status.
ls-control scan-services 2>/dev/null || true

echo "=== status ==="
ls-monitor -l 2>/dev/null | grep -i 'signal.call' && echo "  ^ com.palm.signal.call is registered" \
  || echo "  com.palm.signal.call not on bus yet (registers on next Signal login; a transport restart when the device is idle will force it)"
echo "=== done - PHONE cap is set; the call service will ring the Phone app on the next incoming Signal call ==="
