#!/usr/bin/env bash
# Build the read-only dashboard demo: the real dashboard UI plus a recorded
# snapshot of the seeded "acme" demo workspace, as a static site.
#
#   bash scripts/demo/build-demo.sh <output-dir> [port]
#
# The output is self-contained (index.html, assets/, data/) and works from any
# static host under any path, e.g. devintern.com/demo/. Timestamps in the
# snapshot are shifted to the viewer's clock on load, so it stays "live"
# looking; rebuild it now and then so the stats windows keep their shape.
#
# Seeds and serves inside the same bubblewrap namespace as capture.sh, so the
# workspace appears at /srv/devintern and nothing under ~/.devintern is
# read or written.
set -euo pipefail

OUT="$(realpath -m "${1:?output dir required}")"
PORT="${2:-4412}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)" # packages/dashboard-ui
DATA="$(mktemp -d)"
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$DATA" "$DATA.log"' EXIT

SANDBOX=(bwrap --die-with-parent --dev-bind / / --tmpfs /srv --bind "$DATA" /srv/devintern
  --setenv DEVINTERN_WORKSPACE_DIR /srv/devintern --setenv HOME /home/worker
  --setenv DASHBOARD_TAILSCALE_AUTODETECT 0)

# The live server needs the regular build to start; the demo build replaces it below.
(cd "$HERE" && bun run build >/dev/null)
(cd "$HERE" && "${SANDBOX[@]}" bun run scripts/demo/seed.ts /srv/devintern)
(cd "$HERE" && exec "${SANDBOX[@]}" bun run scripts/demo/serve.ts /srv/devintern "$PORT") >"$DATA.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 40); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { cat "$DATA.log"; exit 1; }

(cd "$HERE" && VITE_DASHBOARD_DEMO=1 bun x vite build --base ./ --outDir "$OUT" --emptyOutDir >/dev/null)
(cd "$HERE" && bun run scripts/demo/snapshot.ts "http://127.0.0.1:$PORT" "$OUT/data")
echo "Demo site written to $OUT; serve it with any static file server"
