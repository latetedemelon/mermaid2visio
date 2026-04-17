import JSZip from 'jszip';
import { create } from 'xmlbuilder2';
import { GraphData } from './parser.js';

export class VsdxGenerator {
    private zip: JSZip;
    private pageHeight: number = 11; // inches
    private pageWidth: number = 8.5; // inches
    private dpi: number = 96;

    constructor() {
        this.zip = new JSZip();
    }

    // Visio rejects CSS `rgb(r, g, b)` syntax (and named colors) in cell values;
    // it wants `#RRGGBB`. Mermaid's rendered SVG uses rgb(...) for almost all
    // computed styles, so normalize everything here.
    public static normalizeColor(c: string | undefined | null): string | undefined {
        if (!c) return undefined;
        const t = String(c).trim();
        if (!t || t === 'none' || t === 'transparent') return undefined;
        if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(t)) {
            const r = t[1], g = t[2], b = t[3];
            return ('#' + r + r + g + g + b + b).toLowerCase();
        }
        const m = t.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (m) {
            const toHex = (s: string) => Math.max(0, Math.min(255, parseInt(s, 10))).toString(16).padStart(2, '0');
            return ('#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3])).toLowerCase();
        }
        return undefined;
    }

    public async generate(graph: GraphData): Promise<Buffer> {
        // Adjust page size if graph is too big
        const graphWidthIn = graph.width / this.dpi;
        const graphHeightIn = graph.height / this.dpi;

        if (graphWidthIn > this.pageWidth) this.pageWidth = graphWidthIn + 1;
        if (graphHeightIn > this.pageHeight) this.pageHeight = graphHeightIn + 1;

        this.addContentTypes();
        this.addRels();
        this.addDocProps();
        this.addDocumentXml();
        this.addWindowsXml();
        this.addPagesXml();
        this.addPageXml(graph);

        return await this.zip.generateAsync({ type: 'nodebuffer' });
    }

    private addContentTypes() {
        const xml = create({ encoding: 'UTF-8', standalone: true })
            .ele('Types', { xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types' })
                .ele('Default', { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' }).up()
                .ele('Default', { Extension: 'xml', ContentType: 'application/xml' }).up()
                .ele('Override', { PartName: '/docProps/app.xml', ContentType: 'application/vnd.openxmlformats-officedocument.extended-properties+xml' }).up()
                .ele('Override', { PartName: '/docProps/core.xml', ContentType: 'application/vnd.openxmlformats-package.core-properties+xml' }).up()
                .ele('Override', { PartName: '/visio/document.xml', ContentType: 'application/vnd.ms-visio.drawing.main+xml' }).up()
                .ele('Override', { PartName: '/visio/windows.xml', ContentType: 'application/vnd.ms-visio.windows+xml' }).up()
                .ele('Override', { PartName: '/visio/pages/pages.xml', ContentType: 'application/vnd.ms-visio.pages+xml' }).up()
                .ele('Override', { PartName: '/visio/pages/page1.xml', ContentType: 'application/vnd.ms-visio.page+xml' }).up()
            .up();
        this.zip.file('[Content_Types].xml', xml.end({ prettyPrint: true }));
    }

    private addRels() {
        // Root _rels/.rels: Visio's loader expects the usual OOXML trio
        // (document + core-properties + extended-properties). Missing
        // core/app props is one of the triggers for error 1400015/0x10F.
        const xml = create({ encoding: 'UTF-8', standalone: true })
            .ele('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' })
                .ele('Relationship', { Id: 'rId1', Type: 'http://schemas.microsoft.com/visio/2010/relationships/document', Target: 'visio/document.xml' }).up()
                .ele('Relationship', { Id: 'rId2', Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', Target: 'docProps/app.xml' }).up()
                .ele('Relationship', { Id: 'rId3', Type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', Target: 'docProps/core.xml' }).up()
            .up();
        this.zip.folder('_rels')?.file('.rels', xml.end({ prettyPrint: true }));
    }

    private addDocProps() {
        // docProps/app.xml: OOXML extended properties. The Application string
        // is what Visio reads to recognize its own files in some code paths.
        const app = create({ encoding: 'UTF-8', standalone: true })
            .ele('Properties', {
                xmlns: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
                'xmlns:vt': 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
            })
                .ele('Application').txt('Microsoft Visio').up()
                .ele('ScaleCrop').txt('false').up()
                .ele('LinksUpToDate').txt('false').up()
                .ele('SharedDoc').txt('false').up()
                .ele('HyperlinksChanged').txt('false').up()
                .ele('AppVersion').txt('16.0000').up()
            .up();
        this.zip.folder('docProps')?.file('app.xml', app.end({ prettyPrint: true }));

        // docProps/core.xml: Dublin Core metadata. Timestamps use the static
        // epoch so generated files are byte-identical run-to-run, which keeps
        // the structural tests deterministic.
        const iso = '1970-01-01T00:00:00Z';
        const core = create({ encoding: 'UTF-8', standalone: true })
            .ele('cp:coreProperties', {
                'xmlns:cp': 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
                'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
                'xmlns:dcterms': 'http://purl.org/dc/terms/',
                'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
            })
                .ele('dc:creator').txt('mermaid2visio').up()
                .ele('cp:lastModifiedBy').txt('mermaid2visio').up()
                .ele('dcterms:created', { 'xsi:type': 'dcterms:W3CDTF' }).txt(iso).up()
                .ele('dcterms:modified', { 'xsi:type': 'dcterms:W3CDTF' }).txt(iso).up()
            .up();
        this.zip.folder('docProps')?.file('core.xml', core.end({ prettyPrint: true }));
    }

    private addDocumentXml() {
        // Note: the <Pages> collection belongs in visio/pages/pages.xml, not
        // inline here. Visio rejects (or silently drops) documents that list
        // pages in document.xml.
        //
        // We deliberately omit empty <FaceNames/>, <StyleSheets/>,
        // <DocumentSheet/>, <Masters/> — they're all optional in the VSDX
        // schema but INVALID when present-but-empty, which was the
        // 1400015/0x10F culprit in prior builds.
        const xml = create({ encoding: 'UTF-8', standalone: true })
            .ele('VisioDocument', { xmlns: 'http://schemas.microsoft.com/office/visio/2012/main' })
                .ele('DocumentSettings')
                    .ele('DynamicGridEnabled').txt('1').up()
                .up()
                .ele('Colors')
                    .ele('ColorEntry', { IX: '0', RGB: '#000000' }).up()
                    .ele('ColorEntry', { IX: '1', RGB: '#FFFFFF' }).up()
                .up()
            .up();

        this.zip.folder('visio')?.file('document.xml', xml.end({ prettyPrint: true }));

        // Document rels: pages.xml (drawing pages) and windows.xml (saved
        // view/zoom state). Visio treats a missing windows.xml relationship
        // as "this file wasn't written by Visio" and sometimes refuses to
        // open it entirely.
        const rels = create({ encoding: 'UTF-8', standalone: true })
            .ele('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' })
                .ele('Relationship', { Id: 'rId1', Type: 'http://schemas.microsoft.com/visio/2010/relationships/pages', Target: 'pages/pages.xml' }).up()
                .ele('Relationship', { Id: 'rId2', Type: 'http://schemas.microsoft.com/visio/2010/relationships/windows', Target: 'windows.xml' }).up()
            .up();
        this.zip.folder('visio')?.folder('_rels')?.file('document.xml.rels', rels.end({ prettyPrint: true }));
    }

    private addWindowsXml() {
        // visio/windows.xml: persisted view state (zoom, scroll position,
        // which page is current). Visio writes this on every save; we emit
        // a minimal single Drawing window centered on Page-1.
        const cx = String(this.pageWidth / 2);
        const cy = String(this.pageHeight / 2);
        const xml = create({ encoding: 'UTF-8', standalone: true })
            .ele('Windows', {
                xmlns: 'http://schemas.microsoft.com/office/visio/2012/main',
                ClientWidth: '1024',
                ClientHeight: '768',
            })
                .ele('Window', {
                    ID: '0',
                    WindowType: 'Drawing',
                    WindowState: '1073741824',
                    WindowLeft: '0',
                    WindowTop: '0',
                    WindowWidth: '1024',
                    WindowHeight: '768',
                    ContainerType: 'Page',
                    Page: '0',
                    ViewScale: '-1',
                    ViewCenterX: cx,
                    ViewCenterY: cy,
                })
                    .ele('ShowRulers').txt('1').up()
                    .ele('ShowGrid').txt('1').up()
                    .ele('ShowPageBreaks').txt('0').up()
                    .ele('ShowGuides').txt('1').up()
                    .ele('ShowConnectionPoints').txt('1').up()
                    .ele('GlueSettings').txt('9').up()
                    .ele('SnapSettings').txt('65847').up()
                    .ele('SnapExtensions').txt('34').up()
                    .ele('SnapAngles').up()
                    .ele('DynamicGridEnabled').txt('1').up()
                    .ele('TabSplitterPos').txt('0.5').up()
                .up()
            .up();
        this.zip.folder('visio')?.file('windows.xml', xml.end({ prettyPrint: true }));
    }

    private addPagesXml() {
        // The Pages collection: one <Page> per page file. The Rel child links
        // to page1.xml via the relationship declared in pages.xml.rels.
        const xml = create({ encoding: 'UTF-8', standalone: true })
            .ele('Pages', {
                xmlns: 'http://schemas.microsoft.com/office/visio/2012/main',
                'xmlns:r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
            })
                .ele('Page', { ID: '0', Name: 'Page-1', NameU: 'Page-1', ViewScale: '1', ViewCenterX: String(this.pageWidth / 2), ViewCenterY: String(this.pageHeight / 2) })
                    .ele('PageSheet')
                        .ele('Cell', { N: 'PageWidth',       V: String(this.pageWidth) }).up()
                        .ele('Cell', { N: 'PageHeight',      V: String(this.pageHeight) }).up()
                        .ele('Cell', { N: 'ShdwOffsetX',     V: '0.125' }).up()
                        .ele('Cell', { N: 'ShdwOffsetY',     V: '-0.125' }).up()
                        .ele('Cell', { N: 'PageScale',       V: '1', U: 'IN_F' }).up()
                        .ele('Cell', { N: 'DrawingScale',    V: '1', U: 'IN_F' }).up()
                        .ele('Cell', { N: 'DrawingSizeType', V: '0' }).up()
                        .ele('Cell', { N: 'DrawingScaleType', V: '0' }).up()
                        .ele('Cell', { N: 'InhibitSnap',     V: '0' }).up()
                    .up()
                    .ele('Rel', { 'r:id': 'rId1' }).up()
                .up()
            .up();
        this.zip.folder('visio')?.folder('pages')?.file('pages.xml', xml.end({ prettyPrint: true }));

        const rels = create({ encoding: 'UTF-8', standalone: true })
            .ele('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' })
                .ele('Relationship', { Id: 'rId1', Type: 'http://schemas.microsoft.com/visio/2010/relationships/page', Target: 'page1.xml' }).up()
            .up();
        this.zip.folder('visio')?.folder('pages')?.folder('_rels')?.file('pages.xml.rels', rels.end({ prettyPrint: true }));
    }

    private addPageXml(graph: GraphData) {
        const root = create({ encoding: 'UTF-8', standalone: true })
            .ele('PageContents', { xmlns: 'http://schemas.microsoft.com/office/visio/2012/main' })
            .ele('Shapes');

        let shapeId = 1;
        const nodeIdToShapeId = new Map<string, number>();
        const nodeIdToPin = new Map<string, { pinX: number, pinY: number }>();
        const connects: Array<{ fromSheet: number, fromCell: string, toSheet: number, toCell: string }> = [];

        // Helper for LinePattern
        const getLinePattern = (dash: string | undefined) => {
             if (!dash || dash === 'none' || dash === '0') return null;
             return '2'; 
        };

        // Helper for Fonts
        const getFontStyle = (weight?: string, style?: string) => {
            let s = 0;
            if (weight === 'bold' || weight === '700' || weight === '800') s |= 1; // Bold
            if (style === 'italic') s |= 2; // Italic
            return s;
        };

        // Character.Size is a spatial cell; Visio always reads its value in
        // the document's internal unit (inches), regardless of the U
        // attribute. Emitting "10.5" with U="PT" makes Visio render text at
        // 10.5 inches tall, which is what caused shapes to disappear under
        // giant letters. Convert px -> inches directly (px / 96) and leave U
        // off so Visio uses the sheet-native unit.
        const getFontSize = (sizeStr?: string) => {
            if (!sizeStr) return null;
            const px = parseFloat(sizeStr);
            if (isNaN(px)) return null;
            return (px / this.dpi).toFixed(4);
        };

        const getHorzAlign = (align?: string) => {
            if (align === 'left') return '0';
            if (align === 'right') return '2';
            return '1'; // Center default
        };

        // Evaluate a ShapeSheet expression over known Width/Height so we can
        // emit a concrete V alongside the F formula. Only supports the tokens
        // this generator actually produces (Width, Height, constants, */-).
        const evalDim = (expr: string, width: number, height: number): number => {
            const replaced = expr.replace(/Width/g, String(width)).replace(/Height/g, String(height));
            // Very small parser: strip whitespace, split on + and -, each term
            // is a product. Safe because the inputs are hand-authored above.
            const s = replaced.replace(/\s+/g, '');
            let sign = 1;
            let i = 0;
            let total = 0;
            if (s[0] === '-') { sign = -1; i = 1; }
            else if (s[0] === '+') { i = 1; }
            let termStart = i;
            while (i <= s.length) {
                const c = s[i];
                if (i === s.length || c === '+' || c === '-') {
                    const term = s.slice(termStart, i);
                    const factors = term.split('*').map(Number);
                    const product = factors.reduce((a, b) => a * b, 1);
                    total += sign * product;
                    sign = c === '-' ? -1 : 1;
                    termStart = i + 1;
                }
                i++;
            }
            return total;
        };

        // 1. Add Clusters (Subgraphs) - Draw first (background)
        if (graph.clusters) {
            for (const cluster of graph.clusters) {
                const w = cluster.width / this.dpi;
                const h = cluster.height / this.dpi;
                const x = cluster.x / this.dpi;
                const y = cluster.y / this.dpi;

                const pinX = x + w/2;
                const pinY = this.pageHeight - (y + h/2);

                // Clusters can be edge endpoints too (`CH -->|...| S4` in
                // Mermaid is perfectly legal). Register them in the same
                // id -> pin/shape maps we use for nodes so the glue path
                // fires for cluster-endpoint edges.
                nodeIdToShapeId.set(cluster.id, shapeId);
                nodeIdToPin.set(cluster.id, { pinX, pinY });

                const shape = root.ele('Shape', { ID: shapeId.toString(), Type: 'Group' });
                
                shape.ele('Cell', { N: 'PinX', V: pinX.toString() }).up();
                shape.ele('Cell', { N: 'PinY', V: pinY.toString() }).up();
                shape.ele('Cell', { N: 'Width', V: w.toString() }).up();
                shape.ele('Cell', { N: 'Height', V: h.toString() }).up();

                // Style
                if (cluster.style) {
                    const fill = VsdxGenerator.normalizeColor(cluster.style.fill);
                    if (fill) shape.ele('Cell', { N: 'FillForegnd', V: fill }).up();
                    const stroke = VsdxGenerator.normalizeColor(cluster.style.stroke);
                    if (stroke) shape.ele('Cell', { N: 'LineColor', V: stroke }).up();
                    if (cluster.style.strokeWidth) {
                        const px = parseFloat(cluster.style.strokeWidth) || 1;
                        shape.ele('Cell', { N: 'LineWeight', V: (px * 0.01).toString() }).up();
                    }
                    const lp = getLinePattern(cluster.style.strokeDasharray);
                    if (lp) shape.ele('Cell', { N: 'LinePattern', V: lp }).up();
                }

                // Geometry - Rectangle. Width/Height expressions are formulas
                // referencing the shape's own Width/Height cells, so they must
                // live in F attributes; V would be parsed as a literal value.
                const geom = shape.ele('Section', { N: 'Geometry', IX: '0' });
                geom.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', F: 'Width', V: w.toString() }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '3' }).ele('Cell', { N: 'X', F: 'Width', V: w.toString() }).up().ele('Cell', { N: 'Y', F: 'Height', V: h.toString() }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '4' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', F: 'Height', V: h.toString() }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '5' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.up();

                // TextBlock section - align text to top (VerticalAlign = 0).
                // Visio's Shape schema is ordered: Cells, Sections, then Text.
                // Emitting Text before a Section will cause Visio to reject the
                // document, so all sections must land first.
                if (cluster.text) {
                    const txtXform = shape.ele('Section', { N: 'TextBlock', IX: '0' });
                    txtXform.ele('Row', { IX: '0' })
                        .ele('Cell', { N: 'VerticalAlign', V: '0' }).up() // Top
                    .up().up();
                }

                // Make it a Container
                const user = shape.ele('Section', { N: 'User', IX: '0' });
                user.ele('Row', { N: 'msvStructureType', IX: '0' })
                    .ele('Cell', { N: 'Value', V: '"Container"', U: 'STR' }).up()
                .up().up();

                // Text element goes LAST in the shape so Visio's ordered schema
                // accepts the document.
                if (cluster.text) {
                    shape.ele('Text').txt(cluster.text).up();
                }

                shapeId++;
            }
        }

        // 2. Add Nodes
        for (const node of graph.nodes) {
            // Register ID
            nodeIdToShapeId.set(node.id, shapeId);

            // Convert to inches. node.x/node.y are bounding-box top-left in SVG coords
            // (the parser normalizes both nodes and clusters to top-left). Visio PinX/PinY
            // is the shape center in a bottom-left origin, so flip Y and add half-extents.
            const w = node.width / this.dpi;
            const h = node.height / this.dpi;
            const xTopLeft = node.x / this.dpi;
            const yTopLeft = node.y / this.dpi;
            const pinX = xTopLeft + w / 2;
            const pinY = this.pageHeight - (yTopLeft + h / 2);

            nodeIdToPin.set(node.id, { pinX, pinY });

            const shape = root.ele('Shape', { ID: shapeId.toString(), Type: 'Shape' });

            // Transform
            shape.ele('Cell', { N: 'PinX', V: pinX.toString() }).up();
            shape.ele('Cell', { N: 'PinY', V: pinY.toString() }).up();
            shape.ele('Cell', { N: 'Width', V: w.toString() }).up();
            shape.ele('Cell', { N: 'Height', V: h.toString() }).up();

            // Rounding
            if (node.rounding && node.rounding > 0) {
                // Convert px to inches
                const rIn = node.rounding / this.dpi;
                shape.ele('Cell', { N: 'Rounding', V: rIn.toString() }).up();
            }

            // Styles
            if (node.style) {
                const fill = VsdxGenerator.normalizeColor(node.style.fill);
                if (fill) {
                     shape.ele('Cell', { N: 'FillForegnd', V: fill }).up();
                }
                const stroke = VsdxGenerator.normalizeColor(node.style.stroke);
                if (stroke) {
                     shape.ele('Cell', { N: 'LineColor', V: stroke }).up();
                }
                if (node.style.strokeWidth) {
                     // Approximate: 1px ~= 0.01 inch
                     const px = parseFloat(node.style.strokeWidth) || 1;
                     shape.ele('Cell', { N: 'LineWeight', V: (px * 0.01).toString() }).up();
                }
                const lp = getLinePattern(node.style.strokeDasharray);
                if (lp) shape.ele('Cell', { N: 'LinePattern', V: lp }).up();
            }

            // Paragraph (Alignment)
            if (node.style && node.style.textAlign) {
                shape.ele('Section', { N: 'Paragraph', IX: '0' })
                    .ele('Row', { IX: '0' })
                        .ele('Cell', { N: 'HorzAlign', V: getHorzAlign(node.style.textAlign) }).up()
                    .up().up();
            }

            // Hyperlink
            if (node.url) {
                shape.ele('Section', { N: 'Hyperlink', IX: '0' })
                    .ele('Row', { IX: '0' })
                        .ele('Cell', { N: 'Address', V: node.url }).up()
                    .up().up();
            }

            // Geometry. When an expression references Width/Height it's a
            // formula and must live in the F attribute with the evaluated
            // number in V. Putting "Width*0.5" in V makes Visio treat it as an
            // un-parseable literal and the geometry silently drops out.
            const xf = (fx: string) => ({ F: fx, V: evalDim(fx, w, h).toString() });
            const geom = shape.ele('Section', { N: 'Geometry', IX: '0' });

            if (node.type === 'circle' || node.type === 'ellipse') {
                geom.ele('Row', { T: 'Ellipse', IX: '1' })
                    .ele('Cell', { N: 'X', ...xf('Width*0.5') }).up()
                    .ele('Cell', { N: 'Y', ...xf('Height*0.5') }).up()
                    .ele('Cell', { N: 'A', ...xf('Width') }).up()
                    .ele('Cell', { N: 'B', ...xf('Height*0.5') }).up()
                    .ele('Cell', { N: 'C', ...xf('Width*0.5') }).up()
                    .ele('Cell', { N: 'D', ...xf('Height') }).up().up();
            } else if (node.type === 'diamond') {
                geom.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', ...xf('Width*0.5') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', ...xf('Height*0.5') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '3' }).ele('Cell', { N: 'X', ...xf('Width*0.5') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '4' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height*0.5') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '5' }).ele('Cell', { N: 'X', ...xf('Width*0.5') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
            } else if (node.type === 'stadium') {
                geom.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', ...xf('Height*0.5') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width-Height*0.5') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'ArcTo', IX: '3' }).ele('Cell', { N: 'X', ...xf('Width-Height*0.5') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().ele('Cell', { N: 'A', ...xf('Width') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '4' }).ele('Cell', { N: 'X', ...xf('Height*0.5') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'ArcTo', IX: '5' }).ele('Cell', { N: 'X', ...xf('Height*0.5') }).up().ele('Cell', { N: 'Y', V: '0' }).up().ele('Cell', { N: 'A', V: '0' }).up().up();
            } else if (node.type === 'parallelogram') {
                geom.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', ...xf('Width*0.2') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '3' }).ele('Cell', { N: 'X', ...xf('Width*0.8') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '4' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '5' }).ele('Cell', { N: 'X', ...xf('Width*0.2') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
            } else if (node.type === 'cylinder') {
                geom.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height*0.15') }).up().up();
                geom.ele('Row', { T: 'ArcTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', ...xf('Height*0.15') }).up().ele('Cell', { N: 'A', ...xf('Width*0.2') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '3' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', ...xf('Height*0.85') }).up().up();
                geom.ele('Row', { T: 'ArcTo', IX: '4' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height*0.85') }).up().ele('Cell', { N: 'A', ...xf('-Width*0.2') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '5' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height*0.15') }).up().up();

                const geom2 = shape.ele('Section', { N: 'Geometry', IX: '1' });
                geom2.ele('Cell', { N: 'NoFill', V: '1' }).up();
                geom2.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height*0.85') }).up().up();
                geom2.ele('Row', { T: 'ArcTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', ...xf('Height*0.85') }).up().ele('Cell', { N: 'A', ...xf('Width*0.2') }).up().up();
            } else if (node.type === 'subroutine') {
                geom.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '3' }).ele('Cell', { N: 'X', ...xf('Width') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '4' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '5' }).ele('Cell', { N: 'X', V: '0' }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();

                const subGeom1 = shape.ele('Section', { N: 'Geometry', IX: '1' });
                subGeom1.ele('Cell', { N: 'NoFill', V: '1' }).up();
                subGeom1.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', ...xf('Width*0.1') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                subGeom1.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width*0.1') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();

                const subGeom2 = shape.ele('Section', { N: 'Geometry', IX: '2' });
                subGeom2.ele('Cell', { N: 'NoFill', V: '1' }).up();
                subGeom2.ele('Row', { T: 'MoveTo', IX: '1' }).ele('Cell', { N: 'X', ...xf('Width*0.9') }).up().ele('Cell', { N: 'Y', V: '0' }).up().up();
                subGeom2.ele('Row', { T: 'LineTo', IX: '2' }).ele('Cell', { N: 'X', ...xf('Width*0.9') }).up().ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
            } else {
                // Default: Rectangle
                geom.ele('Row', { T: 'MoveTo', IX: '1' })
                    .ele('Cell', { N: 'X', V: '0' }).up()
                    .ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '2' })
                    .ele('Cell', { N: 'X', ...xf('Width') }).up()
                    .ele('Cell', { N: 'Y', V: '0' }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '3' })
                    .ele('Cell', { N: 'X', ...xf('Width') }).up()
                    .ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '4' })
                    .ele('Cell', { N: 'X', V: '0' }).up()
                    .ele('Cell', { N: 'Y', ...xf('Height') }).up().up();
                geom.ele('Row', { T: 'LineTo', IX: '5' })
                    .ele('Cell', { N: 'X', V: '0' }).up()
                    .ele('Cell', { N: 'Y', V: '0' }).up().up();
            }
            geom.up();

            // Character section. Emitted before <Text> because Visio's Shape
            // schema orders Cells -> Sections -> Text; emitting Text first
            // makes the document invalid.
            if (node.text) {
                const charSec = shape.ele('Section', { N: 'Character', IX: '0' });
                const charRow = charSec.ele('Row', { IX: '0' });

                if (node.style) {
                    const color = VsdxGenerator.normalizeColor(node.style.color);
                    if (color) charRow.ele('Cell', { N: 'Color', V: color }).up();

                    const fs = getFontSize(node.style.fontSize);
                    if (fs) charRow.ele('Cell', { N: 'Size', V: fs }).up();

                    const st = getFontStyle(node.style.fontWeight, node.style.fontStyle);
                    if (st > 0) charRow.ele('Cell', { N: 'Style', V: st.toString() }).up();
                }
                charRow.up().up(); // Row, Section
            }

            // Connection Points. One row per cardinal side; each row needs
            // DirX/DirY so Visio knows which way the connector should approach
            // and Type=0 (inward) so dynamic glue can pick the best face.
            // Row IX starts at 1 (the Connection section's indexing base);
            // IX="0" made Visio ignore the row entirely.
            const conn = shape.ele('Section', { N: 'Connection' });
            const addConn = (ix: number, x: any, y: any, dirX: string, dirY: string) => {
                const row = conn.ele('Row', { IX: ix.toString() });
                row.ele('Cell', { N: 'X', ...x }).up();
                row.ele('Cell', { N: 'Y', ...y }).up();
                row.ele('Cell', { N: 'DirX', V: dirX }).up();
                row.ele('Cell', { N: 'DirY', V: dirY }).up();
                row.ele('Cell', { N: 'Type', V: '0' }).up();
                row.up();
            };
            addConn(1, xf('Width*0.5'), { V: '0' },          '0',  '-1'); // bottom
            addConn(2, xf('Width*0.5'), xf('Height'),        '0',  '1');  // top
            addConn(3, { V: '0' },      xf('Height*0.5'),    '-1', '0');  // left
            addConn(4, xf('Width'),     xf('Height*0.5'),    '1',  '0');  // right
            conn.up();

            // Text goes last (after all Sections).
            if (node.text) {
                shape.ele('Text').txt(node.text).up();
            }

            shapeId++;
        }

        // 3. Add Connectors (Edges)
        if (graph.edges) {
            for (const edge of graph.edges) {
                if (!edge.d) continue;

                const startPin = edge.startId ? nodeIdToPin.get(edge.startId) : undefined;
                const endPin = edge.endId ? nodeIdToPin.get(edge.endId) : undefined;
                const startShapeId = edge.startId ? nodeIdToShapeId.get(edge.startId) : undefined;
                const endShapeId = edge.endId ? nodeIdToShapeId.get(edge.endId) : undefined;
                const glued = !!(startPin && endPin && startShapeId && endShapeId);

                const shape = root.ele('Shape', { ID: shapeId.toString(), Type: 'Shape' });

                if (glued) {
                    // Visio 1D shape transform: world(x, y) = PinX + (x - LocPinX),
                    // PinY + (y - LocPinY). We want world Begin = (beginX, beginY)
                    // at local (0, 0) and world End = (endX, endY) at local
                    // (Width, Height). Setting LocPin = (Width/2, Height/2) puts
                    // PinX at the midpoint (good for rotation) while keeping the
                    // begin/end points geometrically correct.
                    const beginX = startPin!.pinX;
                    const beginY = startPin!.pinY;
                    const endX = endPin!.pinX;
                    const endY = endPin!.pinY;
                    const pinX = (beginX + endX) / 2;
                    const pinY = (beginY + endY) / 2;
                    const width = endX - beginX;
                    const height = endY - beginY;
                    const locPinX = width / 2;
                    const locPinY = height / 2;

                    shape.ele('Cell', { N: 'PinX', V: pinX.toString() }).up();
                    shape.ele('Cell', { N: 'PinY', V: pinY.toString() }).up();
                    shape.ele('Cell', { N: 'Width', V: width.toString() }).up();
                    shape.ele('Cell', { N: 'Height', V: height.toString() }).up();
                    shape.ele('Cell', { N: 'LocPinX', V: locPinX.toString() }).up();
                    shape.ele('Cell', { N: 'LocPinY', V: locPinY.toString() }).up();
                    shape.ele('Cell', { N: 'BeginX', V: beginX.toString() }).up();
                    shape.ele('Cell', { N: 'BeginY', V: beginY.toString() }).up();
                    shape.ele('Cell', { N: 'EndX', V: endX.toString() }).up();
                    shape.ele('Cell', { N: 'EndY', V: endY.toString() }).up();
                } else {
                    // Fallback: place shape at page origin and draw the raw SVG path in
                    // absolute coordinates. No glue, but the line is still rendered.
                    shape.ele('Cell', { N: 'PinX', V: '0' }).up();
                    shape.ele('Cell', { N: 'PinY', V: '0' }).up();
                    shape.ele('Cell', { N: 'Width', V: this.pageWidth.toString() }).up();
                    shape.ele('Cell', { N: 'Height', V: this.pageHeight.toString() }).up();
                    shape.ele('Cell', { N: 'LocPinX', V: '0' }).up();
                    shape.ele('Cell', { N: 'LocPinY', V: '0' }).up();
                }

                shape.ele('Cell', { N: 'FillPattern', V: '0' }).up();
                shape.ele('Cell', { N: 'EndArrow', V: '13' }).up();
                // ObjType=2 marks the shape as a connector so Visio routes it dynamically.
                shape.ele('Cell', { N: 'ObjType', V: '2' }).up();

                const edgeStroke = VsdxGenerator.normalizeColor(edge.style?.stroke) || '#000000';
                shape.ele('Cell', { N: 'LineColor', V: edgeStroke }).up();
                if (edge.style?.strokeWidth) {
                    const px = parseFloat(edge.style.strokeWidth) || 1;
                    shape.ele('Cell', { N: 'LineWeight', V: (px / this.dpi).toString() }).up();
                } else {
                    shape.ele('Cell', { N: 'LineWeight', V: (1 / this.dpi).toString() }).up();
                }
                const edgeLp = getLinePattern(edge.style?.strokeDasharray);
                if (edgeLp) shape.ele('Cell', { N: 'LinePattern', V: edgeLp }).up();

                if (glued) {
                    // Standard 1D line geometry spanning Begin -> End in local coords.
                    // Width/Height are formulas; V carries the evaluated edge extent.
                    const edgeWidth = endPin!.pinX - startPin!.pinX;
                    const edgeHeight = endPin!.pinY - startPin!.pinY;
                    const geom = shape.ele('Section', { N: 'Geometry', IX: '0' });
                    geom.ele('Cell', { N: 'NoFill', V: '1' }).up();
                    geom.ele('Cell', { N: 'NoLine', V: '0' }).up();
                    geom.ele('Cell', { N: 'NoShow', V: '0' }).up();
                    geom.ele('Row', { T: 'MoveTo', IX: '1' })
                        .ele('Cell', { N: 'X', V: '0' }).up()
                        .ele('Cell', { N: 'Y', V: '0' }).up().up();
                    geom.ele('Row', { T: 'LineTo', IX: '2' })
                        .ele('Cell', { N: 'X', F: 'Width', V: edgeWidth.toString() }).up()
                        .ele('Cell', { N: 'Y', F: 'Height', V: edgeHeight.toString() }).up().up();
                    geom.up();

                    connects.push({ fromSheet: shapeId, fromCell: 'BeginX', toSheet: startShapeId!, toCell: 'PinX' });
                    connects.push({ fromSheet: shapeId, fromCell: 'EndX', toSheet: endShapeId!, toCell: 'PinX' });
                } else {
                    const geom = shape.ele('Section', { N: 'Geometry', IX: '0' });
                    geom.ele('Cell', { N: 'NoFill', V: '1' }).up();
                    this.parsePathToVisio(edge.d, geom);
                    geom.up();
                }

                // Routing Style (1 = Right Angle)
                shape.ele('Section', { N: 'ShapeLayout', IX: '0' })
                    .ele('Row', { IX: '0' })
                        .ele('Cell', { N: 'ConLineRouteExt', V: '1' }).up()
                    .up().up();

                shapeId++;
            }
        }

        // 4. Add Edge Labels
        if (graph.labels) {
            for (const label of graph.labels) {
                const w = (label.width || 10) / this.dpi;
                const h = (label.height || 10) / this.dpi;
                // Labels from Mermaid (transform translate) are usually Center or Top-Left
                // Experimentation suggests they are often top-left of the text box.
                const x = label.x / this.dpi;
                const y = this.pageHeight - (label.y / this.dpi);
                
                // Center pin
                const pinX = x + w/2;
                const pinY = y - h/2; // If y is top-left, center is down

                const shape = root.ele('Shape', { ID: shapeId.toString(), Type: 'Shape' });
                
                shape.ele('Cell', { N: 'PinX', V: pinX.toString() }).up();
                shape.ele('Cell', { N: 'PinY', V: pinY.toString() }).up();
                shape.ele('Cell', { N: 'Width', V: w.toString() }).up();
                shape.ele('Cell', { N: 'Height', V: h.toString() }).up();

                // Invisible line; FillPattern depends on whether a background is requested.
                shape.ele('Cell', { N: 'LinePattern', V: '0' }).up();
                const labelFill = VsdxGenerator.normalizeColor(label.style?.fill);
                const hasBackground = !!labelFill;
                shape.ele('Cell', { N: 'FillPattern', V: hasBackground ? '1' : '0' }).up();
                if (hasBackground) {
                    shape.ele('Cell', { N: 'FillForegnd', V: labelFill! }).up();
                }

                // Character section first, then Text (Visio enforces
                // Cells -> Sections -> Text order).
                const charSec = shape.ele('Section', { N: 'Character', IX: '0' });
                const charRow = charSec.ele('Row', { IX: '0' });

                 if (label.style) {
                    const lblColor = VsdxGenerator.normalizeColor(label.style.color);
                    if (lblColor) charRow.ele('Cell', { N: 'Color', V: lblColor }).up();

                    const fs = getFontSize(label.style.fontSize);
                    if (fs) charRow.ele('Cell', { N: 'Size', V: fs }).up();

                    const st = getFontStyle(label.style.fontWeight, label.style.fontStyle);
                    if (st > 0) charRow.ele('Cell', { N: 'Style', V: st.toString() }).up();
                }
                charRow.up().up();

                shape.ele('Text').txt(label.text).up();

                shapeId++;
            }
        }
        
        root.up(); // Exit Shapes (Wait, I need to check xmlbuilder2 nesting. I think I need to go up from Shapes before Connects? NO. Connects is sibling of Shapes in PageContents)
        // Shapes was created with root.ele('Shapes').
        // So root is PageContents.
        // We are inside Shapes right now? No, loop finished.
        // root points to PageContents -> Shapes.
        root.up(); // Now root points to PageContents.

        // 5. Add Connections
        if (connects.length > 0) {
            const connXml = root.ele('Connects');
            for (const c of connects) {
                connXml.ele('Connect', { FromSheet: c.fromSheet.toString(), FromCell: c.fromCell, ToSheet: c.toSheet.toString(), ToCell: c.toCell }).up();
            }
            connXml.up();
        }

        // root is still PageContents
        this.zip.folder('visio')?.folder('pages')?.file('page1.xml', root.end({ prettyPrint: true }));
    }

    // Exported for unit testing.
    public parsePathToVisio(d: string, geomXml: any) {
        const commands = this.tokenizeSvgPath(d);

        let currentX = 0;
        let currentY = 0;
        let startX = 0;
        let startY = 0;
        let rowIx = 1;

        const toVisioY = (y: number) => this.pageHeight - (y / this.dpi);
        const toVisioX = (x: number) => x / this.dpi;

        const moveTo = (x: number, y: number) => {
            geomXml.ele('Row', { T: 'MoveTo', IX: rowIx.toString() })
                .ele('Cell', { N: 'X', V: toVisioX(x).toString() }).up()
                .ele('Cell', { N: 'Y', V: toVisioY(y).toString() }).up().up();
            rowIx++;
        };
        const lineTo = (x: number, y: number) => {
            geomXml.ele('Row', { T: 'LineTo', IX: rowIx.toString() })
                .ele('Cell', { N: 'X', V: toVisioX(x).toString() }).up()
                .ele('Cell', { N: 'Y', V: toVisioY(y).toString() }).up().up();
            rowIx++;
        };
        const flattenCubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
            const steps = 10;
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const mt = 1 - t;
                const bx = mt*mt*mt*currentX + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t*t*t*x;
                const by = mt*mt*mt*currentY + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t*t*t*y;
                lineTo(bx, by);
            }
        };
        const flattenQuadratic = (x1: number, y1: number, x: number, y: number) => {
            const steps = 10;
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const mt = 1 - t;
                const bx = mt*mt*currentX + 2*mt*t*x1 + t*t*x;
                const by = mt*mt*currentY + 2*mt*t*y1 + t*t*y;
                lineTo(bx, by);
            }
        };

        let prevControlX: number | null = null;
        let prevControlY: number | null = null;
        let prevCmd = '';

        for (const { cmd, args } of commands) {
            const relative = cmd >= 'a' && cmd <= 'z';
            const upper = cmd.toUpperCase();

            if (upper === 'M') {
                for (let i = 0; i < args.length; i += 2) {
                    const x = relative ? currentX + args[i] : args[i];
                    const y = relative ? currentY + args[i + 1] : args[i + 1];
                    if (i === 0) {
                        moveTo(x, y);
                        startX = x;
                        startY = y;
                    } else {
                        // Subsequent pairs after M are implicit L.
                        lineTo(x, y);
                    }
                    currentX = x;
                    currentY = y;
                }
                prevControlX = prevControlY = null;
            } else if (upper === 'L') {
                for (let i = 0; i < args.length; i += 2) {
                    const x = relative ? currentX + args[i] : args[i];
                    const y = relative ? currentY + args[i + 1] : args[i + 1];
                    lineTo(x, y);
                    currentX = x;
                    currentY = y;
                }
                prevControlX = prevControlY = null;
            } else if (upper === 'H') {
                for (let i = 0; i < args.length; i++) {
                    const x = relative ? currentX + args[i] : args[i];
                    lineTo(x, currentY);
                    currentX = x;
                }
                prevControlX = prevControlY = null;
            } else if (upper === 'V') {
                for (let i = 0; i < args.length; i++) {
                    const y = relative ? currentY + args[i] : args[i];
                    lineTo(currentX, y);
                    currentY = y;
                }
                prevControlX = prevControlY = null;
            } else if (upper === 'C') {
                for (let i = 0; i < args.length; i += 6) {
                    const x1 = relative ? currentX + args[i] : args[i];
                    const y1 = relative ? currentY + args[i + 1] : args[i + 1];
                    const x2 = relative ? currentX + args[i + 2] : args[i + 2];
                    const y2 = relative ? currentY + args[i + 3] : args[i + 3];
                    const x  = relative ? currentX + args[i + 4] : args[i + 4];
                    const y  = relative ? currentY + args[i + 5] : args[i + 5];
                    flattenCubic(x1, y1, x2, y2, x, y);
                    prevControlX = x2;
                    prevControlY = y2;
                    currentX = x;
                    currentY = y;
                }
            } else if (upper === 'S') {
                for (let i = 0; i < args.length; i += 4) {
                    // Smooth cubic: first control is reflection of prev cubic's second control.
                    const reflect = (prevCmd.toUpperCase() === 'C' || prevCmd.toUpperCase() === 'S')
                        && prevControlX !== null && prevControlY !== null;
                    const x1 = reflect ? 2 * currentX - (prevControlX as number) : currentX;
                    const y1 = reflect ? 2 * currentY - (prevControlY as number) : currentY;
                    const x2 = relative ? currentX + args[i] : args[i];
                    const y2 = relative ? currentY + args[i + 1] : args[i + 1];
                    const x  = relative ? currentX + args[i + 2] : args[i + 2];
                    const y  = relative ? currentY + args[i + 3] : args[i + 3];
                    flattenCubic(x1, y1, x2, y2, x, y);
                    prevControlX = x2;
                    prevControlY = y2;
                    currentX = x;
                    currentY = y;
                }
            } else if (upper === 'Q') {
                for (let i = 0; i < args.length; i += 4) {
                    const x1 = relative ? currentX + args[i] : args[i];
                    const y1 = relative ? currentY + args[i + 1] : args[i + 1];
                    const x  = relative ? currentX + args[i + 2] : args[i + 2];
                    const y  = relative ? currentY + args[i + 3] : args[i + 3];
                    flattenQuadratic(x1, y1, x, y);
                    prevControlX = x1;
                    prevControlY = y1;
                    currentX = x;
                    currentY = y;
                }
            } else if (upper === 'T') {
                for (let i = 0; i < args.length; i += 2) {
                    const reflect = (prevCmd.toUpperCase() === 'Q' || prevCmd.toUpperCase() === 'T')
                        && prevControlX !== null && prevControlY !== null;
                    const x1 = reflect ? 2 * currentX - (prevControlX as number) : currentX;
                    const y1 = reflect ? 2 * currentY - (prevControlY as number) : currentY;
                    const x  = relative ? currentX + args[i] : args[i];
                    const y  = relative ? currentY + args[i + 1] : args[i + 1];
                    flattenQuadratic(x1, y1, x, y);
                    prevControlX = x1;
                    prevControlY = y1;
                    currentX = x;
                    currentY = y;
                }
            } else if (upper === 'Z') {
                lineTo(startX, startY);
                currentX = startX;
                currentY = startY;
                prevControlX = prevControlY = null;
            } else if (upper === 'A') {
                // Elliptical arc: fall back to a straight line to the endpoint so the
                // connector stays continuous rather than silently dropping segments.
                for (let i = 0; i < args.length; i += 7) {
                    const x = relative ? currentX + args[i + 5] : args[i + 5];
                    const y = relative ? currentY + args[i + 6] : args[i + 6];
                    lineTo(x, y);
                    currentX = x;
                    currentY = y;
                }
                prevControlX = prevControlY = null;
            }
            prevCmd = cmd;
        }
    }

    private tokenizeSvgPath(d: string): Array<{ cmd: string, args: number[] }> {
        const out: Array<{ cmd: string, args: number[] }> = [];
        const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(d)) !== null) {
            const cmd = m[1];
            const rest = m[2].trim();
            const nums: number[] = [];
            if (rest.length > 0) {
                const numRe = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
                let nm: RegExpExecArray | null;
                while ((nm = numRe.exec(rest)) !== null) {
                    nums.push(parseFloat(nm[0]));
                }
            }
            out.push({ cmd, args: nums });
        }
        return out;
    }
}
