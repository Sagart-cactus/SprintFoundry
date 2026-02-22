#!/bin/bash
# Runs as the non-root 'node' user inside the container
set -e

export SPRINTFOUNDRY_ANTHROPIC_KEY=$(cat /home/node/.spf-key)
cd /home/node/work

echo "uid: $(id -u)  whoami: $(whoami)"
echo ""

echo "=== VALIDATE ==="
sprintfoundry validate

echo ""
echo "=== DRY-RUN (no git needed) ==="
sprintfoundry run --source prompt \
  --prompt "Write hello world in JavaScript" \
  --dry-run

echo ""
echo "=== REAL RUN (developer + qa agents via local_sdk) ==="
# Git identity required for checkpoint commits during agent runs
git config --global user.email "sprintfoundry@smoke.test"
git config --global user.name "SprintFoundry Smoke Test"
sprintfoundry run --source prompt \
  --prompt "Write a hello world function in JavaScript"
REAL_EXIT=$?

echo ""
echo "=== MONITOR CHECK ==="
PKG_DIR=$(npm root -g)/sprintfoundry
node "$PKG_DIR/monitor/server.mjs" --port 14310 &
MPID=$!
sleep 2

HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:14310/ 2>/dev/null || echo "000")
echo "Monitor UI HTTP: $HTTP"

RUNS=$(curl -s "http://127.0.0.1:14310/api/runs" 2>/dev/null || echo "{}")
COUNT=$(echo "$RUNS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
runs = data.get('runs', [])
statuses = [r.get('status','?') for r in runs]
print(f'{len(runs)} run(s): {statuses}')
" 2>/dev/null || echo "parse error: ${RUNS:0:100}")
echo "Monitor /api/runs: $COUNT"
kill $MPID 2>/dev/null || true

echo ""
echo "=== SUMMARY ==="
[ "$HTTP" = "200" ] && echo "PASS: monitor UI" || echo "FAIL: monitor UI (HTTP $HTTP)"
[ "$REAL_EXIT" -eq 0 ] && echo "PASS: real run completed" || echo "FAIL: real run (exit $REAL_EXIT)"

exit $REAL_EXIT
