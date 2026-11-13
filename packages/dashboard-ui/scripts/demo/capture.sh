#!/usr/bin/env bash
# Regenerate the marketing dashboard screenshots from a seeded demo workspace.
#
#   bash scripts/demo/capture.sh <output-dir> [port]
#
# Runs the seed and the real dashboard inside a bubblewrap mount namespace so
# the workspace appears at /srv/devintern (the path the Workspace view prints),
# against a throwaway data directory. Nothing under ~/.devintern is read or
# written, and no other dashboard instance is touched.
set -euo pipefail

OUT="$(realpath -m "${1:?output dir required}")"
PORT="${2:-4410}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)" # packages/dashboard-ui
DATA="$(mktemp -d)"
PROFILE="$(mktemp -d)"
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$DATA" "$DATA.log" "$PROFILE"' EXIT

SANDBOX=(bwrap --die-with-parent --dev-bind / / --tmpfs /srv --bind "$DATA" /srv/devintern
  --setenv DEVINTERN_WORKSPACE_DIR /srv/devintern --setenv HOME /home/worker)

(cd "$HERE" && bun run build >/dev/null)
(cd "$HERE" && "${SANDBOX[@]}" bun run scripts/demo/seed.ts /srv/devintern)
(cd "$HERE" && exec "${SANDBOX[@]}" bun run scripts/demo/serve.ts /srv/devintern "$PORT") >"$DATA.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 40); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.25; done

RUN_ID="$(curl -s "http://127.0.0.1:$PORT/api/runs?limit=200" |
  bun -e 'const r=await Bun.stdin.json();console.log(r.runs.find((x:any)=>x.taskKey==="PROJ-1842").id)')"

mkdir -p "$OUT"
shoot() { # <file> <hash route>
  /usr/bin/chromium --headless=new --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1440,900 --virtual-time-budget=8000 --user-data-dir="$PROFILE" \
    --screenshot="$OUT/$1" "http://127.0.0.1:$PORT/#$2" >/dev/null 2>&1
}
shoot run-detail.png "/runs/$RUN_ID"
shoot runs.png "/runs"
shoot pull-requests.png "/prs"
shoot automations.png "/automations"
shoot workspace.png "/workspace"
echo "Screenshots written to $OUT"
