echo "=== POST play WKZO-CWeOVA (official ATV) ==="
curl -s -X POST -H "Content-Type: application/json" -d '{"trackId":"WKZO-CWeOVA"}' http://127.0.0.1:8730/provider/youtube/play
echo
sleep 4
echo "=== /stream/status after 4s ==="
curl -s http://127.0.0.1:8730/stream/status
echo
echo "=== stop ==="
curl -s -X POST http://127.0.0.1:8730/stream/stop
echo
