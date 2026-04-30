import { VsdxGenerator } from '../src/vsdx';
import type { GraphData } from '../src/parser';
import { unzipPage, getShape, getCell } from './helpers';

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

        // LineWeight = strokeWidth (4) * 0.01 = 0.04 in (legacy magic factor).
        expect(parseFloat(getCell(body, 'LineWeight')!)).toBeCloseTo(0.04, 6);

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
        expect(body).toMatch(/V="&quot;Container&quot;"/); // xmlbuilder2 escapes quotes
        expect(body).toMatch(/<Section\b[^>]*N="TextBlock"/);
        expect(body).toMatch(/N="VerticalAlign"\s+V="0"/); // top
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

    it('omits LinePattern when strokeDasharray is absent or "none"', async () => {
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
        expect(getCell(body, 'LinePattern')).toBeNull();
    });
});
