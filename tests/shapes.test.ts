import { VsdxGenerator } from '../src/vsdx';
import type { GraphData, GraphNode } from '../src/parser';
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
    // Semicircular ends are elliptical arcs through the middle of each end.
    { type: 'stadium',       geometries: [['MoveTo', 'LineTo', 'EllipticalArcTo', 'LineTo', 'EllipticalArcTo']] },
    { type: 'hexagon',       geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'trapezoid',     geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'inv_trapezoid', geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'parallelogram', geometries: [['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']] },
    { type: 'subroutine',    geometries: [
        ['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo'],
        ['MoveTo', 'LineTo'],
        ['MoveTo', 'LineTo'],
    ]},
    { type: 'cylinder',      geometries: [
        ['MoveTo', 'EllipticalArcTo', 'LineTo', 'EllipticalArcTo', 'LineTo'],
        ['MoveTo', 'EllipticalArcTo'],
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

    // Corner coordinates in the shape's own space (origin bottom-left, y up),
    // as fractions of a 192 x 96 px (2 x 1 in) node.
    const corners = async (node: Partial<GraphNode>) => {
        const body = getShape(await generateOne({ width: 192, height: 96, ...node }), 1);
        const geom = getGeometrySection(body, 0);
        return [...geom.matchAll(/<Row T="(?:MoveTo|LineTo)"[^>]*><Cell N="X" V="([^"]+)"[^>]*\/><Cell N="Y" V="([^"]+)"/g)]
            .map(m => [parseFloat(m[1]), parseFloat(m[2])]);
    };

    it('leans a parallelogram the way Mermaid drew it', async () => {
        // [/text/] : the top edge is shifted right of the bottom edge.
        const right = await corners({ type: 'parallelogram', shape: 'lean_right' });
        expect(right.slice(0, 4)).toEqual([[0, 0], [1.5, 0], [2, 1], [0.5, 1]]);
        // [\text\] : the top edge is shifted left.
        const left = await corners({ type: 'parallelogram', shape: 'lean_left' });
        expect(left.slice(0, 4)).toEqual([[0.5, 0], [2, 0], [1.5, 1], [0, 1]]);
    });

    it('draws trapezoids wide side down, inverted trapezoids wide side up', async () => {
        expect((await corners({ type: 'trapezoid' })).slice(0, 4)).toEqual([[0, 0], [2, 0], [1.5, 1], [0.5, 1]]);
        expect((await corners({ type: 'inv_trapezoid' })).slice(0, 4)).toEqual([[0.5, 0], [1.5, 0], [2, 1], [0, 1]]);
    });

    it('gives a stadium true semicircular ends', async () => {
        const body = getShape(await generateOne({ type: 'stadium', width: 192, height: 96 }), 1);
        const arcs = [...getGeometrySection(body, 0).matchAll(/<Row T="EllipticalArcTo"[^>]*>(.*?)<\/Row>/g)].map(m => m[1]);
        const val = (row: string, n: string) => parseFloat(new RegExp(`N="${n}" V="([^"]+)"`).exec(row)![1]);
        // Right end: from (1.5,0) to (1.5,1) through (2,0.5); left end back
        // through (0,0.5). Circular (axis ratio 1).
        expect([val(arcs[0], 'X'), val(arcs[0], 'Y'), val(arcs[0], 'A'), val(arcs[0], 'B'), val(arcs[0], 'D')]).toEqual([1.5, 1, 2, 0.5, 1]);
        expect([val(arcs[1], 'X'), val(arcs[1], 'Y'), val(arcs[1], 'A'), val(arcs[1], 'B'), val(arcs[1], 'D')]).toEqual([0.5, 0, 0, 0.5, 1]);
    });

    it('adds an inner ring for a double circle', async () => {
        const body = getShape(await generateOne({ type: 'circle', shape: 'doublecircle' }), 1);
        expect(getRowTypes(getGeometrySection(body, 0))).toEqual(['Ellipse']);
        expect(getRowTypes(getGeometrySection(body, 1))).toEqual(['Ellipse']);
    });

    it('states the local pin so PinX/PinY is the centre of the shape', async () => {
        const body = getShape(await generateOne({ width: 192, height: 96 }), 1);
        expect(body).toMatch(/<Cell N="LocPinX" V="1" F="Width\*0\.5"\/>/);
        expect(body).toMatch(/<Cell N="LocPinY" V="0\.5" F="Height\*0\.5"\/>/);
    });

    it('writes connection points in the form Visio does', async () => {
        const body = getShape(await generateOne({}), 1);
        const rows = [...body.matchAll(/<Row T="Connection" IX="(\d)">/g)].map(m => m[1]);
        expect(rows).toEqual(['0', '1', '2', '3']);
    });
});
