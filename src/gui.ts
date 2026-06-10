import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid, MermaidConfig } from './parser.js';
import { VsdxGenerator } from './vsdx.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = parseInt(process.env.PORT || '3333', 10);
export const HOST = process.env.HOST || '127.0.0.1';
export const MAX_BODY_BYTES = 1 * 1024 * 1024;
export const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');
// dist/browser/ holds the fully-client-side bundle (built by `npm run build:browser`).
// We serve it at /browser/* when present, so the same container offers both the
// server-backed editor and the static client-side app.
export const DEFAULT_BROWSER_DIR = path.join(__dirname, 'browser');

// Serve vendored ESM bundles (currently the ELK layout loader) out of
// node_modules so the browser preview works offline too.
const VENDOR_MAP: Record<string, string> = {
    '/vendor/mermaid-layout-elk/': path.resolve(__dirname, '../node_modules/@mermaid-js/layout-elk/dist'),
};

export interface HandlerOptions {
    publicDir?: string;
    maxBodyBytes?: number;
    // When omitted, the default converter parses JSON `{mermaid, config}`
    // bodies (falling back to plain text) and runs parseMermaid + VsdxGenerator.
    // Tests inject a stub to avoid launching Puppeteer.
    convert?: (body: string) => Promise<Uint8Array>;
}

// Serve the static fully-client-side bundle under /browser/*. Falls through
// (returns false) if the bundle wasn't built, so the rest of the handler can
// produce its own 404.
function serveBrowserBundle(urlPath: string, res: ServerResponse): boolean {
    if (urlPath !== '/browser' && urlPath !== '/browser/' && !urlPath.startsWith('/browser/')) return false;
    if (!fs.existsSync(DEFAULT_BROWSER_DIR)) return false;
    const rel = urlPath.replace(/^\/browser\/?/, '') || 'index.html';
    const abs = path.resolve(DEFAULT_BROWSER_DIR, rel);
    if (!abs.startsWith(DEFAULT_BROWSER_DIR + path.sep) && abs !== DEFAULT_BROWSER_DIR) {
        res.writeHead(403); res.end(); return true;
    }
    if (!fs.existsSync(abs)) { res.writeHead(404); res.end(); return true; }
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'application/javascript'
        : ext === '.css' ? 'text/css'
        : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' });
    fs.createReadStream(abs).pipe(res);
    return true;
}

function serveVendor(urlPath: string, res: ServerResponse): boolean {
    for (const [prefix, dir] of Object.entries(VENDOR_MAP)) {
        if (!urlPath.startsWith(prefix)) continue;
        const rel = urlPath.slice(prefix.length);
        const abs = path.resolve(dir, rel);
        if (!abs.startsWith(dir + path.sep) && abs !== dir) {
            res.writeHead(403); res.end(); return true;
        }
        if (!fs.existsSync(abs)) {
            res.writeHead(404); res.end(); return true;
        }
        res.writeHead(200, {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'public, max-age=3600',
        });
        fs.createReadStream(abs).pipe(res);
        return true;
    }
    return false;
}

async function defaultConvert(body: string): Promise<Uint8Array> {
    let mermaidCode = body;
    let config: MermaidConfig | undefined;
    try {
        const json = JSON.parse(body);
        if (json && typeof json.mermaid === 'string') {
            mermaidCode = json.mermaid;
            config = json.config;
        }
    } catch {
        // Not JSON, treat as plain mermaid code.
    }
    const graph = await parseMermaid(mermaidCode, config);
    // Store the source for round-trip parity with the CLI and MCP server.
    return new VsdxGenerator().generate(graph, mermaidCode);
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer | { oversize: true }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let oversize = false;
        req.on('data', (chunk: Buffer) => {
            if (oversize) return;
            size += chunk.length;
            if (size > cap) {
                // Keep draining the request so the client can fully flush
                // its body before we send 413. If we destroyed the socket
                // here, the client would see a hang-up instead of our 413.
                oversize = true;
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(oversize ? { oversize: true } : Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export function createHandler(opts: HandlerOptions = {}) {
    const publicDir = opts.publicDir ?? DEFAULT_PUBLIC_DIR;
    const cap = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    const convert = opts.convert ?? defaultConvert;

    return async function handler(req: IncomingMessage, res: ServerResponse) {
        const urlPath = (req.url || '/').split('?')[0];

        if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
            const htmlPath = path.join(publicDir, 'index.html');
            if (fs.existsSync(htmlPath)) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                fs.createReadStream(htmlPath).pipe(res);
            } else {
                res.writeHead(404);
                res.end('GUI HTML not found. Ensure src/public/index.html exists.');
            }
            return;
        }

        if (req.method === 'GET' && serveVendor(urlPath, res)) return;
        if (req.method === 'GET' && serveBrowserBundle(urlPath, res)) return;

        if (req.method === 'POST' && req.url === '/convert') {
            const body = await readBody(req, cap);
            if ((body as any).oversize) {
                res.writeHead(413, { 'Content-Type': 'text/plain' });
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
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(e?.message ?? String(e));
            }
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    };
}

export function createServer(opts: HandlerOptions = {}) {
    return http.createServer(createHandler(opts));
}

function main() {
    const server = createServer();
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
