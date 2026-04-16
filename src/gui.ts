import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid, MermaidConfig } from './parser.js';
import { VsdxGenerator } from './vsdx.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3333;  // Changed from 3000

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

    // Convert API - Enhanced with config support
    if (req.method === 'POST' && req.url === '/convert') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                console.log("Received conversion request...");
                
                // Try to parse as JSON first (for config), fallback to plain text
                let mermaidCode = body;
                let config: MermaidConfig | undefined;
                
                try {
                    const json = JSON.parse(body);
                    if (json.mermaid) {
                        mermaidCode = json.mermaid;
                        config = json.config;
                    }
                } catch (e) {
                    // Not JSON, treat as plain mermaid code
                }
                
                const graph = await parseMermaid(mermaidCode, config);
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

server.listen(PORT, () => {
    console.log(`GUI Server running at http://localhost:${PORT}`);
    // Try to open browser
    const start = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
    exec(`${start} http://localhost:${PORT}`);
});
