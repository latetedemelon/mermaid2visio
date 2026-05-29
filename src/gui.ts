import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid, MermaidConfig } from './parser.js';
import { VsdxGenerator } from './vsdx.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = 3333;
export const HOST = '127.0.0.1';
export const MAX_BODY_BYTES = 1 * 1024 * 1024;
export const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');

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
    server.listen(PORT, () => {
        console.log(`GUI Server running at http://localhost:${PORT}`);
        const start = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
        exec(`${start} http://localhost:${PORT}`);
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
