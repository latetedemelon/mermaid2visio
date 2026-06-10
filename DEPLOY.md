# Deploy: mermaid2visio → 192.168.2.83

This runbook has the exact commands to ship the containerised app to
`192.168.2.83` and run it. The container exposes two interfaces on a single
port:

| URL | What it is |
|---|---|
| `http://192.168.2.83:3333/` | Server-backed editor (Node + Puppeteer renders Mermaid server-side) |
| `http://192.168.2.83:3333/browser` | Fully-client-side app (renders/converts entirely in the user's browser; nothing leaves their machine) |

Both share the same shapes/extractor/generator code — they're two front-ends
on one container.

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
ssh root@192.168.2.83 <<'EOF'
mkdir -p /opt/mermaid2visio
cat > /opt/mermaid2visio/docker-compose.yml <<'COMPOSE'
services:
  mermaid2visio:
    image: mermaid2visio:latest
    container_name: mermaid2visio
    restart: unless-stopped
    ports: ["3333:3333"]
    environment:
      NODE_ENV: production
      HOST: "0.0.0.0"
      PORT: "3333"
    shm_size: "512m"
COMPOSE
cd /opt/mermaid2visio && docker compose up -d
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
