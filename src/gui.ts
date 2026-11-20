import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid, MermaidConfig, MermaidRenderer, RendererBusyError } from './parser.js';
import { mermaidScriptPath, extractorScriptPath } from './render/renderer.js';
import { VsdxGenerator } from './vsdx.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = parseInt(process.env.PORT || '3333', 10);
export const HOST = process.env.HOST || '127.0.0.1';
export const MAX_BODY_BYTES = 1 * 1024 * 1024;
// How far past the cap an oversized upload is drained before the socket is cut.
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');
// dist/browser/ holds the fully-client-side bundle (built by `npm run build:browser`).
// We serve it at /browser/* when present, so the same container offers both the
// server-backed editor and the static client-side app.
export const DEFAULT_BROWSER_DIR = path.join(__dirname, 'browser');

// Single files the preview page loads: the same Mermaid build and the same
// extractor bundle the converter itself uses, so preview and output agree.
const VENDOR_FILES: Record<string, () => string> = {
    '/vendor/mermaid/mermaid.min.js': mermaidScriptPath,
    '/vendor/m2v/extractor.iife.js': extractorScriptPath,
};


export interface HandlerOptions {
    publicDir?: string;
    maxBodyBytes?: number;
    // When omitted, the default converter parses JSON `{mermaid, config}`
    // bodies (falling back to plain text) and runs parseMermaid + VsdxGenerator.
    // Tests inject a stub to avoid launching Puppeteer.
    convert?: (body: string) => Promise<Uint8Array>;
}

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
};

// Stream one regular file. Anything else at that path (missing, a directory,
// unreadable) is a 404; a read error after headers are sent ends the response
// instead of crashing the process.
function sendFile(abs: string, res: ServerResponse, headers: Record<string, string> = {}): void {
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(abs); } catch { /* treated as missing */ }
    if (!stat || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }
    const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
    fs.createReadStream(abs)
        .on('error', () => res.destroy())
        .pipe(res);
}

// Serve the static fully-client-side bundle under /browser/. Falls through
// (returns false) if the bundle wasn't built, so the rest of the handler can
// produce its own 404.
function serveBrowserBundle(urlPath: string, res: ServerResponse): boolean {
    if (urlPath !== '/browser' && !urlPath.startsWith('/browser/')) return false;
    if (!fs.existsSync(DEFAULT_BROWSER_DIR)) return false;
    if (urlPath === '/browser') {
        // The page's asset URLs are relative, so it must be served from a
        // path that ends in a slash.
        res.writeHead(301, { Location: '/browser/' });
        res.end();
        return true;
    }
    const rel = urlPath.slice('/browser/'.length) || 'index.html';
    const abs = path.resolve(DEFAULT_BROWSER_DIR, rel);
    if (!abs.startsWith(DEFAULT_BROWSER_DIR + path.sep)) {
        res.writeHead(403); res.end(); return true;
    }
    sendFile(abs, res, { 'Cache-Control': 'public, max-age=300' });
    return true;
}

function serveVendor(urlPath: string, res: ServerResponse): boolean {
    const single = VENDOR_FILES[urlPath];
    if (!single) return false;
    sendFile(single(), res, { 'Cache-Control': 'public, max-age=3600' });
    return true;
}

// One browser for the life of the server, with a small concurrency cap:
// every conversion costs a Chromium page, and this endpoint has no auth.
let sharedRenderer: MermaidRenderer | null = null;
function getRenderer(): MermaidRenderer {
    sharedRenderer ??= new MermaidRenderer({ maxConcurrent: 2, maxQueue: 8 });
    return sharedRenderer;
}

export async function closeSharedRenderer(): Promise<void> {
    const renderer = sharedRenderer;
    sharedRenderer = null;
    await renderer?.close();
}

async function defaultConvert(body: string): Promise<Uint8Array> {
    let mermaidCode = body;
    let config: MermaidConfig | undefined;
    try {
        const json = JSON.parse(body);
        if (json && typeof json.mermaid === 'string') {
            mermaidCode = json.mermaid;
            // Only the rendering options a client may choose; buildMermaidConfig
            // coerces each value, and `verbose` is not theirs to set.
            if (json.config && typeof json.config === 'object') {
                const { layout, theme, themeVariables, flowchart } = json.config;
                config = { layout, theme, themeVariables, flowchart };
            }
        }
    } catch {
        // Not JSON, treat as plain mermaid code.
    }
    const graph = await parseMermaid(mermaidCode, config, getRenderer());
    // Store the source for round-trip parity with the CLI and MCP server.
    return new VsdxGenerator().generate(graph, mermaidCode);
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer | { oversize: true }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let oversize = false;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > cap) {
                // Keep draining so the client can finish sending and read our
                // 413 (destroying the socket now would look like a hang-up),
                // but only up to a point: nobody gets to stream forever.
                oversize = true;
                chunks.length = 0;
                if (size > cap + MAX_DRAIN_BYTES) req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(oversize ? { oversize: true } : Buffer.concat(chunks)));
        req.on('error', reject);
        req.on('close', () => { if (oversize) resolve({ oversize: true }); });
    });
}

// A browser attaches Origin to every cross-origin POST. If it is present and
// names a different host than the one the request was sent to, some other
// website is driving this server through the user's browser: refuse. Requests
// without Origin (curl, scripts, the documented smoke tests) are unaffected.
function isCrossOrigin(req: IncomingMessage): boolean {
    if (req.headers['sec-fetch-site'] === 'cross-site') return true;
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
        return new URL(origin).host !== req.headers.host;
    } catch {
        return true;
    }
}

export function createHandler(opts: HandlerOptions = {}) {
    const publicDir = opts.publicDir ?? DEFAULT_PUBLIC_DIR;
    const cap = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    const convert = opts.convert ?? defaultConvert;

    return async function handler(req: IncomingMessage, res: ServerResponse) {
        let urlPath: string;
        try {
            urlPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
        } catch {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }

        if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
            const htmlPath = path.join(publicDir, 'index.html');
            if (fs.existsSync(htmlPath)) {
                sendFile(htmlPath, res);
            } else {
                res.writeHead(404);
                res.end('GUI HTML not found. Ensure src/public/index.html exists.');
            }
            return;
        }

        if (req.method === 'GET' && serveVendor(urlPath, res)) return;
        if (req.method === 'GET' && serveBrowserBundle(urlPath, res)) return;

        if (req.method === 'POST' && urlPath === '/convert') {
            if (isCrossOrigin(req)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                res.end('Cross-origin requests are not allowed');
                return;
            }
            let body: Buffer | { oversize: true };
            try {
                body = await readBody(req, cap);
            } catch {
                res.destroy();
                return;
            }
            if ((body as any).oversize) {
                if (res.destroyed || !res.writable) return;
                res.writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' });
                res.end(`Request body exceeds ${cap} bytes`);
                return;
            }
            try {
                const buffer = await convert((body as Buffer).toString('utf-8'));
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.ms-visio.drawing',
                    'Content-Disposition': 'attachment; filename="diagram.vsdx"',
                });
                res.end(buffer);
            } catch (e: any) {
                const busy = e instanceof RendererBusyError;
                res.writeHead(busy ? 503 : 500, { 'Content-Type': 'text/plain', ...(busy ? { 'Retry-After': '5' } : {}) });
                res.end(e?.message ?? String(e));
            }
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    };
}

export function createServer(opts: HandlerOptions = {}) {
    const server = http.createServer(createHandler(opts));
    // Bound how long one connection may take to deliver its request.
    server.headersTimeout = 15_000;
    server.requestTimeout = 60_000;
    return server;
}

function main() {
    const server = createServer();
    const shutdown = () => {
        server.close();
        void closeSharedRenderer().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // Bind to HOST (env-overridable; defaults to 127.0.0.1 for local-only). In
    // a container set HOST=0.0.0.0 to accept connections from outside the
    // container's network namespace.
    server.listen(PORT, HOST, () => {
        console.log(`GUI Server running at http://${HOST}:${PORT}`);
        // Skip the open-in-browser auto-launch when running headless (no DISPLAY
        // and not on Windows). The exec() spawns a child that can pollute logs
        // with "command not found" in container environments.
        if (process.env.NODE_ENV === 'production' || (!process.env.DISPLAY && process.platform !== 'win32')) return;
        const start = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
        exec(`${start} http://localhost:${PORT}`);
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
