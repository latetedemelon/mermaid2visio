# Multi-stage build for mermaid2visio.
#
# Stage 1 (builder): full toolchain — installs all deps, runs tsc, bundles the
# fully-client-side browser app via esbuild.
#
# Stage 2 (runtime): slim Debian + Node + system Chromium (for Puppeteer at
# runtime). Production deps only, non-root user, dumb-init as PID 1.
#
# Notes for the maintainer:
# - We use the system `chromium` package and set PUPPETEER_EXECUTABLE_PATH so
#   Puppeteer doesn't try to download its own Chromium at npm-install time
#   (PUPPETEER_SKIP_DOWNLOAD=true is set BEFORE `npm ci` runs).
# - The GUI binds 0.0.0.0:3333 in the container via env (see HOST/PORT env vars).
# - /browser/ serves the fully-client-side bundle from dist/browser; / serves
#   the server-backed editor that has been there.
#
# Build:   docker build -t mermaid2visio:latest .
# Run:     docker run --rm -p 3333:3333 mermaid2visio:latest

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder

# Skip Puppeteer's Chromium download — we ship the system Chromium in the
# runtime stage. Setting these BEFORE `npm ci` prevents the postinstall hook
# from downloading ~150 MB.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Install ALL deps (incl. devDeps: typescript, esbuild, copyfiles) for the build.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and config, build the Node target and the browser bundle.
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm run build:browser

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

# System Chromium + the runtime libs Puppeteer-launched Chromium needs.
# dumb-init is a tiny init so Chromium zombies get reaped.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        dumb-init \
        ca-certificates \
        fonts-liberation \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Same Puppeteer env so production install doesn't try to download Chromium,
# and so puppeteer.launch() finds the system binary.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333

WORKDIR /app

# Production deps only. We need: mermaid, puppeteer,
# jszip, xmlbuilder2, commander, @modelcontextprotocol/sdk, zod.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output (dist/) carries Node entries + the browser bundle.
COPY --from=builder /app/dist ./dist

# Run as non-root. Chromium uses --no-sandbox (already in parser.ts) so this is fine.
RUN useradd --create-home --uid 1000 app \
    && chown -R app:app /app /home/app
USER app

EXPOSE 3333

# Lightweight container-level health check: TCP probe on PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('net').createConnection({host:'127.0.0.1',port:Number(process.env.PORT)||3333}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/gui.js"]
