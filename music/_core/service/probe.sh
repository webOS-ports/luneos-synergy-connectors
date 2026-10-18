echo "=== /providers ==="
curl -s http://127.0.0.1:8730/providers
echo
echo "=== youtube search 'birds of a feather' ==="
curl -s "http://127.0.0.1:8730/provider/youtube/search?q=birds%20of%20a%20feather%20billie%20eilish&limit=3"
echo
