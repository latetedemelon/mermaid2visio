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
            'visio/document.xml',
            'visio/_rels/document.xml.rels',
            'visio/pages/pages.xml',
            'visio/pages/_rels/pages.xml.rels',
            'visio/pages/page1.xml',
        ];
        for (const name of required) {
            expect(files[name]).toBeDefined();
        }
    });

    it('declares content types for document, pages, and page parts', async () => {
        const files = await generate();
        const ct = files['[Content_Types].xml'];
        expect(ct).toContain('application/vnd.ms-visio.drawing.main+xml');
        expect(ct).toContain('application/vnd.ms-visio.pages+xml');
        expect(ct).toContain('application/vnd.ms-visio.page+xml');
        expect(ct).toContain('/visio/pages/pages.xml');
    });

    it('chains document -> pages -> page via relationships', async () => {
        const files = await generate();
        // root rels -> document
        expect(files['_rels/.rels']).toContain('Target="visio/document.xml"');
        expect(files['_rels/.rels']).toContain('relationships/document');

        // document rels -> pages.xml (NOT directly to page1.xml; Visio rejects
        // that shortcut).
        const docRels = files['visio/_rels/document.xml.rels'];
        expect(docRels).toContain('Target="pages/pages.xml"');
        expect(docRels).toContain('relationships/pages');
        expect(docRels).not.toMatch(/Target="pages\/page1\.xml"/);

        // pages.xml.rels -> page1.xml
        const pagesRels = files['visio/pages/_rels/pages.xml.rels'];
        expect(pagesRels).toContain('Target="page1.xml"');
        expect(pagesRels).toContain('relationships/page');
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
});
