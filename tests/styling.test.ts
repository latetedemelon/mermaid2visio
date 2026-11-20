import { VsdxGenerator } from '../src/vsdx';
import type { GraphData } from '../src/parser';
import { unzipPage, unzipAll, getShape, getCell } from './helpers';

describe('Styling cells', () => {
    it('emits fill, stroke, line weight, dash pattern and character styling', async () => {
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{
                id: 'n', x: 0, y: 0, width: 96, height: 48, text: 'Styled',
                style: {
                    fill: '#ffcccc', stroke: '#333333', strokeWidth: '4',
                    strokeDasharray: '5 5', color: '#112233',
                    fontSize: '16px', fontFamily: 'Arial',
                    fontWeight: 'bold', fontStyle: 'italic', textAlign: 'left',
                },
            }],
            edges: [], clusters: [], labels: [],
        };

        const xml = await unzipPage(await new VsdxGenerator().generate(graph));
        const body = getShape(xml, 1);

        expect(getCell(body, 'FillForegnd')).toBe('#ffcccc');
        expect(getCell(body, 'LineColor')).toBe('#333333');
        expect(getCell(body, 'LinePattern')).not.toBeNull();

        // LineWeight = strokeWidth (4px) / 96 dpi = 0.04166... inches.
        expect(parseFloat(getCell(body, 'LineWeight')!)).toBeCloseTo(4 / 96, 6);

        // Character section should contain the color, size, and bitwise style (bold|italic = 3).
        const charMatch = /<Section\b[^>]*N="Character"[\s\S]*?<\/Section>/.exec(body);
        expect(charMatch).not.toBeNull();
        const char = charMatch![0];
        expect(char).toContain('V="#112233"');
        // Character.Size is a spatial cell: Visio reads it in the document's
        // internal unit (inches) no matter what U= says. Emitting points with
        // U="PT" made Visio render text at 12 INCHES tall. Convert px -> in
        // directly (16 / 96 = 0.1667) and leave U off.
        expect(char).toMatch(/N="Size"\s+V="0\.1667"\s*\/>/); // 16px / 96dpi = 0.1667in
        expect(char).not.toMatch(/N="Size"[^/]*U="PT"/);
        expect(char).toMatch(/N="Style"\s+V="3"/);

        // HorzAlign=0 (left) lives in a Paragraph section.
        const para = /<Section\b[^>]*N="Paragraph"[\s\S]*?<\/Section>/.exec(body);
        expect(para).not.toBeNull();
        expect(para![0]).toMatch(/N="HorzAlign"\s+V="0"/);
    });

    it('emits cluster Container marker and top-aligned text block', async () => {
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [],
            edges: [],
            clusters: [{ id: 'c', x: 10, y: 10, width: 100, height: 60, text: 'Cluster' }],
            labels: [],
        };
        const xml = await unzipPage(await new VsdxGenerator().generate(graph));
        const body = getShape(xml, 1);

        expect(body).toMatch(/<Section\b[^>]*N="User"/);
        expect(body).toMatch(/N="msvStructureType"/);
        expect(body).toMatch(/<Row N="msvStructureType"><Cell N="Value" V="Container" U="STR"\/>/);
        // VerticalAlign is a cell on the shape (there is no "TextBlock" section).
        expect(body).not.toMatch(/N="TextBlock"/);
        expect(getCell(body, 'VerticalAlign')).toBe('0'); // top
    });

    it('emits edge labels with background fill when requested', async () => {
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [],
            edges: [],
            clusters: [],
            labels: [{
                x: 50, y: 50, width: 40, height: 20, text: 'LBL',
                style: { fill: '#ffffcc', color: '#000000', fontSize: '12px' },
            }],
        };
        const xml = await unzipPage(await new VsdxGenerator().generate(graph));
        const body = getShape(xml, 1);
        expect(getCell(body, 'FillPattern')).toBe('1'); // overridden to 1 when fill set
        expect(getCell(body, 'FillForegnd')).toBe('#ffffcc');
        expect(body).toContain('LBL');
    });

    it('writes a solid LinePattern when strokeDasharray is absent or "none"', async () => {
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{
                id: 'n', x: 0, y: 0, width: 96, height: 48, text: 'Plain',
                style: { fill: '#fff', stroke: '#000', strokeDasharray: 'none' },
            }],
            edges: [], clusters: [], labels: [],
        };
        const xml = await unzipPage(await new VsdxGenerator().generate(graph));
        const body = getShape(xml, 1);
        // Written explicitly: nothing is left to style-sheet inheritance.
        expect(getCell(body, 'LinePattern')).toBe('1');
        expect(getCell(body, 'FillPattern')).toBe('1');
    });

    const oneNode = async (style: NonNullable<GraphData['nodes'][number]['style']>) => {
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{ id: 'n', x: 0, y: 0, width: 96, height: 48, text: 'T', style }],
            edges: [], clusters: [], labels: [],
        };
        return getShape(await unzipPage(await new VsdxGenerator().generate(graph)), 1);
    };

    it('tells dashed from dotted borders', async () => {
        expect(getCell(await oneNode({ stroke: '#000', strokeDasharray: '5px, 5px' }), 'LinePattern')).toBe('2');
        expect(getCell(await oneNode({ stroke: '#000', strokeDasharray: '2px' }), 'LinePattern')).toBe('3');
        expect(getCell(await oneNode({ stroke: '#000', strokeDasharray: '0px' }), 'LinePattern')).toBe('1');
    });

    // "transparent" and rgba(…, 0) used to become solid black.
    it('leaves a shape unfilled or unlined when its paint is none or fully transparent', async () => {
        for (const fill of ['none', 'transparent', 'rgba(0, 0, 0, 0)']) {
            const body = await oneNode({ fill, stroke: '#333333' });
            expect(getCell(body, 'FillPattern')).toBe('0');
            expect(getCell(body, 'FillForegnd')).toBeNull();
        }
        const noLine = await oneNode({ fill: '#ffffff', stroke: 'none' });
        expect(getCell(noLine, 'LinePattern')).toBe('0');
        expect(getCell(noLine, 'LineColor')).toBeNull();
    });

    it('carries partial transparency as a separate cell', async () => {
        const body = await oneNode({ fill: 'rgba(255, 0, 0, 0.25)', stroke: 'rgba(0, 0, 255, 0.5)' });
        expect(getCell(body, 'FillForegnd')).toBe('#ff0000');
        expect(parseFloat(getCell(body, 'FillForegndTrans')!)).toBeCloseTo(0.75, 6);
        expect(getCell(body, 'LineColor')).toBe('#0000ff');
        expect(parseFloat(getCell(body, 'LineColorTrans')!)).toBeCloseTo(0.5, 6);
    });

    it('treats font weights of 600 and up as bold', async () => {
        for (const [weight, bold] of [['400', false], ['500', false], ['600', true], ['700', true], ['900', true], ['bold', true], ['bolder', true], ['normal', false]] as const) {
            const body = await oneNode({ fontWeight: weight, color: '#000' });
            expect(/N="Style" V="1"/.test(body)).toBe(bold);
        }
    });

    it('writes the font family only when asked to, with a matching font table entry', async () => {
        const graph: GraphData = {
            width: 200, height: 200,
            nodes: [{ id: 'n', x: 0, y: 0, width: 96, height: 48, text: 'T', style: { fontFamily: '"Segoe UI", sans-serif' } }],
            edges: [], clusters: [], labels: [],
        };
        const off = await unzipAll(await new VsdxGenerator().generate(graph));
        expect(off['visio/pages/page1.xml']).not.toMatch(/N="Font"/);
        expect(off['visio/document.xml']).not.toMatch(/<FaceNames>/);

        const on = await unzipAll(await new VsdxGenerator({ fonts: true }).generate(graph));
        expect(on['visio/pages/page1.xml']).toMatch(/<Cell N="Font" V="Segoe UI"\/>/);
        expect(on['visio/document.xml']).toMatch(/<FaceNames>.*<FaceName NameU="Segoe UI"\/>.*<\/FaceNames>/);
    });
});
