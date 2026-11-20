import { describe, it, expect, afterAll } from '@jest/globals';
import http, { AddressInfo } from 'http';
import { MermaidRenderer, RendererBusyError } from '../src/parser';

const SIMPLE = 'graph TD\n A[Start] --> B[End]';

describe('MermaidRenderer', () => {
    const renderers: MermaidRenderer[] = [];
    const make = (opts?: ConstructorParameters<typeof MermaidRenderer>[0]) => {
        const r = new MermaidRenderer(opts);
        renderers.push(r);
        return r;
    };
    afterAll(async () => { await Promise.all(renderers.map(r => r.close())); });

    it('renders several diagrams through one browser', async () => {
        const renderer = make();
        const results = await Promise.all([1, 2, 3, 4].map(() => renderer.render(SIMPLE)));
        for (const r of results) {
            expect(r.graph.nodes.map(n => n.id).sort()).toEqual(['A', 'B']);
            expect(r.diagramType).toBe('graph');
            expect(r.layout).toBe('dagre');
        }
    }, 60000);

    it('rejects work beyond its queue limit instead of piling it up', async () => {
        const renderer = make({ maxConcurrent: 1, maxQueue: 1 });
        const first = renderer.render(SIMPLE);
        const second = renderer.render(SIMPLE);   // waits
        await expect(renderer.render(SIMPLE)).rejects.toBeInstanceOf(RendererBusyError);
        // The running and the queued render are unaffected, and the slot is
        // released afterwards.
        expect((await first).graph.nodes.length).toBe(2);
        expect((await second).graph.nodes.length).toBe(2);
        expect((await renderer.render(SIMPLE)).graph.nodes.length).toBe(2);
    }, 60000);

    it('stops a render that exceeds the time limit and stays usable', async () => {
        const slow = make({ timeoutMs: 1 });
        await expect(slow.render(SIMPLE)).rejects.toThrow(/took longer than 1 ms/);
        const ok = make();
        expect((await ok.render(SIMPLE)).graph.nodes.length).toBe(2);
    }, 60000);

    // Diagram source is untrusted. Nothing it references may be fetched, and
    // none of its script may run.
    it('fetches nothing a diagram references and runs none of its script', async () => {
        const hits: string[] = [];
        const server = http.createServer((req, res) => { hits.push(req.url || ''); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const renderer = make();
            const { graph } = await renderer.render([
                'flowchart TD',
                `  A@{ img: "${base}/pixel.png", label: "Image", w: 60, h: 60 }`,
                `  B["<img src=${base}/label.png onerror=fetch('${base}/xss')>label"]`,
                '  A --> B',
                `  click B href "javascript:fetch('${base}/href')"`,
            ].join('\n'));
            // The diagram still renders (the image is replaced by a blank
            // placeholder rather than failing the whole render).
            expect(graph.nodes.map(n => n.id)).toContain('B');
            // Give any stray request a moment to arrive.
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(hits).toEqual([]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }, 60000);
});
