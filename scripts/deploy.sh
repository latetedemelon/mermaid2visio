#!/usr/bin/env bash
# Deploy mermaid2visio to a remote host. Run from your workstation, not from
# the target. Builds the image locally, streams it over SSH (no registry, no
# intermediate file), drops the compose file + .env in /opt/mermaid2visio on
# the target, and starts the container.
#
# Defaults match the task:  TARGET=root@192.168.2.83  HOST_PORT=3333
# Override via env or flags.
#
# Examples:
#   ./scripts/deploy.sh                              # all defaults
#   HOST_PORT=8080 ./scripts/deploy.sh               # publish on host port 8080
#   TARGET=root@10.0.0.5 ./scripts/deploy.sh         # different target
#   ./scripts/deploy.sh --port 8080 --target root@10.0.0.5
#
# Auth: prefers SSH keys. If you only have a password, prefix with sshpass:
#   SSHPASS='your-password' sshpass -e ./scripts/deploy.sh
# (sshpass is in every distro's repos: `apt install sshpass`, `brew install hudochenkov/sshpass/sshpass`.)

set -euo pipefail

TARGET="${TARGET:-root@192.168.2.83}"
HOST_PORT="${HOST_PORT:-3333}"
PORT="${PORT:-3333}"
SHM_SIZE="${SHM_SIZE:-512m}"
REMOTE_DIR="${REMOTE_DIR:-/opt/mermaid2visio}"
IMAGE_TAG="${IMAGE_TAG:-mermaid2visio:latest}"

while [ $# -gt 0 ]; do
    case "$1" in
        --target)    TARGET="$2"; shift 2;;
        --port)      HOST_PORT="$2"; shift 2;;
        --shm-size)  SHM_SIZE="$2"; shift 2;;
        --remote-dir) REMOTE_DIR="$2"; shift 2;;
        -h|--help)
            sed -n '2,20p' "$0"; exit 0;;
        *)
            echo "Unknown arg: $1" >&2; exit 2;;
    esac
done

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- Preflight on this workstation ------------------------------------------
step "Preflight (local)"
command -v docker >/dev/null || fail "docker not found on this workstation"
command -v ssh    >/dev/null || fail "ssh not found on this workstation"
command -v scp    >/dev/null || fail "scp not found on this workstation"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
[ -f Dockerfile ] || fail "Dockerfile not at $REPO_ROOT — run from the repo"
[ -f docker-compose.yml ] || fail "docker-compose.yml not at $REPO_ROOT"
[ -f .env.example ] || fail ".env.example not at $REPO_ROOT"
ok "docker, ssh, scp available; repo looks right"

# --- Preflight on the target ------------------------------------------------
step "Preflight ($TARGET)"
ssh -o StrictHostKeyChecking=accept-new "$TARGET" 'command -v docker >/dev/null && docker version --format "{{.Server.Version}}" 2>/dev/null' \
    || fail "Target lacks docker (or unreachable). Install: curl -fsSL https://get.docker.com | sh && systemctl enable --now docker"
ssh "$TARGET" 'docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1' \
    || fail "Target lacks docker compose plugin"

# Will the host port we picked actually be free?
if ssh "$TARGET" "ss -lnt '( sport = :$HOST_PORT )' 2>/dev/null | grep -q LISTEN || netstat -lnt 2>/dev/null | awk '{print \$4}' | grep -q ':$HOST_PORT\$'"; then
    fail "Host port $HOST_PORT is already in use on the target. Pick another: HOST_PORT=8080 $0"
fi
ok "target ready; host port $HOST_PORT is free"

# --- Build the image locally ------------------------------------------------
step "Build image ($IMAGE_TAG)"
docker build -t "$IMAGE_TAG" .
ok "image built"

# --- Ship & install on target ----------------------------------------------
step "Ship image to $TARGET (streamed; no intermediate file)"
docker save "$IMAGE_TAG" | ssh "$TARGET" 'docker load'
ok "image loaded on target"

step "Stage compose file + .env on $TARGET:$REMOTE_DIR"
# Build the .env from the current run's values (rather than copying .env.example
# verbatim) so HOST_PORT/PORT/SHM_SIZE actually take effect on first up.
ENV_CONTENT="HOST_PORT=$HOST_PORT
PORT=$PORT
SHM_SIZE=$SHM_SIZE
"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"
scp -q docker-compose.yml "$TARGET:$REMOTE_DIR/docker-compose.yml"
printf '%s' "$ENV_CONTENT" | ssh "$TARGET" "cat > '$REMOTE_DIR/.env'"
ok "compose + .env in place"

# --- Start the container ---------------------------------------------------
step "Start container"
# `docker compose up -d` with the local image (no rebuild) — we just loaded
# IMAGE_TAG and the compose file's `build:` section doesn't run unless asked.
ssh "$TARGET" "cd '$REMOTE_DIR' && docker compose up -d && docker compose ps"
ok "container started"

# --- Wait for healthcheck --------------------------------------------------
step "Wait for healthcheck to pass (up to 60s)"
ATTEMPTS=20
SLEEP=3
for i in $(seq 1 $ATTEMPTS); do
    STATUS=$(ssh "$TARGET" "docker inspect --format '{{.State.Health.Status}}' mermaid2visio 2>/dev/null || echo unknown")
    case "$STATUS" in
        healthy)  ok "container healthy"; break;;
        unhealthy) fail "container went unhealthy — check: ssh $TARGET 'cd $REMOTE_DIR && docker compose logs --tail=200'";;
    esac
    if [ "$i" = "$ATTEMPTS" ]; then
        fail "healthcheck never passed (last status: $STATUS). Logs: ssh $TARGET 'cd $REMOTE_DIR && docker compose logs --tail=200'"
    fi
    sleep "$SLEEP"
done

# --- End-to-end smoke test -------------------------------------------------
step "Smoke test (HTTP, /browser, full convert round-trip)"
HOST_FOR_SMOKE="${TARGET#*@}"
BASE="http://$HOST_FOR_SMOKE:$HOST_PORT"

curl -sS -o /dev/null -w '  GET %{url_effective} -> HTTP %{http_code}\n' "$BASE/"
curl -sS -o /dev/null -w '  GET %{url_effective} -> HTTP %{http_code}\n' "$BASE/browser"
curl -sS -o /dev/null -w '  GET %{url_effective} -> HTTP %{http_code}\n' "$BASE/browser/app.js"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
curl -sS -X POST "$BASE/convert" \
    -H 'Content-Type: text/plain' \
    --data-binary $'flowchart TD\n A[Start] --> B[End]' \
    -o "$TMPDIR/out.vsdx"
SIZE=$(stat -c%s "$TMPDIR/out.vsdx" 2>/dev/null || stat -f%z "$TMPDIR/out.vsdx")
HEAD2=$(head -c 2 "$TMPDIR/out.vsdx" | xxd -p)
if [ "$HEAD2" = "504b" ] && [ "$SIZE" -gt 2000 ]; then
    ok "convert returned a $SIZE-byte ZIP (VSDX)"
else
    fail "convert returned a $SIZE-byte response without ZIP header (got 0x$HEAD2)"
fi

printf '\n\033[1;32m✓ Deploy complete.\033[0m  Editor:   %s/\n                       Browser:  %s/browser\n\n' "$BASE" "$BASE"
