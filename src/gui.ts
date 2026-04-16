import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid } from './parser.js';
import { VsdxGenerator } from './vsdx.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

// Path to the HTML file (in dist/public/index.html after build, or src/public for dev?)
// Since we compile ts to dist, we need to make sure public is copied or read correctly.
// A simple way is to read from ../src/public/index.html relative to this file source, 
// OR assume a build step copies it. 
// Let's assume for now we read from the source tree if running locally, or handle distribution later.
// Actually, `npm run build` (tsc) won't copy .html files.
// So we should read it from the package root relative path.

// In production (dist), the public folder is alongside the js files.
// In dev (src), it is in ../src/public relative to __dirname (which is dist or src).
// Let's rely on the copy step.
const PUBLIC_DIR = path.join(__dirname, 'public');  

const server = http.createServer(async (req, res) => {
    // Serve Index
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        const htmlPath = path.join(PUBLIC_DIR, 'index.html');
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            fs.createReadStream(htmlPath).pipe(res);
        } else {
            res.writeHead(404);
            res.end('GUI HTML not found. Ensure src/public/index.html exists.');
        }
        return;
    }

    // Convert API
    if (req.method === 'POST' && req.url === '/convert') {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
                aborted = true;
                res.writeHead(413, { 'Content-Type': 'text/plain' });
                res.end(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', async () => {
            if (aborted) return;
            try {
                console.log("Received conversion request...");
                const body = Buffer.concat(chunks).toString('utf-8');
                const graph = await parseMermaid(body);
                const generator = new VsdxGenerator();
                const buffer = await generator.generate(graph);

                res.writeHead(200, {
                    'Content-Type': 'application/vnd.ms-visio.drawing',
                    'Content-Disposition': 'attachment; filename="diagram.vsdx"'
                });
                res.end(buffer);
                console.log("Sent VSDX.");
            } catch (e: any) {
                console.error(e);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(e.message);
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, HOST, () => {
    console.log(`GUI Server running at http://${HOST}:${PORT}`);
    // Try to open browser
    const start = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
    exec(`${start} http://${HOST}:${PORT}`);
});