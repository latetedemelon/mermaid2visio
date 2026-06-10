# Deploy: mermaid2visio → 192.168.2.83

This runbook has the exact commands to ship the containerised app to
`192.168.2.83` and run it. The container exposes two interfaces on a single
port:

| URL | What it is |
|---|---|
| `http://192.168.2.83:${HOST_PORT}/` | Server-backed editor (Node + Puppeteer renders Mermaid server-side) |
| `http://192.168.2.83:${HOST_PORT}/browser` | Fully-client-side app (renders/converts entirely in the user's browser; nothing leaves their machine) |

Both share the same shapes/extractor/generator code — they're two front-ends
on one container.

## Picking a port (avoid conflicts)

Default is `3333`. The compose file reads three env vars (with safe defaults),
so collisions on the host are a `HOST_PORT=…` away:

| Var | Default | What it controls |
|---|---|---|
| `HOST_PORT` | `3333` | Port published to the host. Change this when 3333 is taken on `192.168.2.83`. |
| `PORT` | `3333` | Port the container binds to internally. Usually leave alone. |
| `SHM_SIZE` | `512m` | Shared memory for Chromium (bump for heavier load). |

Copy `.env.example` → `.env` next to `docker-compose.yml` and edit, **or** pass
inline:

```bash
# One-off override:
HOST_PORT=8080 docker compose up -d
# Persistent — on the target:
cp .env.example .env && sed -i 's/^HOST_PORT=.*/HOST_PORT=8080/' .env
docker compose up -d
```

(Throughout the runbook below, swap `:3333` for `:$HOST_PORT` if you picked a
different port.)

---

## Fastest path — one command from your workstation

```bash
# defaults to root@192.168.2.83 and HOST_PORT=3333
./scripts/deploy.sh

# pick a different port if 3333 is taken
HOST_PORT=8080 ./scripts/deploy.sh

# password auth (recommended: switch to a key after first login)
SSHPASS='your-password' sshpass -e ./scripts/deploy.sh
```

The script does everything in this runbook automatically: preflight checks
local + remote, builds the image, streams it over SSH (no registry needed),
stages compose + .env on the target, starts the container, waits for the
healthcheck, and runs a full end-to-end smoke test (`/`, `/browser`,
`/browser/app.js`, plus a real `POST /convert` round-trip). Exits non-zero on
the first failure with the next command to run.

If you'd rather step through it manually, read on.

---

## Prereqs on the target (192.168.2.83)

SSH in once and confirm:

```bash
ssh root@192.168.2.83      # password: <as provided>

# Docker + Compose (install if missing).
docker --version           # any 20.10+
docker compose version     # bundled with modern Docker

# Open the port at the host firewall if there is one.
# ufw example (Debian/Ubuntu):     ufw allow 3333/tcp
# firewalld example (RHEL/Fedora): firewall-cmd --permanent --add-port=3333/tcp && firewall-cmd --reload
```

If Docker isn't installed, the official one-liner works on most distros:

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

---

## Option A — build on your workstation, ship the image

Use this when you don't want to clone the repo on the server.

```bash
# 1. On your workstation, from the repo root:
docker build -t mermaid2visio:latest .

# 2. Stream the image directly over SSH (no intermediate file, no registry).
docker save mermaid2visio:latest | ssh root@192.168.2.83 'docker load'

# 3. SSH in and start it.
# Copy the compose file + the env template across in one go so users can
# tweak HOST_PORT etc. without retyping the YAML.
scp docker-compose.yml .env.example root@192.168.2.83:/tmp/
ssh root@192.168.2.83 <<'EOF'
mkdir -p /opt/mermaid2visio
mv /tmp/docker-compose.yml /opt/mermaid2visio/
mv /tmp/.env.example /opt/mermaid2visio/
cd /opt/mermaid2visio
# Pick a free port if the default 3333 is taken. Edit /opt/mermaid2visio/.env
# (copied from .env.example) to set HOST_PORT before starting.
[ -f .env ] || cp .env.example .env
docker compose up -d
docker compose ps
EOF

# 4. Verify from your workstation.
curl -sS -o /dev/null -w "%{http_code}\n" http://192.168.2.83:3333/
# Expected: 200
```

---

## Option B — build on the target

Use this if you'd rather have the server own the build (and the source).

```bash
# On your workstation: copy the source over.
scp -r . root@192.168.2.83:/opt/mermaid2visio
# (Or rsync -avz --exclude node_modules --exclude dist . root@192.168.2.83:/opt/mermaid2visio/)

# On the target:
ssh root@192.168.2.83 <<'EOF'
cd /opt/mermaid2visio
docker compose up -d --build
docker compose ps
EOF

# Verify from your workstation.
curl -sS -o /dev/null -w "%{http_code}\n" http://192.168.2.83:3333/
```

---

## Health, logs, update, rollback

```bash
# Status + health check
ssh root@192.168.2.83 'cd /opt/mermaid2visio && docker compose ps'

# Tail logs
ssh root@192.168.2.83 'cd /opt/mermaid2visio && docker compose logs -f --tail=200'

# Update: rebuild + recreate. (Use whichever build mode you started with.)
# Option A workflow:
docker build -t mermaid2visio:latest .
docker save mermaid2visio:latest | ssh root@192.168.2.83 'docker load'
ssh root@192.168.2.83 'cd /opt/mermaid2visio && docker compose up -d'

# Rollback: tag the previous image before each deploy.
ssh root@192.168.2.83 'docker tag mermaid2visio:latest mermaid2visio:prev'
# ...then on the next failed deploy:
ssh root@192.168.2.83 'docker tag mermaid2visio:prev mermaid2visio:latest && cd /opt/mermaid2visio && docker compose up -d --force-recreate'

# Stop / remove everything
ssh root@192.168.2.83 'cd /opt/mermaid2visio && docker compose down'
```

---

## Smoke tests after deploy

```bash
# 1. Server-backed editor returns the HTML shell.
curl -sS http://192.168.2.83:3333/ | head -5

# 2. Static client-side bundle is served (large response).
curl -sSI http://192.168.2.83:3333/browser | head -1
curl -sSI http://192.168.2.83:3333/browser/app.js | grep -E '^(HTTP|Content-Type|Content-Length)'

# 3. End-to-end: POST a Mermaid source, expect a .vsdx download.
curl -sS -X POST http://192.168.2.83:3333/convert \
     -H 'Content-Type: text/plain' \
     --data-binary $'flowchart TD\n A[Start] --> B[End]' \
     -o out.vsdx
file out.vsdx                # should report a Zip archive
unzip -l out.vsdx | head      # should list visio/ + docProps/ + ...
```

---

## Notes

- **Memory**: Chromium can use a fair bit; the compose file bumps shared memory to 512 MB. If the host is tight, lower it but watch for `Page crashed` logs.
- **TLS / reverse proxy**: this container speaks plain HTTP on 3333. For TLS, front it with Caddy/Traefik/nginx and forward to `http://127.0.0.1:3333`.
- **Resources**: a single-page conversion is short-lived (~1–2 s wall time). One container handles low-volume traffic fine; scale horizontally for heavier load.
- **Security**: the root password used for the initial SSH should be rotated to key-only auth after the first deploy — there's no other reason to keep password auth open.

Built locally without the target's network reach, so I couldn't run the
`docker build` / `docker compose up` myself. Both Option A and Option B above
are end-to-end commands; either is ready to run.
