import { describe, it, expect, jest } from '@jest/globals';
import http, { AddressInfo } from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { createServer, MAX_BODY_BYTES } from '../src/gui';
import { RendererBusyError } from '../src/parser';

async function startServer(opts: Parameters<typeof createServer>[0] = {}) {
    const server = createServer(opts);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    return {
        base,
        stop: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
    };
}

interface FetchResult {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}

function request(url: string, init: { method?: string, body?: Buffer | string, headers?: Record<string, string>, rawPath?: string } = {}): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: init.rawPath ?? (u.pathname + u.search),
            method: init.method ?? 'GET',
            headers: { ...(init.body ? { 'Content-Length': Buffer.byteLength(init.body as any) } : {}), ...init.headers },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers as any,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        if (init.body) req.write(init.body);
        req.end();
    });
}

describe('GUI HTTP server', () => {
    it('rejects POST /convert bodies larger than the cap with 413', async () => {
        const convert = jest.fn(async () => Buffer.from('vsdx'));
        const small = 1024;
        const { base, stop } = await startServer({ maxBodyBytes: small, convert });
        try {
            const oversized = Buffer.alloc(small + 512, 0x41);
            const res = await request(`${base}/convert`, { method: 'POST', body: oversized });
            expect(res.status).toBe(413);
            expect(res.body.toString()).toMatch(/exceeds/);
            expect(convert).not.toHaveBeenCalled();
        } finally {
            await stop();
        }
    });

    it('converts bodies under the cap and returns VSDX', async () => {
        const convert = jest.fn(async (body: string) => Buffer.from('PK-fake-' + body.length));
        const { base, stop } = await startServer({ convert });
        try {
            const res = await request(`${base}/convert`, { method: 'POST', body: 'graph TD\nA-->B' });
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('application/vnd.ms-visio.drawing');
            expect(res.headers['content-disposition']).toContain('diagram.vsdx');
            expect(res.body.toString()).toContain('PK-fake-');
            expect(convert).toHaveBeenCalledTimes(1);
        } finally {
            await stop();
        }
    });

    it('returns 500 with the error message when convert throws', async () => {
        const convert = jest.fn(async () => { throw new Error('kaboom'); });
        const { base, stop } = await startServer({ convert });
        try {
            const res = await request(`${base}/convert`, { method: 'POST', body: 'x' });
            expect(res.status).toBe(500);
            expect(res.body.toString()).toBe('kaboom');
        } finally {
            await stop();
        }
    });

    it('serves index.html from the configured public dir', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-test-'));
        fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>OK</title>');
        const { base, stop } = await startServer({ publicDir: dir });
        try {
            const res = await request(`${base}/`);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toBe('text/html');
            expect(res.body.toString()).toContain('<title>OK</title>');
        } finally {
            await stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns 404 for unknown routes', async () => {
        const { base, stop } = await startServer();
        try {
            const res = await request(`${base}/nope`);
            expect(res.status).toBe(404);
        } finally {
            await stop();
        }
    });

    it('uses a 1 MiB default body cap', () => {
        expect(MAX_BODY_BYTES).toBe(1024 * 1024);
    });

    it('blocks path traversal under /vendor/', async () => {
        const { base, stop } = await startServer();
        try {
            const res = await request(`${base}/vendor/mermaid/../../../etc/passwd`);
            // Node's http client normalizes the URL before send, so we also
            // accept 404 as an acceptable "not served" outcome.
            expect([403, 404]).toContain(res.status);
        } finally {
            await stop();
        }
    });

    it('serves the Mermaid build and extractor bundle the converter itself uses', async () => {
        const { base, stop } = await startServer();
        try {
            for (const p of ['/vendor/mermaid/mermaid.min.js', '/vendor/m2v/extractor.iife.js']) {
                const res = await request(`${base}${p}`);
                expect(res.status).toBe(200);
                expect(res.headers['content-type']).toBe('application/javascript');
                expect(res.body.length).toBeGreaterThan(1000);
            }
        } finally {
            await stop();
        }
    });

    it('routes POST /convert by path, ignoring any query string', async () => {
        const convert = jest.fn(async () => Buffer.from('PK-fake'));
        const { base, stop } = await startServer({ convert });
        try {
            const res = await request(`${base}/convert?source=test`, { method: 'POST', body: 'graph TD\nA-->B' });
            expect(res.status).toBe(200);
            expect(convert).toHaveBeenCalledTimes(1);
        } finally {
            await stop();
        }
    });

    // Any website the user visits can make their browser POST to this
    // server. Browsers label such requests with Origin; refuse them.
    it('refuses cross-origin POST /convert but allows same-origin and non-browser clients', async () => {
        const convert = jest.fn(async () => Buffer.from('PK-fake'));
        const { base, stop } = await startServer({ convert });
        try {
            const cross = await request(`${base}/convert`, { method: 'POST', body: 'graph TD', headers: { Origin: 'https://evil.example' } });
            expect(cross.status).toBe(403);
            const fetchMeta = await request(`${base}/convert`, { method: 'POST', body: 'graph TD', headers: { 'Sec-Fetch-Site': 'cross-site' } });
            expect(fetchMeta.status).toBe(403);
            expect(convert).not.toHaveBeenCalled();

            const same = await request(`${base}/convert`, { method: 'POST', body: 'graph TD', headers: { Origin: base } });
            expect(same.status).toBe(200);
            const curl = await request(`${base}/convert`, { method: 'POST', body: 'graph TD' });
            expect(curl.status).toBe(200);
        } finally {
            await stop();
        }
    });

    it('answers 503 with Retry-After when the renderer is saturated', async () => {
        const convert = jest.fn(async () => { throw new RendererBusyError(); });
        const { base, stop } = await startServer({ convert });
        try {
            const res = await request(`${base}/convert`, { method: 'POST', body: 'graph TD' });
            expect(res.status).toBe(503);
            expect(res.headers['retry-after']).toBe('5');
        } finally {
            await stop();
        }
    });

    // A directory where a file is expected used to reach createReadStream,
    // whose unhandled EISDIR error killed the whole server process.
    it('survives requests for directories and odd paths', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-dir-'));
        fs.mkdirSync(path.join(dir, 'index.html'));
        const { base, stop } = await startServer({ publicDir: dir });
        try {
            expect((await request(`${base}/`)).status).toBe(404);
            for (const rawPath of ['/browser/chunks/', '/browser/%2e%2e/%2e%2e/etc/passwd', '/vendor/mermaid/', '/%E0%A4%A']) {
                const res = await request(base, { rawPath });
                expect([301, 400, 403, 404]).toContain(res.status);
            }
            // Still alive.
            expect((await request(`${base}/vendor/mermaid/mermaid.min.js`)).status).toBe(200);
        } finally {
            await stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // End-to-end check of the page itself: it must load Mermaid and the
    // config builder from this server (not a CDN) and render the sample
    // diagram with the same pinned look the converter uses.
    it('renders the live preview from locally served Mermaid', async () => {
        const { base, stop } = await startServer();
        const browser = await puppeteer.connect({ browserWSEndpoint: process.env.M2V_BROWSER_WS_ENDPOINT! });
        const page = await browser.newPage();
        const external: string[] = [];
        page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url()); });
        try {
            await page.goto(base, { waitUntil: 'load' });
            await page.waitForSelector('#preview svg .node', { timeout: 20000 });
            const look = await page.$eval('#preview svg .node', (n) => n.getAttribute('data-look'));
            expect(look).toBe('classic');
            expect(external).toEqual([]);
        } finally {
            await page.close();
            await browser.disconnect();
            await stop();
        }
    }, 60000);
});
