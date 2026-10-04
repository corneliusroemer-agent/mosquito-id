#!/bin/bash
# One arm of the alternating A/B: serve `dist/$ARM` on 4299, run the bench,
# stop the server. Alternating arms within one round means any drift on a
# shared box lands on both arms rather than on whichever ran second.
set -euo pipefail
cd "$(dirname "$0")/.."
ARM="$1"; ROUND="$2"
rm -rf dist
ln -s "dist-$ARM" dist
nohup npx vite preview --host 127.0.0.1 --port 4299 --strictPort > "/tmp/prev-$ARM.log" 2>&1 &
SRV=$!
for i in $(seq 1 40); do
  sleep 0.5
  code=$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:4299/" || true)
  [ "$code" = "200" ] && break
done
[ "$code" = "200" ] || { echo "preview did not come up on 4299 (got ${code:-none})"; kill $SRV 2>/dev/null; exit 1; }
PORT=4299 OUT="/tmp/resample-$ARM-$ROUND.json" node bench/resample.mjs > "/tmp/resample-$ARM-$ROUND.log" 2>&1 || echo "BENCH FAILED $ARM $ROUND"
kill $SRV 2>/dev/null || true
wait $SRV 2>/dev/null || true
rm -f dist
echo "done $ARM round$ROUND"
