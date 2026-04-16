import { describe, it, expect, jest } from '@jest/globals';
import http, { AddressInfo } from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { createServer, MAX_BODY_BYTES } from '../src/gui';

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

function request(url: string, init: { method?: string, body?: Buffer | string } = {}): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: init.method ?? 'GET',
            headers: init.body ? { 'Content-Length': Buffer.byteLength(init.body as any) } : {},
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
});
