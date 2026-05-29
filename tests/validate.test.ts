import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';
import { validateVsdx } from '../src/validate';
import type { GraphData } from '../src/parser';

const here = path.dirname(fileURLToPath(import.meta.url));

// The validator is our stand-in for "does Visio accept this package?" since no
// Visio (and no working LibreOffice importer) is available in the sandbox. If
// these pass, the package satisfies every OOXML/ShapeSheet invariant we know
// Visio enforces. If a future change breaks one, the failure names the part.

describe('validateVsdx — generated packages are structurally sound', () => {
    const fixtures = ['all_features.mmd', 'rob_test.mmd'];

    it.each(fixtures)('%s passes structural validation', async (fixture) => {
        const src = fs.readFileSync(path.resolve(here, 'fixtures', fixture), 'utf-8');
        const graph = await parseMermaid(src);
        const buf = await new VsdxGenerator().generate(graph, src);
        const result = await validateVsdx(buf);
        if (!result.ok) {
            throw new Error(`Validation failed for ${fixture}:\n  - ${result.errors.join('\n  - ')}`);
        }
        expect(result.ok).toBe(true);
    }, 60000);

    it('synthetic graph with every node type + glued/unglued edges validates', async () => {
        const graph: GraphData = {
            width: 800,
            height: 600,
            nodes: [
                { id: 'r', x: 0,   y: 0,   width: 96, height: 48, text: 'Rect',    type: 'rectangle' },
                { id: 'd', x: 200, y: 0,   width: 96, height: 48, text: 'Diamond', type: 'diamond' },
                { id: 'c', x: 400, y: 0,   width: 96, height: 48, text: 'Circle',  type: 'circle' },
                { id: 's', x: 0,   y: 200, width: 96, height: 48, text: 'Stadium', type: 'stadium' },
                { id: 'y', x: 200, y: 200, width: 96, height: 48, text: 'Cyl',     type: 'cylinder' },
                { id: 'u', x: 400, y: 200, width: 96, height: 48, text: 'Sub',     type: 'subroutine' },
            ],
            edges: [
                // Glued edge (both endpoints resolve).
                { d: 'M0,0 L1,1', startId: 'r', endId: 'd', arrowEnd: true, text: 'glued' },
                // Unglued fallback edge (endpoints don't resolve) — exercises parsePathToVisio.
                { d: 'M 10 10 C 20 20 30 0 40 10 Q 50 20 60 10 A 5 5 0 0 1 70 10', arrowEnd: true },
            ],
            clusters: [
                { id: 'g', x: -10, y: -10, width: 520, height: 280, text: 'Group', style: { stroke: '#01579b' } },
            ],
            labels: [],
        };
        const buf = await new VsdxGenerator().generate(graph);
        const result = await validateVsdx(buf);
        if (!result.ok) {
            throw new Error(`Validation failed:\n  - ${result.errors.join('\n  - ')}`);
        }
        expect(result.ok).toBe(true);
    });

    it('detects a dangling relationship target', async () => {
        // Sanity-check the validator itself: corrupt a generated package and
        // confirm the dangling-rel rule fires (so a green run means something).
        const JSZip = (await import('jszip')).default;
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{ id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' }],
            edges: [], clusters: [], labels: [],
        };
        const buf = await new VsdxGenerator().generate(graph);
        const zip = await JSZip.loadAsync(buf);
        // Point the page relationship at a file that doesn't exist.
        const relsPath = 'visio/pages/_rels/pages.xml.rels';
        const rels = await zip.file(relsPath)!.async('string');
        zip.file(relsPath, rels.replace('page1.xml', 'page999.xml'));
        const corrupted = await zip.generateAsync({ type: 'nodebuffer' });

        const result = await validateVsdx(corrupted);
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => e.includes('page999.xml'))).toBe(true);
    });

    it('detects a NaN value left in a cell', async () => {
        const JSZip = (await import('jszip')).default;
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{ id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' }],
            edges: [], clusters: [], labels: [],
        };
        const buf = await new VsdxGenerator().generate(graph);
        const zip = await JSZip.loadAsync(buf);
        const page = await zip.file('visio/pages/page1.xml')!.async('string');
        // Corrupt a PinX into NaN, as a bad coordinate computation would.
        const broken = page.replace(/<Cell N="PinX" V="[^"]*"/, '<Cell N="PinX" V="NaN"');
        zip.file('visio/pages/page1.xml', broken);
        const corrupted = await zip.generateAsync({ type: 'nodebuffer' });

        const result = await validateVsdx(corrupted);
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => /NaN/.test(e))).toBe(true);
    });

    it('detects a formula left in a V attribute', async () => {
        const JSZip = (await import('jszip')).default;
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{ id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' }],
            edges: [], clusters: [], labels: [],
        };
        const buf = await new VsdxGenerator().generate(graph);
        const zip = await JSZip.loadAsync(buf);
        const page = await zip.file('visio/pages/page1.xml')!.async('string');
        // Inject a bogus cell with a formula token in V and no F *inside* a
        // Shape (the rule is scoped to per-shape cells, matching the generator).
        const broken = page.replace('Type="Shape">', 'Type="Shape"><Cell N="Bogus" V="Width*0.5"/>');
        zip.file('visio/pages/page1.xml', broken);
        const corrupted = await zip.generateAsync({ type: 'nodebuffer' });

        const result = await validateVsdx(corrupted);
        expect(result.ok).toBe(false);
        expect(result.errors.some(e => /formula in V/.test(e))).toBe(true);
    });
});
