import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { handleConvertMermaidToVsdx } from '../src/server';

function fakeFs(files: Record<string, string>) {
    const writes: Record<string, Buffer> = {};
    const dirs = new Set<string>();
    return {
        writes,
        dirs,
        stub: {
            existsSync: (p: string) => p in files || dirs.has(p),
            readFileSync: (p: string, _enc: string) => {
                if (!(p in files)) throw new Error(`ENOENT ${p}`);
                return files[p];
            },
            mkdirSync: (p: string, _opts?: any) => { dirs.add(p); return p; },
            writeFileSync: (p: string, b: Uint8Array) => { writes[p] = b as Buffer; },
        },
    };
}

describe('handleConvertMermaidToVsdx', () => {
    const fakeBuffer = Buffer.from('PK-fake');
    const fakeGenerator = { generate: jest.fn(async () => fakeBuffer) };
    const fakeParse = jest.fn(async () => ({
        width: 100, height: 100, nodes: [], edges: [], clusters: [], labels: [],
    } as any));

    beforeEach(() => {
        fakeGenerator.generate.mockClear();
        fakeParse.mockClear();
    });

    it('returns an error when source is missing', async () => {
        const result = await handleConvertMermaidToVsdx({}, {
            fs: fakeFs({}).stub,
            parse: fakeParse,
            generator: fakeGenerator,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Missing 'source'/);
        expect(fakeParse).not.toHaveBeenCalled();
    });

    it('treats source as inline code when it is not an existing path', async () => {
        const files = fakeFs({});
        const result = await handleConvertMermaidToVsdx(
            { source: 'graph TD\nA-->B', outputPath: '/tmp/out.vsdx' },
            { fs: files.stub, parse: fakeParse, generator: fakeGenerator },
        );
        expect(result.isError).toBeUndefined();
        expect(fakeParse).toHaveBeenCalledWith('graph TD\nA-->B');
        expect(files.writes['/tmp/out.vsdx']).toEqual(fakeBuffer);
        expect(result.content[0].text).toContain('/tmp/out.vsdx');
    });

    it('reads from disk when source is an existing .mmd file', async () => {
        const files = fakeFs({ '/path/x.mmd': 'graph LR\nA-->B' });
        const result = await handleConvertMermaidToVsdx(
            { source: '/path/x.mmd', outputPath: '/tmp/x.vsdx' },
            { fs: files.stub, parse: fakeParse, generator: fakeGenerator },
        );
        expect(fakeParse).toHaveBeenCalledWith('graph LR\nA-->B');
        expect(result.isError).toBeUndefined();
    });

    it('extracts the mermaid fence when source is a .md file', async () => {
        const md = 'intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\ntail';
        const files = fakeFs({ '/path/doc.md': md });
        await handleConvertMermaidToVsdx(
            { source: '/path/doc.md', outputPath: '/tmp/doc.vsdx' },
            { fs: files.stub, parse: fakeParse, generator: fakeGenerator },
        );
        expect(fakeParse).toHaveBeenCalledWith('graph TD\nA-->B');
    });

    it('defaults outputPath to <cwd>/output/diagram_<ts>.vsdx', async () => {
        const files = fakeFs({});
        const now = () => new Date('2025-01-02T03:04:05.678Z');
        const result = await handleConvertMermaidToVsdx(
            { source: 'graph TD\nA-->B' },
            { cwd: '/work', fs: files.stub, parse: fakeParse, generator: fakeGenerator, now },
        );
        expect(files.dirs.has('/work/output')).toBe(true);
        expect(Object.keys(files.writes)[0]).toMatch(/^\/work\/output\/diagram_2025-01-02T03-04-05-678Z\.vsdx$/);
        expect(result.isError).toBeUndefined();
    });

    it('passes the mermaid source to the generator for round-trip storage', async () => {
        const files = fakeFs({});
        await handleConvertMermaidToVsdx(
            { source: 'graph TD\nA-->B', outputPath: '/tmp/rt.vsdx' },
            { fs: files.stub, parse: fakeParse, generator: fakeGenerator },
        );
        // 2nd arg to generate() must be the mermaid source so the VSDX embeds
        // mermaid/source.mmd, matching the CLI behaviour.
        expect(fakeGenerator.generate).toHaveBeenCalledWith(expect.anything(), 'graph TD\nA-->B');
    });

    it('warns in the result when no shapes were extracted (blank output)', async () => {
        // fakeParse returns an empty graph, so the warning should appear.
        const files = fakeFs({});
        const result = await handleConvertMermaidToVsdx(
            { source: 'pie title X\n "a" : 1', outputPath: '/tmp/blank.vsdx' },
            { fs: files.stub, parse: fakeParse, generator: fakeGenerator },
        );
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toMatch(/no shapes were extracted/i);
    });

    it('does not warn when shapes were extracted', async () => {
        const files = fakeFs({});
        const parseWithShapes = jest.fn(async () => ({
            width: 100, height: 100,
            nodes: [{ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
            edges: [], clusters: [], labels: [],
        } as any));
        const result = await handleConvertMermaidToVsdx(
            { source: 'flowchart TD\n A', outputPath: '/tmp/ok.vsdx' },
            { fs: files.stub, parse: parseWithShapes as any, generator: fakeGenerator },
        );
        expect(result.content[0].text).not.toMatch(/no shapes were extracted/i);
    });

    it('wraps parser errors as isError results rather than throwing', async () => {
        const parseThatThrows = jest.fn(async () => { throw new Error('bad mermaid'); });
        const result = await handleConvertMermaidToVsdx(
            { source: 'bogus', outputPath: '/tmp/e.vsdx' },
            { fs: fakeFs({}).stub, parse: parseThatThrows as any, generator: fakeGenerator },
        );
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('bad mermaid');
    });

    describe('file safety', () => {
        const deps = (files: ReturnType<typeof fakeFs>, extra: object = {}) =>
            ({ cwd: '/work', fs: files.stub, parse: fakeParse, generator: fakeGenerator, ...extra });

        it('does not read an existing file that is not a diagram file', async () => {
            const files = fakeFs({ '/etc/passwd': 'root:x:0:0' });
            await handleConvertMermaidToVsdx({ source: '/etc/passwd', outputPath: '/tmp/a.vsdx' }, deps(files));
            // Treated as (invalid) inline source, never opened.
            expect(fakeParse).toHaveBeenCalledWith('/etc/passwd');
        });

        it('rejects sourcePath with a non-diagram extension', async () => {
            const files = fakeFs({ '/home/u/.ssh/id_rsa': 'KEY' });
            const result = await handleConvertMermaidToVsdx({ sourcePath: '/home/u/.ssh/id_rsa' }, deps(files));
            expect(result.isError).toBe(true);
            expect(result.content[0].text).not.toContain('KEY');
            expect(fakeParse).not.toHaveBeenCalled();
        });

        it('reads sourcePath for a diagram file', async () => {
            const files = fakeFs({ '/work/d.mmd': 'graph TD\nA-->B' });
            const result = await handleConvertMermaidToVsdx({ sourcePath: 'd.mmd', outputPath: 'out.vsdx' }, deps(files));
            expect(result.isError).toBeUndefined();
            expect(fakeParse).toHaveBeenCalledWith('graph TD\nA-->B');
            // Relative paths resolve against the working directory and the
            // reported path is absolute.
            expect(files.writes['/work/out.vsdx']).toEqual(fakeBuffer);
            expect(result.content[0].text).toContain('/work/out.vsdx');
        });

        it('only writes .vsdx files', async () => {
            const files = fakeFs({});
            const result = await handleConvertMermaidToVsdx({ source: 'graph TD\nA-->B', outputPath: '/home/u/.bashrc' }, deps(files));
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/must end in \.vsdx/);
            expect(Object.keys(files.writes)).toEqual([]);
        });

        it('refuses to overwrite an existing file unless asked to', async () => {
            const files = fakeFs({ '/work/keep.vsdx': 'old' });
            const refused = await handleConvertMermaidToVsdx({ source: 'graph TD\nA-->B', outputPath: 'keep.vsdx' }, deps(files));
            expect(refused.isError).toBe(true);
            expect(refused.content[0].text).toMatch(/already exists/);
            expect(Object.keys(files.writes)).toEqual([]);

            const allowed = await handleConvertMermaidToVsdx({ source: 'graph TD\nA-->B', outputPath: 'keep.vsdx', overwrite: true }, deps(files));
            expect(allowed.isError).toBeUndefined();
            expect(files.writes['/work/keep.vsdx']).toEqual(fakeBuffer);
        });

        it('confines reads and writes to the configured root', async () => {
            const files = fakeFs({ '/elsewhere/d.mmd': 'graph TD\nA-->B' });
            const read = await handleConvertMermaidToVsdx({ sourcePath: '/elsewhere/d.mmd' }, deps(files, { root: '/work' }));
            expect(read.isError).toBe(true);
            expect(read.content[0].text).toMatch(/must be inside \/work/);

            const write = await handleConvertMermaidToVsdx({ source: 'graph TD\nA-->B', outputPath: '/work/../etc/x.vsdx' }, deps(files, { root: '/work' }));
            expect(write.isError).toBe(true);
            expect(Object.keys(files.writes)).toEqual([]);

            const ok = await handleConvertMermaidToVsdx({ source: 'graph TD\nA-->B', outputPath: 'sub/x.vsdx' }, deps(files, { root: '/work' }));
            expect(ok.isError).toBeUndefined();
            expect(files.writes['/work/sub/x.vsdx']).toEqual(fakeBuffer);
        });

        it('does not echo file contents from a syntax error in a file', async () => {
            const files = fakeFs({ '/work/notes.md': '```mermaid\nSECRET TOKEN abc123\n```' });
            const syntaxError = jest.fn(async () => {
                throw new Error('Mermaid syntax error:\n  Parse error on line 1:\n  SECRET TOKEN abc123\n\nDiagram (line 1):\n>    1 | SECRET TOKEN abc123');
            });
            const fromFile = await handleConvertMermaidToVsdx({ sourcePath: 'notes.md' }, deps(files, { parse: syntaxError as any }));
            expect(fromFile.isError).toBe(true);
            expect(fromFile.content[0].text).not.toContain('SECRET');
            expect(fromFile.content[0].text).toMatch(/syntax error on line 1/);

            // Inline source is the caller's own text: keep the helpful context.
            const inline = await handleConvertMermaidToVsdx({ source: 'SECRET TOKEN abc123' }, deps(files, { parse: syntaxError as any }));
            expect(inline.content[0].text).toContain('Diagram (line 1)');
        });
    });
});
