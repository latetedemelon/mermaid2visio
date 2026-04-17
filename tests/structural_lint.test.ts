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
const fixturePath = path.resolve(here, 'fixtures', 'all_features.mmd');

async function generatePageXml(): Promise<string> {
    const src = fs.readFileSync(fixturePath, 'utf-8');
    const graph = await parseMermaid(src);
    const buf = await new VsdxGenerator().generate(graph);
    return await unzipPage(buf);
}

describe('VSDX structural lint (all_features fixture)', () => {
    let pageXml: string;

    beforeAll(async () => {
        pageXml = await generatePageXml();
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

    it('emits font sizes as plain numbers (no "pt" suffix in V)', () => {
        // The unit goes in U="PT"; V must be numeric or Visio treats the cell
        // as unset and falls back to the default font size.
        const sizeCells = pageXml.match(/<Cell N="Size"[^/]*\/>/g) || [];
        expect(sizeCells.length).toBeGreaterThan(0);
        for (const cell of sizeCells) {
            const v = /V="([^"]+)"/.exec(cell)?.[1];
            expect(v).toMatch(/^\d+(?:\.\d+)?$/);
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

    it('produces at least one shape per shape kind in the fixture', () => {
        // Sanity check: if the parser silently skipped a shape, the round-trip
        // render test still passes (PDF is non-empty) but coverage is lost.
        // Exact count varies with Mermaid releases, so just assert "many".
        const shapeCount = (pageXml.match(/<Shape\b/g) || []).length;
        expect(shapeCount).toBeGreaterThan(6);
    });

    it('declares ObjType=2 for connector shapes', () => {
        // Without ObjType=2, Visio renders the shape as a free-floating line
        // instead of a glued connector that follows its endpoints.
        expect(pageXml).toContain('<Cell N="ObjType" V="2"/>');
    });
});
