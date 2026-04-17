import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';
import { unzipPage } from './helpers';

// Hand-written lint pass that catches every VSDX gotcha we've burned a
// debugging session on. Each rule fires when we'd otherwise regress to a
// file that opens-but-misrenders in Visio.
//
// We don't have the MS-VSDX XSDs bundled (license-restricted), so instead
// we encode the schema constraints we actually rely on.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = [
    { name: 'all_features.mmd',  minShapes: 6 },
    // rob_test.mmd stresses the generator with ELK layout, nested subgraphs,
    // classDef on subgraph nodes, quoted edge labels, and emoji + <br> in
    // node text. Worth keeping as a realistic regression canary.
    { name: 'rob_test.mmd',      minShapes: 20 },
];

async function generatePageXml(fixture: string): Promise<string> {
    const src = fs.readFileSync(path.resolve(here, 'fixtures', fixture), 'utf-8');
    const graph = await parseMermaid(src);
    const buf = await new VsdxGenerator().generate(graph);
    return await unzipPage(buf);
}

describe.each(fixtures)('VSDX structural lint ($name)', ({ name, minShapes }) => {
    let pageXml: string;

    beforeAll(async () => {
        pageXml = await generatePageXml(name);
    }, 60000);

    it('uses #RRGGBB hex for every color cell, never rgb()/rgba()', () => {
        // Visio silently ignores cells whose V isn't valid for the cell type.
        // Mermaid's getComputedStyle yields rgb(...) for almost all colors, so
        // forgetting to normalize is the most common regression.
        expect(pageXml).not.toMatch(/V="rgb[a]?\(/i);
        const colorCells = pageXml.match(/<Cell N="(?:FillForegnd|LineColor|Color)" V="([^"]+)"/g) || [];
        for (const cell of colorCells) {
            const v = /V="([^"]+)"/.exec(cell)![1];
            expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });

    it('puts ShapeSheet formulas in F=, not V=', () => {
        // Visio parses V as a literal numeric. "Width*0.5" in V becomes a
        // dropped row; the geometry collapses but no error is raised.
        const formulaInV = pageXml.match(/V="[^"]*\b(?:Width|Height|PageWidth|PageHeight)\b[^"]*"/g);
        expect(formulaInV).toBeNull();
    });

    it('emits font sizes as plain inch values (no "pt" suffix, no U="PT")', () => {
        // Character.Size is spatial — Visio reads it in inches regardless of
        // U=. V must be numeric (literal "12pt" is dropped), and U must NOT
        // be "PT" or Visio renders text at V inches tall (12pt -> 12 INCHES).
        const sizeCells = pageXml.match(/<Cell N="Size"[^/]*\/>/g) || [];
        expect(sizeCells.length).toBeGreaterThan(0);
        for (const cell of sizeCells) {
            const v = /V="([^"]+)"/.exec(cell)?.[1];
            expect(v).toMatch(/^\d+(?:\.\d+)?$/);
            expect(cell).not.toMatch(/U="PT"/);
        }
    });

    it('orders Shape children as Cells -> Sections -> Text', () => {
        // Visio's Shape schema is sequence-strict: a <Text> child that
        // appears before a <Section> sibling makes the whole shape invalid
        // and Visio drops it from the page.
        const shapes = pageXml.match(/<Shape\b[^>]*>[\s\S]*?<\/Shape>/g) || [];
        expect(shapes.length).toBeGreaterThan(0);
        for (const shape of shapes) {
            const lastSectionIdx = shape.lastIndexOf('</Section>');
            const textIdx = shape.indexOf('<Text>');
            if (textIdx === -1) continue; // shape with no text is fine
            if (lastSectionIdx === -1) continue; // no sections at all is fine
            expect(textIdx).toBeGreaterThan(lastSectionIdx);
        }
    });

    it('produces the expected number of shapes for the fixture', () => {
        // Sanity check: if the parser silently skipped a shape, the round-trip
        // render test still passes (PDF is non-empty) but coverage is lost.
        // Exact count varies with Mermaid releases, so just assert "many".
        const shapeCount = (pageXml.match(/<Shape\b/g) || []).length;
        expect(shapeCount).toBeGreaterThan(minShapes);
    });

    it('declares ObjType=2 for connector shapes', () => {
        // Without ObjType=2, Visio renders the shape as a free-floating line
        // instead of a glued connector that follows its endpoints.
        expect(pageXml).toContain('<Cell N="ObjType" V="2"/>');
    });
});
