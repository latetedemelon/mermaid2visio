import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid } from './parser.js';
import { VsdxGenerator } from './vsdx.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = 3000;
export const HOST = '127.0.0.1';
export const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB
export const DEFAULT_PUBLIC_DIR = path.join(__dirname, 'public');

export interface HandlerOptions {
    publicDir?: string;
    maxBodyBytes?: number;
    convert?: (body: string) => Promise<Buffer>;
}

async function defaultConvert(body: string): Promise<Buffer> {
    const graph = await parseMermaid(body);
    return new VsdxGenerator().generate(graph);
}

export function createHandler(opts: HandlerOptions = {}) {
    const publicDir = opts.publicDir ?? DEFAULT_PUBLIC_DIR;
    const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    const convert = opts.convert ?? defaultConvert;

    return async function handler(req: IncomingMessage, res: ServerResponse) {
        if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
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

        if (req.method === 'POST' && req.url === '/convert') {
            const chunks: Buffer[] = [];
            let received = 0;
            let aborted = false;

            req.on('data', (chunk: Buffer) => {
                if (aborted) return;
                received += chunk.length;
                if (received > maxBodyBytes) {
                    aborted = true;
                    res.writeHead(413, { 'Content-Type': 'text/plain' });
                    res.end(`Request body exceeds ${maxBodyBytes} bytes`);
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', async () => {
                if (aborted) return;
                try {
                    const body = Buffer.concat(chunks).toString('utf-8');
                    const buffer = await convert(body);
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.ms-visio.drawing',
                        'Content-Disposition': 'attachment; filename="diagram.vsdx"'
                    });
                    res.end(buffer);
                } catch (e: any) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end(e.message);
                }
            });
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
    server.listen(PORT, HOST, () => {
        console.log(`GUI Server running at http://${HOST}:${PORT}`);
        const start = (process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open');
        exec(`${start} http://${HOST}:${PORT}`);
    });
}

// Only start the server when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
