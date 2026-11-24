#!/usr/bin/env bash
# Build the read-only dashboard demo: the real dashboard UI plus a recorded
# snapshot, as a static site.
#
#   bash scripts/demo/build-demo.sh <output-dir> [--port N]
#       Fictional "acme" workspace (seed.ts).
#
#   bash scripts/demo/build-demo.sh <output-dir> --from-workspace ~/.devintern \
#       --repo devintern --repo getdevintern/devintern \
#       [--exclude-automation <id>]... [--secrets-from <dotenv>]... [--deny <name>]...
#       A real workspace, reduced to the allowlisted repositories
#       (copy-workspace.ts) and recorded with scrubbing (snapshot.ts --scrub).
#       Every other repository the workspace knows is denied automatically;
#       env files under <workspace>/env are always treated as secrets, and
#       debug artifacts (raw agent dumps) are left out. Writes
#       <output-dir>.report.json listing what was dropped; review it and the
#       output before publishing. Exits non-zero if scrubbing left a leak.
#
# The output is self-contained (index.html, assets/, data/) and works from any
# static host under any path, e.g. devintern.com/demo/dashboard/. Timestamps
# are shifted to the viewer's clock on load; rebuild now and then so the
# stats windows keep their shape.
#
# The dashboard runs inside the same bubblewrap namespace as capture.sh, so
# the workspace appears at /srv/devintern and the real workspace is never
# opened for writing.
set -euo pipefail

OUT="$(realpath -m "${1:?output dir required}")"
shift
PORT=4412
FROM=""
REPOS=()
SNAPSHOT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --from-workspace) FROM="$(realpath "$2")"; shift 2 ;;
    --repo) REPOS+=(--repo "$2"); shift 2 ;;
    --exclude-automation) REPOS+=(--exclude-automation "$2"); shift 2 ;;
    --secrets-from) SNAPSHOT_ARGS+=(--secrets-from "$(realpath "$2")"); shift 2 ;;
    --deny) SNAPSHOT_ARGS+=(--deny "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/../.." && pwd)" # packages/dashboard-ui
DATA="$(mktemp -d)"
trap 'kill "${SERVER_PID:-0}" 2>/dev/null || true; rm -rf "$DATA" "$DATA.log"' EXIT

SANDBOX=(bwrap --die-with-parent --dev-bind / / --tmpfs /srv --bind "$DATA" /srv/devintern
  --setenv DEVINTERN_WORKSPACE_DIR /srv/devintern --setenv HOME /home/worker
  --setenv DASHBOARD_TAILSCALE_AUTODETECT 0)

# The live server needs the regular build to start; the demo build replaces it below.
(cd "$HERE" && bun run build >/dev/null)
if [ -n "$FROM" ]; then
  [ ${#REPOS[@]} -gt 0 ] || { echo "--from-workspace needs at least one --repo" >&2; exit 1; }
  (cd "$HERE" && bun run scripts/demo/copy-workspace.ts --from "$FROM" --to "$DATA" "${REPOS[@]}" \
    --db-path-as /srv/devintern/state/queue.db)
  while IFS= read -r name; do
    [ -n "$name" ] && SNAPSHOT_ARGS+=(--deny "$name")
  done <"$DATA/demo-deny.txt"
  for env in "$FROM"/env/*.env; do
    [ -f "$env" ] && SNAPSHOT_ARGS+=(--secrets-from "$env")
  done
  SNAPSHOT_ARGS+=(--scrub --skip-artifact-kind debug --report "$OUT.report.json")
else
  (cd "$HERE" && "${SANDBOX[@]}" bun run scripts/demo/seed.ts /srv/devintern)
fi
(cd "$HERE" && exec "${SANDBOX[@]}" bun run scripts/demo/serve.ts /srv/devintern "$PORT") >"$DATA.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 40); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { cat "$DATA.log"; exit 1; }

(cd "$HERE" && VITE_DASHBOARD_DEMO=1 bun x vite build --base ./ --outDir "$OUT" --emptyOutDir >/dev/null)
(cd "$HERE" && bun run scripts/demo/snapshot.ts "http://127.0.0.1:$PORT" "$OUT/data" "${SNAPSHOT_ARGS[@]}")
echo "Demo site written to $OUT; serve it with any static file server"
