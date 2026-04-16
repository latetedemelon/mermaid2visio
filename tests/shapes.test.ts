import { VsdxGenerator } from '../src/vsdx';
import type { GraphData } from '../src/parser';
import { unzipPage, getShape, getGeometrySection, getRowTypes, getCell } from './helpers';

async function generateOne(nodeOverrides: Partial<GraphData['nodes'][0]> = {}): Promise<string> {
    const graph: GraphData = {
        width: 200,
        height: 200,
        nodes: [{
            id: 'n', x: 10, y: 10, width: 96, height: 48, text: 'Node',
            ...nodeOverrides,
        }],
        edges: [],
        clusters: [],
        labels: [],
    };
    const buffer = await new VsdxGenerator().generate(graph);
    return unzipPage(buffer);
}

// For shape id 1 (only node in graph). Assert the geometry row types are what
// the generator documents for each shape type.
const cases: Array<{ type: string, geometries: string[][] }> = [
    { type: 'rectangle',     geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'diamond',       geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'stadium',       geometries: [['MoveTo', 'LineTo', 'ArcTo', 'LineTo', 'ArcTo']] },
    { type: 'parallelogram', geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'subroutine',    geometries: [
        ['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo'],
        ['MoveTo', 'LineTo'],
        ['MoveTo', 'LineTo'],
    ]},
    { type: 'cylinder',      geometries: [
        ['MoveTo', 'ArcTo', 'LineTo', 'ArcTo', 'LineTo'],
        ['MoveTo', 'ArcTo'],
    ]},
    { type: 'circle',        geometries: [['Ellipse']] },
    { type: 'ellipse',       geometries: [['Ellipse']] },
];

describe('Shape geometry emission', () => {
    for (const c of cases) {
        it(`emits the expected geometry rows for type=${c.type}`, async () => {
            const xml = await generateOne({ type: c.type });
            const body = getShape(xml, 1);
            c.geometries.forEach((expected, ix) => {
                const geom = getGeometrySection(body, ix);
                expect(getRowTypes(geom)).toEqual(expected);
            });
        });
    }

    it('emits a Rounding cell when node.rounding is set', async () => {
        const xml = await generateOne({ rounding: 12 });
        const body = getShape(xml, 1);
        expect(getCell(body, 'Rounding')).not.toBeNull();
        // 12 px at 96 dpi = 0.125 in
        expect(parseFloat(getCell(body, 'Rounding')!)).toBeCloseTo(0.125, 6);
    });

    it('emits a Hyperlink section when node.url is set', async () => {
        const xml = await generateOne({ url: 'https://example.com' });
        const body = getShape(xml, 1);
        expect(body).toMatch(/<Section\b[^>]*N="Hyperlink"/);
        expect(body).toContain('V="https://example.com"');
    });
});
