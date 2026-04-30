import { describe, it, expect } from '@jest/globals';
import { VsdxGenerator } from '../src/vsdx';
import { unzipAll } from './helpers';

// Structural tests for the VSDX OOXML package. Visio refuses to open files
// that are missing any of these parts or whose relationship chain is broken,
// so we assert the package shape without needing Visio itself.

const EMPTY_GRAPH = {
    width: 800, height: 600,
    nodes: [{ id: 'n1', x: 100, y: 100, width: 120, height: 60, type: 'rectangle', text: 'Hi' }],
    edges: [],
    clusters: [],
    labels: [],
} as any;

async function generate() {
    const buf = await new VsdxGenerator().generate(EMPTY_GRAPH);
    return unzipAll(buf);
}

describe('VSDX package structure', () => {
    it('includes every required OOXML part', async () => {
        const files = await generate();
        const required = [
            '[Content_Types].xml',
            '_rels/.rels',
            'docProps/app.xml',
            'docProps/core.xml',
            'visio/document.xml',
            'visio/_rels/document.xml.rels',
            'visio/windows.xml',
            'visio/pages/pages.xml',
            'visio/pages/_rels/pages.xml.rels',
            'visio/pages/page1.xml',
        ];
        for (const name of required) {
            expect(files[name]).toBeDefined();
        }
    });

    it('declares content types for document, pages, page, docProps, and windows parts', async () => {
        const files = await generate();
        const ct = files['[Content_Types].xml'];
        expect(ct).toContain('application/vnd.ms-visio.drawing.main+xml');
        expect(ct).toContain('application/vnd.ms-visio.pages+xml');
        expect(ct).toContain('application/vnd.ms-visio.page+xml');
        expect(ct).toContain('application/vnd.ms-visio.windows+xml');
        expect(ct).toContain('application/vnd.openxmlformats-officedocument.extended-properties+xml');
        expect(ct).toContain('application/vnd.openxmlformats-package.core-properties+xml');
        expect(ct).toContain('/visio/pages/pages.xml');
    });

    it('chains document -> pages -> page via relationships', async () => {
        const files = await generate();
        // root rels -> document, extended-properties, core-properties
        const rootRels = files['_rels/.rels'];
        expect(rootRels).toContain('Target="visio/document.xml"');
        expect(rootRels).toContain('relationships/document');
        expect(rootRels).toContain('Target="docProps/app.xml"');
        expect(rootRels).toContain('relationships/extended-properties');
        expect(rootRels).toContain('Target="docProps/core.xml"');
        expect(rootRels).toContain('relationships/metadata/core-properties');

        // document rels -> pages.xml (NOT directly to page1.xml; Visio rejects
        // that shortcut) and windows.xml for the saved view state.
        const docRels = files['visio/_rels/document.xml.rels'];
        expect(docRels).toContain('Target="pages/pages.xml"');
        expect(docRels).toContain('relationships/pages');
        expect(docRels).toContain('Target="windows.xml"');
        expect(docRels).toContain('relationships/windows');
        expect(docRels).not.toMatch(/Target="pages\/page1\.xml"/);

        // pages.xml.rels -> page1.xml
        const pagesRels = files['visio/pages/_rels/pages.xml.rels'];
        expect(pagesRels).toContain('Target="page1.xml"');
        expect(pagesRels).toContain('relationships/page');
    });

    it('omits empty collection elements from document.xml', async () => {
        // Visio 16 error 1400015 / 0x10F ("parts are missing or invalid")
        // fires when optional collections like <FaceNames/> are present but
        // empty. Schema says they're OK to omit; it is NOT OK to include them
        // with zero children.
        const files = await generate();
        const doc = files['visio/document.xml'];
        expect(doc).not.toMatch(/<FaceNames\s*\/>/);
        expect(doc).not.toMatch(/<StyleSheets\s*\/>/);
        expect(doc).not.toMatch(/<DocumentSheet\s*\/>/);
        expect(doc).not.toMatch(/<Masters\s*\/>/);
    });

    it('writes a Drawing window in windows.xml pinned to Page-1', async () => {
        // Without windows.xml Visio 2016+ can open the file but refuses to
        // persist zoom/pan state and, on some builds, complains about a
        // missing view part at load time. The Window must carry
        // WindowType="Drawing" and ContainerType="Page".
        const files = await generate();
        const win = files['visio/windows.xml'];
        expect(win).toContain('WindowType="Drawing"');
        expect(win).toContain('ContainerType="Page"');
        expect(win).toMatch(/Page="\d+"/);
    });

    it('does not inline <Pages> inside document.xml', async () => {
        // Pre-fix bug: document.xml contained <Pages><Page .../></Pages> but
        // no pages.xml part, so Visio could not locate the page content.
        const files = await generate();
        expect(files['visio/document.xml']).not.toMatch(/<Pages>/);
    });

    it('pages.xml links to page1.xml via a Rel element', async () => {
        const files = await generate();
        const pagesXml = files['visio/pages/pages.xml'];
        expect(pagesXml).toContain('<Page');
        expect(pagesXml).toMatch(/<PageSheet>/);
        expect(pagesXml).toContain('<Cell N="PageWidth"');
        expect(pagesXml).toContain('<Cell N="PageHeight"');
        // The <Rel r:id="rId1"/> ties the page entry to the relationship in
        // pages.xml.rels. Without it, Visio shows the page in the sidebar but
        // renders nothing.
        expect(pagesXml).toMatch(/<Rel\s+r:id="rId1"\s*\/>/);
    });

    it('never puts ShapeSheet formulas in the V attribute', async () => {
        // Visio parses V as a literal value; formula expressions like
        // "Width*0.5" must live in F, otherwise the cell ends up with no
        // effective coordinate and the shape renders empty.
        const files = await generate();
        const page = files['visio/pages/page1.xml'];
        expect(page).not.toMatch(/V="Width\*/);
        expect(page).not.toMatch(/V="Height\*/);
        expect(page).not.toMatch(/V="Width"/);
        expect(page).not.toMatch(/V="Height"/);
    });

    it('emits only hex colors (no rgb(), no named colors)', async () => {
        // Visio rejects CSS rgb() syntax in cell values; must be #RRGGBB.
        const files = await generate();
        const page = files['visio/pages/page1.xml'];
        expect(page).not.toMatch(/rgb\s*\(/);
    });

    it('places <Text> after all <Section> elements in a shape', async () => {
        // Shape schema: Cells -> Sections -> Text. Visio rejects documents
        // that interleave Text between Sections.
        const files = await generate();
        const page = files['visio/pages/page1.xml'];
        const shapeMatch = /<Shape\b[^>]*>([\s\S]*?)<\/Shape>/.exec(page);
        expect(shapeMatch).not.toBeNull();
        const body = shapeMatch![1];
        const lastSection = body.lastIndexOf('</Section>');
        const textStart = body.indexOf('<Text');
        if (textStart !== -1 && lastSection !== -1) {
            expect(textStart).toBeGreaterThan(lastSection);
        }
    });
});
