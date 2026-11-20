// GraphData -> VSDX package. Browser-safe (JSZip only).
//
// The XML here follows what Visio itself writes (checked against files saved
// by Visio) rather than the minimum the schema allows:
//  - every 2-D shape has LocPinX/LocPinY formulas, so PinX/PinY is its centre;
//  - connectors are 1-D shapes whose geometry is Mermaid's own route, glued
//    with the dynamic-glue formulas Visio uses, so they open looking like the
//    Mermaid diagram and re-route when a shape is moved;
//  - fill, line and text properties are written explicitly on every shape
//    instead of relying on style-sheet inheritance.

import JSZip from 'jszip';
import type { GraphCluster, GraphData, GraphEdge, GraphLabel, GraphNode } from './core/types.js';
import { parseColor } from './core/color.js';
import { flattenPath, polylineMidpoint, simplifyPolyline, type Point } from './core/svgPath.js';

const NS = 'http://schemas.microsoft.com/office/visio/2012/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const VREL = 'http://schemas.microsoft.com/visio/2010/relationships/';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const DPI = 96;
const MARGIN = 0.5; // inches of whitespace around the diagram on every side

// ------------------------------------------------------------------ XML

const esc = (s: unknown): string =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Numbers are written with at most six decimals. A non-finite value means a
// coordinate was computed from something missing; Visio would silently drop
// the cell, so fail loudly instead.
function num(v: number): string {
    if (!Number.isFinite(v)) throw new Error(`VSDX generator produced a non-finite value (${v})`);
    const r = Math.round(v * 1e6) / 1e6;
    return String(r === 0 ? 0 : r);
}

function cell(name: string, value: number | string, formula?: string, unit?: string): string {
    const v = typeof value === 'number' ? num(value) : esc(value);
    return `<Cell N="${name}" V="${v}"${formula ? ` F="${esc(formula)}"` : ''}${unit ? ` U="${unit}"` : ''}/>`;
}

// A geometry coordinate: its value now, and the formula that keeps it right
// when the shape is resized.
interface Coord { v: number; f?: string }

function row(type: string, ix: number, cells: Record<string, Coord>): string {
    return `<Row T="${type}" IX="${ix}">` +
        Object.entries(cells).map(([n, c]) => cell(n, c.v, c.f)).join('') + `</Row>`;
}

function geometry(ix: number, rows: Array<[string, Record<string, Coord>]>, options: { noFill?: boolean; noLine?: boolean } = {}): string {
    return `<Section N="Geometry" IX="${ix}">` +
        cell('NoFill', options.noFill ? 1 : 0) + cell('NoLine', options.noLine ? 1 : 0) +
        rows.map(([type, cells], i) => row(type, i + 1, cells)).join('') + `</Section>`;
}

// ---------------------------------------------------------------- style

// Visio line patterns: 1 solid, 2 dashed, 3 dotted.
const LINE_SOLID = 1;
const LINE_DASHED = 2;
const LINE_DOTTED = 3;

function linePattern(pattern: GraphEdge['pattern'] | undefined, dasharray: string | undefined): number {
    if (pattern === 'dotted') return LINE_DOTTED;
    if (pattern === 'dashed') return LINE_DASHED;
    if (pattern === 'solid') return LINE_SOLID;
    if (!dasharray || dasharray === 'none') return LINE_SOLID;
    const first = parseFloat(dasharray);
    // "0", "0px", "0 0" all mean solid.
    if (!Number.isFinite(first) || first === 0) return LINE_SOLID;
    return first <= 2 ? LINE_DOTTED : LINE_DASHED;
}

// Mermaid edge-end names -> Visio line-end codes.
const LINE_END: Record<string, number> = {
    none: 0,
    arrow_point: 13, arrow_barb: 13, point: 13,
    // Mermaid's "arrow_open" is an open link: no head at all.
    arrow_open: 0,
    open_head: 3, dependency: 3, requirement_arrow: 3,
    arrow_circle: 10, circle: 10,
    lollipop: 20,
    extension: 16,
    aggregation: 22,
    composition: 11,
    only_one: 25,
    zero_or_one: 30,
    one_or_more: 28,
    zero_or_more: 29,
    // No Visio line end resembles a cross; leave the end plain.
    arrow_cross: 0, cross: 0,
};
const DEFAULT_ARROW = 13;

function lineEnd(kind: string | undefined, present: boolean | undefined, fallback: boolean): number {
    if (kind !== undefined) return LINE_END[kind] ?? (kind && kind !== 'none' ? DEFAULT_ARROW : 0);
    return (present ?? fallback) ? DEFAULT_ARROW : 0;
}

const px = (value: string | undefined, fallback: number): number => {
    const n = parseFloat(value ?? '');
    return Number.isFinite(n) ? n : fallback;
};

function isBold(weight: string | undefined): boolean {
    if (!weight) return false;
    if (weight === 'bold' || weight === 'bolder') return true;
    const n = parseInt(weight, 10);
    return Number.isFinite(n) && n >= 600;
}

// Fonts Visio can be told about by name. The first family in a CSS font
// stack that appears here is used; generic families map to nothing.
const KNOWN_FONTS = [
    'Calibri', 'Arial', 'Segoe UI', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma',
    'Georgia', 'Trebuchet MS', 'Consolas', 'Cambria', 'Helvetica',
];
const CALIBRI_FACE = `<FaceName NameU="Calibri" UnicodeRanges="-469750017 -1073732485 9 0" CharSets="536871423 0" Panose="2 15 5 2 2 2 4 3 2 4" Flags="325"/>`;

export function resolveFont(stack: string | undefined): string | undefined {
    for (const raw of (stack ?? '').split(',')) {
        const name = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
        const hit = KNOWN_FONTS.find(f => f.toLowerCase() === name);
        if (hit) return hit === 'Helvetica' ? 'Arial' : hit;
    }
    return undefined;
}

interface TextStyle {
    color?: string;
    fontSize?: string;
    fontWeight?: string;
    fontStyle?: string;
    fontFamily?: string;
}

export interface VsdxOptions {
    // Write each text's font family (and the document's font table). Off by
    // default until the font table has been confirmed against desktop Visio.
    fonts?: boolean;
}

// The "No Style" style sheet with the defaults Visio writes itself.
const NO_STYLE_SHEET = `<StyleSheets><StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">` +
    ([['EnableLineProps', 1], ['EnableFillProps', 1], ['EnableTextProps', 1], ['HideForApply', 0],
      ['LineWeight', 0.010417], ['LineColor', 0], ['LinePattern', 1], ['Rounding', 0],
      ['EndArrowSize', 2], ['BeginArrow', 0], ['EndArrow', 0], ['LineCap', 0], ['BeginArrowSize', 2],
      ['LineColorTrans', 0], ['CompoundType', 0], ['FillForegnd', 1], ['FillBkgnd', 0], ['FillPattern', 1],
      ['ShdwForegnd', 0], ['ShdwPattern', 0], ['FillForegndTrans', 0], ['FillBkgndTrans', 0],
      ['LeftMargin', 0], ['RightMargin', 0], ['TopMargin', 0], ['BottomMargin', 0], ['VerticalAlign', 1],
      ['TextBkgnd', 0], ['DefaultTabStop', 0.5], ['TextDirection', 0], ['TextBkgndTrans', 0],
    ] as Array<[string, number]>).map(([n, v]) => cell(n, v)).join('') +
    `<Section N="Character"><Row IX="0">${cell('Font', 'Calibri')}${cell('Color', 0)}${cell('Style', 0)}${cell('Case', 0)}${cell('Pos', 0)}${cell('FontScale', 1)}${cell('Size', 0.166667)}</Row></Section>` +
    `<Section N="Paragraph"><Row IX="0">${cell('IndFirst', 0)}${cell('IndLeft', 0)}${cell('IndRight', 0)}${cell('SpLine', -1.2)}${cell('SpBefore', 0)}${cell('SpAfter', 0)}${cell('HorzAlign', 1)}${cell('Bullet', 0)}</Row></Section>` +
    `</StyleSheet></StyleSheets>`;

function relationships(items: Array<[id: string, type: string, target: string]>): string {
    return XML_DECL + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('') +
        `</Relationships>`;
}

// ------------------------------------------------------------ generator

export class VsdxGenerator {
    private pageHeight = 11; // inches
    private pageWidth = 8.5; // inches
    private readonly options: VsdxOptions;
    private readonly fontsUsed = new Set<string>();
    private nextChildId = 0;

    constructor(options: VsdxOptions = {}) {
        this.options = options;
    }

    // SVG-space X (pixels, left origin) -> page X (inches, left origin + margin).
    private toVisioX(svgPx: number): number {
        return MARGIN + svgPx / DPI;
    }

    // SVG-space Y (pixels, top origin, y down) -> page Y (inches, bottom origin, y up).
    private toVisioY(svgPx: number): number {
        return this.pageHeight - MARGIN - svgPx / DPI;
    }

    // Any CSS colour -> the #rrggbb Visio needs, or undefined when there is
    // nothing to paint. Public for tests; treat as internal.
    public static normalizeColor(c: string | undefined | null): string | undefined {
        return parseColor(c)?.hex;
    }

    public async generate(graph: GraphData, mermaidSource?: string): Promise<Uint8Array> {
        // The page must hold the content plus a margin on all four sides.
        this.pageWidth = Math.max(8.5, graph.width / DPI + 2 * MARGIN);
        this.pageHeight = Math.max(11, graph.height / DPI + 2 * MARGIN);
        this.fontsUsed.clear();

        const zip = new JSZip();
        // Built first: it records which fonts the document needs.
        const pageXml = this.pageXml(graph);

        zip.file('[Content_Types].xml', XML_DECL +
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            // The round-trip source is a package part too, and OPC requires
            // every part to have a content type.
            `<Default Extension="mmd" ContentType="text/plain"/>` +
            `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
            `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
            `<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>` +
            `<Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>` +
            `<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>` +
            `<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>` +
            `</Types>`);

        zip.file('_rels/.rels', relationships([
            ['rId1', VREL + 'document', 'visio/document.xml'],
            ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'docProps/app.xml'],
            ['rId3', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
        ]));

        zip.file('docProps/app.xml', XML_DECL +
            `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
            `<Application>Microsoft Visio</Application><ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate>` +
            `<SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>`);
        // A fixed timestamp keeps generated files byte-identical run to run.
        zip.file('docProps/core.xml', XML_DECL +
            `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
            `<dc:creator>mermaid2visio</dc:creator><cp:lastModifiedBy>mermaid2visio</cp:lastModifiedBy>` +
            `<dcterms:created xsi:type="dcterms:W3CDTF">1970-01-01T00:00:00Z</dcterms:created>` +
            `<dcterms:modified xsi:type="dcterms:W3CDTF">1970-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`);

        zip.file('visio/document.xml', this.documentXml());
        zip.file('visio/_rels/document.xml.rels', relationships([
            ['rId1', VREL + 'pages', 'pages/pages.xml'],
            ['rId2', VREL + 'windows', 'windows.xml'],
        ]));
        zip.file('visio/windows.xml', this.windowsXml());
        zip.file('visio/pages/pages.xml', this.pagesXml());
        zip.file('visio/pages/_rels/pages.xml.rels', relationships([['rId1', VREL + 'page', 'page1.xml']]));
        zip.file('visio/pages/page1.xml', pageXml);

        // Keep the original Mermaid source inside the package so the diagram
        // can be regenerated without reverse-engineering its geometry.
        if (mermaidSource) zip.file('mermaid/source.mmd', mermaidSource);

        // 'uint8array' keeps this browser-safe; in Node a Buffer is one too.
        return zip.generateAsync({ type: 'uint8array' });
    }

    // ------------------------------------------------------ package parts

    private documentXml(): string {
        // FaceNames must not be present-but-empty, so it is only written
        // when fonts are in use. Calibri carries Visio's own metadata.
        let faces = '';
        if (this.options.fonts) {
            faces = `<FaceNames>${CALIBRI_FACE}` +
                [...this.fontsUsed].filter(f => f !== 'Calibri').sort().map(f => `<FaceName NameU="${esc(f)}"/>`).join('') +
                `</FaceNames>`;
        }
        return XML_DECL +
            `<VisioDocument xmlns="${NS}" xmlns:r="${RNS}">` +
            `<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0"><DynamicGridEnabled>1</DynamicGridEnabled></DocumentSettings>` +
            `<Colors><ColorEntry IX="0" RGB="#000000"/><ColorEntry IX="1" RGB="#FFFFFF"/></Colors>` +
            faces + NO_STYLE_SHEET +
            `</VisioDocument>`;
    }

    private windowsXml(): string {
        return XML_DECL +
            `<Windows xmlns="${NS}" ClientWidth="1024" ClientHeight="768">` +
            `<Window ID="0" WindowType="Drawing" WindowState="1073741824" WindowLeft="0" WindowTop="0" WindowWidth="1024" WindowHeight="768" ContainerType="Page" Page="0" ViewScale="-1" ViewCenterX="${num(this.pageWidth / 2)}" ViewCenterY="${num(this.pageHeight / 2)}">` +
            `<ShowRulers>1</ShowRulers><ShowGrid>1</ShowGrid><ShowPageBreaks>0</ShowPageBreaks><ShowGuides>1</ShowGuides>` +
            `<ShowConnectionPoints>1</ShowConnectionPoints><GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings>` +
            `<SnapExtensions>34</SnapExtensions><SnapAngles/><DynamicGridEnabled>1</DynamicGridEnabled><TabSplitterPos>0.5</TabSplitterPos>` +
            `</Window></Windows>`;
    }

    private pagesXml(): string {
        return XML_DECL +
            `<Pages xmlns="${NS}" xmlns:r="${RNS}">` +
            `<Page ID="0" NameU="Page-1" Name="Page-1" ViewScale="1" ViewCenterX="${num(this.pageWidth / 2)}" ViewCenterY="${num(this.pageHeight / 2)}">` +
            `<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">` +
            cell('PageWidth', this.pageWidth) + cell('PageHeight', this.pageHeight) +
            cell('ShdwOffsetX', 0.125) + cell('ShdwOffsetY', -0.125) +
            cell('PageScale', 1, undefined, 'IN_F') + cell('DrawingScale', 1, undefined, 'IN_F') +
            cell('DrawingSizeType', 0) + cell('DrawingScaleType', 0) + cell('InhibitSnap', 0) +
            `</PageSheet><Rel r:id="rId1"/></Page></Pages>`;
    }

    // ---------------------------------------------------------- the page

    private pageXml(graph: GraphData): string {
        const clusters = this.orderClusters(graph.clusters ?? []);
        const parents = this.resolveParents(graph.nodes, clusters);

        // Shape ids, in drawing order: subgraphs (outermost first), nodes,
        // connectors, then free-standing labels.
        let nextId = 1;
        const shapeIdOf = new Map<string, number>();
        for (const c of clusters) shapeIdOf.set(c.id, nextId++);
        for (const n of graph.nodes) shapeIdOf.set(n.id, nextId++);

        // Every subgraph, direct or not, that contains each shape — and the
        // reverse. Visio records container membership in both directions.
        const ancestorsOf = (id: string): string[] => {
            const out: string[] = [];
            const seen = new Set<string>([id]);
            for (let p = parents.get(id); p && !seen.has(p); p = parents.get(p)) { out.push(p); seen.add(p); }
            return out;
        };
        const membersOf = new Map<string, number[]>();
        for (const id of [...clusters.map(c => c.id), ...graph.nodes.map(n => n.id)]) {
            for (const ancestor of ancestorsOf(id)) {
                if (!membersOf.has(ancestor)) membersOf.set(ancestor, []);
                membersOf.get(ancestor)!.push(shapeIdOf.get(id)!);
            }
        }
        const containerCell = (id: string): string => {
            const containers = ancestorsOf(id).map(a => shapeIdOf.get(a)!).filter(Boolean);
            const members = membersOf.get(id) ?? [];
            const terms = [
                ...(members.length ? [`DEPENDSON(1,${members.map(m => `Sheet.${m}!SheetRef()`).join(',')})`] : []),
                ...(containers.length ? [`DEPENDSON(4,${containers.map(c => `Sheet.${c}!SheetRef()`).join(',')})`] : []),
            ];
            return terms.length ? cell('Relationships', 0, `SUM(${terms.join(',')})`) : '';
        };

        // Text boxes inside group nodes need ids too; they follow all the
        // top-level shapes.
        this.nextChildId = nextId + (graph.edges?.length ?? 0) + (graph.labels?.length ?? 0);

        const shapes: string[] = [];
        for (const c of clusters) shapes.push(this.clusterShape(shapeIdOf.get(c.id)!, c, containerCell(c.id)));
        for (const n of graph.nodes) shapes.push(this.nodeShape(shapeIdOf.get(n.id)!, n, containerCell(n.id)));

        const connects: string[] = [];
        for (const edge of graph.edges ?? []) {
            const xml = this.edgeShape(nextId, edge, shapeIdOf, connects);
            if (!xml) continue;
            shapes.push(xml);
            nextId++;
        }
        for (const label of graph.labels ?? []) shapes.push(this.labelShape(nextId++, label));

        return XML_DECL +
            `<PageContents xmlns="${NS}" xmlns:r="${RNS}">\n<Shapes>\n${shapes.join('\n')}\n</Shapes>\n` +
            (connects.length ? `<Connects>\n${connects.join('\n')}\n</Connects>\n` : '') +
            `</PageContents>`;
    }

    // Outer subgraphs must be drawn before the ones inside them.
    private orderClusters(clusters: GraphCluster[]): GraphCluster[] {
        const byId = new Map(clusters.map(c => [c.id, c]));
        const depth = (c: GraphCluster): number => {
            let d = 0;
            const seen = new Set<string>([c.id]);
            for (let p = c.parentId; p && byId.has(p) && !seen.has(p); p = byId.get(p)!.parentId) { d++; seen.add(p); }
            return d;
        };
        return clusters
            .map((c, i) => ({ c, i, d: depth(c), area: c.width * c.height }))
            .sort((a, b) => a.d - b.d || b.area - a.area || a.i - b.i)
            .map(x => x.c);
    }

    // Which subgraph directly contains each node and subgraph. Uses the
    // extractor's parentId where given; otherwise the smallest subgraph
    // whose frame contains the shape's centre.
    private resolveParents(nodes: GraphNode[], clusters: GraphCluster[]): Map<string, string> {
        const ids = new Set(clusters.map(c => c.id));
        const parents = new Map<string, string>();
        const enclosing = (item: { id: string; x: number; y: number; width: number; height: number }): string | undefined => {
            const cx = item.x + item.width / 2, cy = item.y + item.height / 2;
            let best: GraphCluster | undefined;
            for (const c of clusters) {
                if (c.id === item.id) continue;
                if (cx < c.x || cx > c.x + c.width || cy < c.y || cy > c.y + c.height) continue;
                // A subgraph can't sit inside one that is not larger than it.
                if (ids.has(item.id) && c.width * c.height <= item.width * item.height) continue;
                if (!best || c.width * c.height < best.width * best.height) best = c;
            }
            return best?.id;
        };
        for (const item of [...clusters, ...nodes]) {
            const parent = item.parentId && ids.has(item.parentId) ? item.parentId : enclosing(item);
            if (parent && parent !== item.id) parents.set(item.id, parent);
        }
        return parents;
    }

    // ------------------------------------------------------------ shapes

    private transform(x: number, y: number, width: number, height: number): { w: number; h: number; xml: string } {
        const w = Math.max(width, 0.01) / DPI;
        const h = Math.max(height, 0.01) / DPI;
        return {
            w, h,
            xml: cell('PinX', this.toVisioX(x + width / 2)) + cell('PinY', this.toVisioY(y + height / 2)) +
                cell('Width', w) + cell('Height', h) +
                cell('LocPinX', w / 2, 'Width*0.5') + cell('LocPinY', h / 2, 'Height*0.5'),
        };
    }

    private fillCells(fill: string | undefined): string {
        const paint = parseColor(fill);
        if (!paint) return cell('FillPattern', 0);
        return cell('FillForegnd', paint.hex) + cell('FillPattern', 1) +
            (paint.alpha < 1 ? cell('FillForegndTrans', 1 - paint.alpha) : '');
    }

    private lineCells(style: { stroke?: string; strokeWidth?: string; strokeDasharray?: string } | undefined,
                      pattern?: GraphEdge['pattern'], fallbackColor?: string): string {
        const paint = parseColor(style?.stroke) ?? parseColor(fallbackColor);
        const width = px(style?.strokeWidth, 1);
        if (!paint || width <= 0) return cell('LinePattern', 0);
        return cell('LineColor', paint.hex) + cell('LineWeight', width / DPI) +
            cell('LinePattern', linePattern(pattern, style?.strokeDasharray)) +
            (paint.alpha < 1 ? cell('LineColorTrans', 1 - paint.alpha) : '');
    }

    private characterSection(style: TextStyle | undefined): string {
        if (!style) return '';
        const cells: string[] = [];
        if (this.options.fonts) {
            const font = resolveFont(style.fontFamily);
            if (font) { this.fontsUsed.add(font); cells.push(cell('Font', font)); }
        }
        const color = parseColor(style.color);
        if (color) cells.push(cell('Color', color.hex));
        // Character.Size is read in inches whatever unit is stated, so
        // convert px -> inches and state none.
        const size = parseFloat(style.fontSize ?? '');
        if (Number.isFinite(size) && size > 0) cells.push(`<Cell N="Size" V="${(size / DPI).toFixed(4)}"/>`);
        const bits = (isBold(style.fontWeight) ? 1 : 0) | (style.fontStyle === 'italic' || style.fontStyle === 'oblique' ? 2 : 0);
        if (bits) cells.push(cell('Style', bits));
        return cells.length ? `<Section N="Character"><Row IX="0">${cells.join('')}</Row></Section>` : '';
    }

    private clusterShape(id: number, cluster: GraphCluster, membership: string): string {
        const t = this.transform(cluster.x, cluster.y, cluster.width, cluster.height);
        const W: Coord = { v: t.w, f: 'Width' };
        const H: Coord = { v: t.h, f: 'Height' };
        const zero: Coord = { v: 0 };
        return `<Shape ID="${id}" Type="Shape">` +
            t.xml +
            this.fillCells(cluster.style?.fill) +
            this.lineCells(cluster.style, undefined, '#000000') +
            // The title sits at the top of the frame, as in Mermaid.
            cell('VerticalAlign', 0) +
            membership +
            geometry(0, [['MoveTo', { X: zero, Y: zero }], ['LineTo', { X: W, Y: zero }], ['LineTo', { X: W, Y: H }], ['LineTo', { X: zero, Y: H }], ['LineTo', { X: zero, Y: zero }]]) +
            // Marks the shape as a Visio container, so moving it moves its members.
            `<Section N="User">` +
            `<Row N="msvStructureType">${cell('Value', 'Container', undefined, 'STR')}</Row>` +
            `<Row N="msvSDContainerMargin">${cell('Value', 0.125)}</Row>` +
            `<Row N="msvSDContainerResize">${cell('Value', 0)}</Row>` +
            `</Section>` +
            (cluster.text ? this.characterSection({ color: cluster.style?.color, fontSize: cluster.style?.fontSize }) : '') +
            (cluster.text ? `<Text>${esc(cluster.text)}</Text>` : '') +
            `</Shape>`;
    }

    private nodeShape(id: number, node: GraphNode, membership: string): string {
        const t = this.transform(node.x, node.y, node.width, node.height);
        const rounding = node.rounding && node.rounding > 0 ? cell('Rounding', node.rounding / DPI) : '';
        const align = node.style?.textAlign === 'left' ? 0 : node.style?.textAlign === 'right' ? 2 : 1;

        const hyperlink = node.url
            ? `<Section N="Hyperlink"><Row N="Row_1">${cell('Description', '')}${cell('Address', node.url)}${cell('SubAddress', '')}${cell('NewWindow', 0)}${cell('Default', 0)}${cell('Invisible', 0)}</Row></Section>`
            : '';

        // Four connection points, one per side, in the form Visio writes.
        const points: Array<[Coord, Coord, number, number]> = [
            [{ v: t.w / 2, f: 'Width*0.5' }, { v: 0 }, 0, -1],
            [{ v: t.w / 2, f: 'Width*0.5' }, { v: t.h, f: 'Height' }, 0, 1],
            [{ v: 0 }, { v: t.h / 2, f: 'Height*0.5' }, -1, 0],
            [{ v: t.w, f: 'Width' }, { v: t.h / 2, f: 'Height*0.5' }, 1, 0],
        ];
        const connections = `<Section N="Connection">` + points.map(([x, y, dx, dy], i) =>
            `<Row T="Connection" IX="${i}">${cell('X', x.v, x.f)}${cell('Y', y.v, y.f)}${cell('DirX', dx)}${cell('DirY', dy)}${cell('Type', 0)}</Row>`).join('') +
            `</Section>`;

        // A free-form piece of a drawing (no text of its own) is not
        // something to connect to.
        const drawingPiece = node.type === 'path' && !node.text;
        const ends = node.lineStart || node.lineEnd
            ? cell('BeginArrow', lineEnd(node.lineStart, undefined, false)) + cell('EndArrow', lineEnd(node.lineEnd, undefined, false)) +
              cell('BeginArrowSize', 2) + cell('EndArrowSize', 2)
            : '';

        // A node with its own text boxes is a group: the boxes are sub-shapes
        // positioned as fractions of the group's size, so they move and
        // scale with it.
        // Drawn parts, each a sub-shape with its own colours, placed and
        // scaled relative to the group like the text boxes below.
        const parts = (node.parts ?? []).map(part => {
            const pw = Math.max(part.width, 0.01) / DPI;
            const ph = Math.max(part.height, 0.01) / DPI;
            const px = (part.x + part.width / 2 - node.x) / DPI;
            const py = t.h - (part.y + part.height / 2 - node.y) / DPI;
            return this.partShape(this.nextChildId++, part, {
                pinX: px, pinY: py, width: pw, height: ph,
                fx: t.w > 0.02 ? `Sheet.${id}!Width*${num(px / t.w)}` : undefined,
                fy: t.h > 0.02 ? `Sheet.${id}!Height*${num(py / t.h)}` : undefined,
                fw: t.w > 0.02 ? `Sheet.${id}!Width*${num(pw / t.w)}` : undefined,
                fh: t.h > 0.02 ? `Sheet.${id}!Height*${num(ph / t.h)}` : undefined,
            });
        });
        const children = (node.children ?? []).map(child => {
            const cw = Math.max(child.width, 1) / DPI;
            const ch = Math.max(child.height, 1) / DPI;
            const cx = (child.x + child.width / 2 - node.x) / DPI;
            const cy = t.h - (child.y + child.height / 2 - node.y) / DPI;
            return this.labelShape(this.nextChildId++, child, {
                id, pinX: cx, pinY: cy, width: cw, height: ch,
                fx: t.w > 0.02 ? `Sheet.${id}!Width*${num(cx / t.w)}` : undefined,
                fy: t.h > 0.02 ? `Sheet.${id}!Height*${num(cy / t.h)}` : undefined,
            });
        });
        const isGroup = children.length > 0 || parts.length > 0;

        // Free-form outlines often keep their text off-centre (a triangle's
        // sits low, a document's high); put it where Mermaid did.
        let textBlock = '';
        if (node.type === 'path' && node.text && node.textX !== undefined && node.textY !== undefined) {
            const tw = Math.max((node.textWidth ?? 0) / DPI * 1.3, 0.3);
            const th = Math.max((node.textHeight ?? 0) / DPI, 0.15);
            const tx = (node.textX + (node.textWidth ?? 0) / 2 - node.x) / DPI;
            const ty = t.h - (node.textY + (node.textHeight ?? 0) / 2 - node.y) / DPI;
            textBlock = cell('TxtPinX', tx, t.w > 0.02 ? `Width*${num(tx / t.w)}` : undefined) +
                cell('TxtPinY', ty, t.h > 0.02 ? `Height*${num(ty / t.h)}` : undefined) +
                cell('TxtWidth', tw) + cell('TxtHeight', th) +
                cell('TxtLocPinX', tw / 2, 'TxtWidth*0.5') + cell('TxtLocPinY', th / 2, 'TxtHeight*0.5');
        }

        const paintless = node.type === 'group';
        return `<Shape ID="${id}" Type="${isGroup ? 'Group' : 'Shape'}">` +
            t.xml + textBlock + rounding +
            (paintless ? cell('FillPattern', 0) + cell('LinePattern', 0) : this.fillCells(node.style?.fill) + this.lineCells(node.style)) + ends +
            membership +
            this.nodeGeometry(node, t.w, t.h) +
            (node.text ? this.characterSection(node.style) : '') +
            // Centred is the default; only say so when it isn't.
            (align !== 1 ? `<Section N="Paragraph"><Row IX="0">${cell('HorzAlign', align)}</Row></Section>` : '') +
            hyperlink + (drawingPiece ? '' : connections) +
            (node.text ? `<Text>${esc(node.text)}</Text>` : '') +
            (isGroup ? `<Shapes>${parts.join('')}${children.join('')}</Shapes>` : '') +
            `</Shape>`;
    }

    // Outline of a node in its own coordinate system: origin at the
    // bottom-left corner, y up, extent Width x Height.
    private nodeGeometry(node: GraphNode, w: number, h: number): string {
        const zero: Coord = { v: 0 };
        const W = (k = 1): Coord => ({ v: w * k, f: k === 1 ? 'Width' : `Width*${num(k)}` });
        const H = (k = 1): Coord => ({ v: h * k, f: k === 1 ? 'Height' : `Height*${num(k)}` });
        const polygon = (pts: Array<[Coord, Coord]>): string =>
            geometry(0, [...pts, pts[0]].map(([X, Y], i) => [i === 0 ? 'MoveTo' : 'LineTo', { X, Y }]));
        const ellipse = (ix: number, inset: number, noFill: boolean): string =>
            geometry(ix, [['Ellipse', {
                X: W(0.5), Y: H(0.5),
                A: { v: w - inset, f: inset ? `Width-${num(inset)}` : 'Width' }, B: H(0.5),
                C: W(0.5), D: { v: h - inset, f: inset ? `Height-${num(inset)}` : 'Height' },
            }]], { noFill });

        switch (node.type) {
            case 'group':
                // Drawn entirely by its sub-shapes.
                return '';
            case 'path': {
                // The outline exactly as Mermaid drew it: one geometry
                // section per piece, scaled with the shape when resized.
                const X = (xPx: number): Coord => {
                    const v = xPx / DPI;
                    return w > 0.02 ? { v, f: `Width*${num(v / w)}` } : { v };
                };
                const Y = (yPx: number): Coord => {
                    const v = h - yPx / DPI;
                    return h > 0.02 ? { v, f: `Height*${num(v / h)}` } : { v };
                };
                let out = '';
                let ix = 0;
                for (const piece of node.paths ?? []) {
                    for (const sub of piece.subpaths) {
                        const pts = simplifyPolyline(sub.map(([x, y]) => ({ x, y })), 0.3);
                        if (pts.length < 2) continue;
                        out += geometry(ix++, pts.map((p, i): [string, Record<string, Coord>] =>
                            [i === 0 ? 'MoveTo' : 'LineTo', { X: X(p.x), Y: Y(p.y) }]), { noFill: !piece.fill, noLine: !piece.line });
                    }
                }
                if (out) return out;
                return polygon([[zero, zero], [W(), zero], [W(), H()], [zero, H()]]);
            }
            case 'circle':
            case 'ellipse': {
                const double = node.shape === 'doublecircle' || node.shape === 'dbl-circ' || node.shape === 'double-circle';
                const inset = Math.min(5 / DPI, w * 0.15, h * 0.15);
                return ellipse(0, 0, false) + (double ? ellipse(1, inset, true) : '');
            }
            case 'diamond':
                return polygon([[W(0.5), zero], [W(), H(0.5)], [W(0.5), H()], [zero, H(0.5)]]);
            case 'hexagon': {
                // Mermaid insets the side points by a quarter of the height.
                const s = Math.min(h / 4, w / 4);
                const L: Coord = { v: s, f: `Height*0.25` };
                const R: Coord = { v: w - s, f: `Width-Height*0.25` };
                const fixed = s !== h / 4;
                const l = fixed ? { v: s } : L, r = fixed ? { v: w - s } : R;
                return polygon([[l, zero], [r, zero], [W(), H(0.5)], [r, H()], [l, H()], [zero, H(0.5)]]);
            }
            case 'parallelogram':
            case 'trapezoid':
            case 'inv_trapezoid': {
                // Mermaid slants these sides by half the height.
                const s = Math.min(h / 2, w / 4);
                const fixed = s !== h / 2;
                const l: Coord = fixed ? { v: s } : { v: s, f: 'Height*0.5' };
                const r: Coord = fixed ? { v: w - s } : { v: w - s, f: 'Width-Height*0.5' };
                if (node.type === 'trapezoid') return polygon([[zero, zero], [W(), zero], [r, H()], [l, H()]]);
                if (node.type === 'inv_trapezoid') return polygon([[l, zero], [r, zero], [W(), H()], [zero, H()]]);
                const leanLeft = /left|lean-l|out-in/.test(node.shape ?? '');
                return leanLeft
                    ? polygon([[l, zero], [W(), zero], [r, H()], [zero, H()]])
                    : polygon([[zero, zero], [r, zero], [W(), H()], [l, H()]]);
            }
            case 'stadium': {
                // A rectangle with semicircular ends. Taller than wide, it is
                // just an ellipse.
                if (h >= w) return ellipse(0, 0, false);
                const l: Coord = { v: h / 2, f: 'Height*0.5' };
                const r: Coord = { v: w - h / 2, f: 'Width-Height*0.5' };
                const one: Coord = { v: 1 };
                return geometry(0, [
                    ['MoveTo', { X: l, Y: zero }],
                    ['LineTo', { X: r, Y: zero }],
                    ['EllipticalArcTo', { X: r, Y: H(), A: W(), B: H(0.5), C: zero, D: one }],
                    ['LineTo', { X: l, Y: H() }],
                    ['EllipticalArcTo', { X: l, Y: zero, A: zero, B: H(0.5), C: zero, D: one }],
                ]);
            }
            case 'cylinder': {
                // Elliptical rims of half-height ry at top and bottom.
                const ry = Math.min(h * 0.12, w * 0.45);
                const ratio: Coord = { v: (w / 2) / ry };
                const top: Coord = { v: h - ry };
                const bottom: Coord = { v: ry };
                return geometry(0, [
                    ['MoveTo', { X: zero, Y: top }],
                    ['EllipticalArcTo', { X: W(), Y: top, A: W(0.5), B: H(), C: zero, D: ratio }],
                    ['LineTo', { X: W(), Y: bottom }],
                    ['EllipticalArcTo', { X: zero, Y: bottom, A: W(0.5), B: zero, C: zero, D: ratio }],
                    ['LineTo', { X: zero, Y: top }],
                ]) + geometry(1, [
                    // Front edge of the top rim.
                    ['MoveTo', { X: zero, Y: top }],
                    ['EllipticalArcTo', { X: W(), Y: top, A: W(0.5), B: { v: h - 2 * ry }, C: zero, D: ratio }],
                ], { noFill: true });
            }
            case 'subroutine': {
                // A rectangle with a vertical bar inset from each side.
                const inset = Math.min(8 / DPI, w * 0.2);
                const bar = (ix: number, x: Coord): string =>
                    geometry(ix, [['MoveTo', { X: x, Y: zero }], ['LineTo', { X: x, Y: H() }]], { noFill: true });
                return polygon([[zero, zero], [W(), zero], [W(), H()], [zero, H()]]) +
                    bar(1, { v: inset }) + bar(2, { v: w - inset, f: `Width-${num(inset)}` });
            }
            default:
                return polygon([[zero, zero], [W(), zero], [W(), H()], [zero, H()]]);
        }
    }

    // Every edge is a 1-D shape: Begin and End are the ends of Mermaid's
    // route and the geometry is that route, relative to Begin. An edge whose
    // two ends resolve to different shapes is also glued to them.
    private edgeShape(id: number, edge: GraphEdge, shapeIdOf: Map<string, number>, connects: string[]): string {
        if (!edge.d) return '';
        const route = flattenPath(edge.d).find(p => p.length >= 2);
        if (!route) return '';
        const pts: Point[] = simplifyPolyline(route, 0.35).map(p => ({ x: this.toVisioX(p.x), y: this.toVisioY(p.y) }));
        const begin = pts[0];
        const end = { ...pts[pts.length - 1] };
        // A 1-D shape needs some length.
        if (Math.abs(end.x - begin.x) < 1e-4 && Math.abs(end.y - begin.y) < 1e-4) end.x += 0.001;
        const w = end.x - begin.x;
        const h = end.y - begin.y;

        const from = edge.startId !== undefined ? shapeIdOf.get(edge.startId) : undefined;
        const to = edge.endId !== undefined ? shapeIdOf.get(edge.endId) : undefined;
        // A self-loop can't be glued at both ends to one shape by dynamic
        // glue; it keeps its drawn route.
        const glued = from !== undefined && to !== undefined && from !== to;

        const guard = (f: string) => (glued ? `GUARD(${f})` : f);
        let cells =
            cell('PinX', (begin.x + end.x) / 2, guard('(BeginX+EndX)/2')) +
            cell('PinY', (begin.y + end.y) / 2, guard('(BeginY+EndY)/2')) +
            cell('Width', w, guard('EndX-BeginX')) +
            cell('Height', h, guard('EndY-BeginY')) +
            cell('LocPinX', w / 2, guard('Width*0.5')) +
            cell('LocPinY', h / 2, guard('Height*0.5'));
        if (glued) {
            // Dynamic glue, exactly as Visio writes it for a connector that
            // walks around the shapes it joins.
            cells += cell('Angle', 0, 'GUARD(0DA)') +
                cell('BeginX', begin.x, '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)') +
                cell('BeginY', begin.y, '_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)') +
                cell('EndX', end.x, '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)') +
                cell('EndY', end.y, '_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)') +
                cell('BegTrigger', 2, `_XFTRIGGER(Sheet.${from}!EventXFMod)`) +
                cell('EndTrigger', 2, `_XFTRIGGER(Sheet.${to}!EventXFMod)`) +
                // ObjType 2 marks a routable connector; route at right
                // angles, drawn curved when Mermaid's own route is.
                cell('ObjType', 2) + cell('GlueType', 2) + cell('NoAlignBox', 1) + cell('DynFeedback', 2) +
                cell('ShapeSplittable', 1) + cell('ShapeRouteStyle', 1) +
                cell('ConLineRouteExt', /[CcSsQqTt]/.test(edge.d) ? 2 : 1);
            connects.push(
                `<Connect FromSheet="${id}" FromCell="BeginX" FromPart="9" ToSheet="${from}" ToCell="PinX" ToPart="3"/>`,
                `<Connect FromSheet="${id}" FromCell="EndX" FromPart="12" ToSheet="${to}" ToCell="PinX" ToPart="3"/>`,
            );
        } else {
            cells += cell('BeginX', begin.x) + cell('BeginY', begin.y) + cell('EndX', end.x) + cell('EndY', end.y);
        }

        cells += cell('FillPattern', 0) + this.lineCells(edge.style, edge.pattern, '#000000');
        const beginArrow = lineEnd(edge.arrowStartKind, edge.arrowStart, false);
        const endArrow = lineEnd(edge.arrowEndKind, edge.arrowEnd, true);
        cells += cell('BeginArrow', beginArrow) + cell('EndArrow', endArrow) +
            cell('BeginArrowSize', 2) + cell('EndArrowSize', 2);

        let sections = '';
        if (edge.text) {
            // Place the caption where Mermaid put it; without that, halfway
            // along the route.
            const hasBox = edge.labelX !== undefined && edge.labelY !== undefined;
            const centre = hasBox
                ? { x: this.toVisioX(edge.labelX! + (edge.labelWidth ?? 0) / 2), y: this.toVisioY(edge.labelY! + (edge.labelHeight ?? 0) / 2) }
                : polylineMidpoint(pts);
            const tx = centre.x - begin.x;
            const ty = centre.y - begin.y;
            const lines = edge.text.split('\n');
            const fontIn = px(edge.labelStyle?.fontSize, 14) / DPI;
            const tw = Math.max((edge.labelWidth ?? 0) / DPI, Math.max(...lines.map(l => l.length)) * fontIn * 0.6, 0.2) + 0.1;
            const th = Math.max((edge.labelHeight ?? 0) / DPI, lines.length * fontIn * 1.3) + 0.04;
            cells += cell('TxtPinX', tx, glued ? 'SETATREF(Controls.TextPosition)' : undefined) +
                cell('TxtPinY', ty, glued ? 'SETATREF(Controls.TextPosition.Y)' : undefined) +
                cell('TxtWidth', tw) + cell('TxtHeight', th) +
                cell('TxtLocPinX', tw / 2, 'TxtWidth*0.5') + cell('TxtLocPinY', th / 2, 'TxtHeight*0.5') +
                // White behind the caption so the line doesn't strike through it.
                cell('TextBkgnd', 2);
            if (glued) {
                // The yellow handle that lets the caption be dragged.
                sections += `<Section N="Control"><Row N="TextPosition">` +
                    cell('X', tx) + cell('Y', ty) +
                    cell('XDyn', tx, 'Controls.TextPosition') + cell('YDyn', ty, 'Controls.TextPosition.Y') +
                    cell('XCon', 0) + cell('YCon', 0) + cell('CanGlue', 0) +
                    `</Row></Section>`;
            }
        }

        sections += geometry(0, pts.map((p, i): [string, Record<string, Coord>] => [
            i === 0 ? 'MoveTo' : 'LineTo',
            // The last row is pinned to the shape's far corner so the line
            // still reaches End after Visio moves it.
            i === pts.length - 1
                ? { X: { v: w, f: 'Width' }, Y: { v: h, f: 'Height' } }
                : { X: { v: p.x - begin.x }, Y: { v: p.y - begin.y } },
        ]), { noFill: true });

        if (edge.text) sections += this.characterSection(edge.labelStyle);

        return `<Shape ID="${id}" Type="Shape">` + cells + sections +
            (edge.text ? `<Text>${esc(edge.text)}</Text>` : '') + `</Shape>`;
    }

    // A drawn piece inside a group, in the group's coordinates.
    private partShape(id: number, part: GraphNode,
                      at: { pinX: number; pinY: number; width: number; height: number; fx?: string; fy?: string; fw?: string; fh?: string }): string {
        const ends = part.lineStart || part.lineEnd
            ? cell('BeginArrow', lineEnd(part.lineStart, undefined, false)) + cell('EndArrow', lineEnd(part.lineEnd, undefined, false)) +
              cell('BeginArrowSize', 2) + cell('EndArrowSize', 2)
            : '';
        return `<Shape ID="${id}" Type="Shape">` +
            cell('PinX', at.pinX, at.fx) + cell('PinY', at.pinY, at.fy) +
            cell('Width', at.width, at.fw) + cell('Height', at.height, at.fh) +
            cell('LocPinX', at.width / 2, 'Width*0.5') + cell('LocPinY', at.height / 2, 'Height*0.5') +
            this.fillCells(part.style?.fill) + this.lineCells(part.style) + ends +
            this.nodeGeometry(part, at.width, at.height) +
            (part.text ? this.characterSection(part.style) + `<Text>${esc(part.text)}</Text>` : '') +
            `</Shape>`;
    }

    // Text on its own: a rectangle with no outline. `within` places it
    // inside a group, in that group's coordinates.
    private labelShape(id: number, label: GraphLabel,
                       within?: { id: number; pinX: number; pinY: number; width: number; height: number; fx?: string; fy?: string }): string {
        const t = within
            ? {
                w: within.width, h: within.height,
                xml: cell('PinX', within.pinX, within.fx) + cell('PinY', within.pinY, within.fy) +
                    cell('Width', within.width) + cell('Height', within.height) +
                    cell('LocPinX', within.width / 2, 'Width*0.5') + cell('LocPinY', within.height / 2, 'Height*0.5'),
            }
            : this.transform(label.x, label.y, label.width || 10, label.height || 10);
        const W: Coord = { v: t.w, f: 'Width' };
        const H: Coord = { v: t.h, f: 'Height' };
        const zero: Coord = { v: 0 };
        const hasFill = !!parseColor(label.style?.fill);
        // The text block is wider than the box, so a font slightly wider
        // than the one Mermaid measured with doesn't force a line break.
        const tw = Math.max(t.w * 1.6, t.w + 0.3);
        const textBlock =
            cell('TxtPinX', t.w / 2, 'Width*0.5') + cell('TxtPinY', t.h / 2, 'Height*0.5') +
            cell('TxtWidth', tw) + cell('TxtHeight', t.h, 'Height') +
            cell('TxtLocPinX', tw / 2, 'TxtWidth*0.5') + cell('TxtLocPinY', t.h / 2, 'TxtHeight*0.5');
        // Screen rotation is clockwise in degrees; Visio's is counter-clockwise in radians.
        const angle = label.angle ? cell('Angle', -label.angle * Math.PI / 180) : '';
        return `<Shape ID="${id}" Type="Shape">` +
            t.xml + angle + textBlock + cell('LinePattern', 0) + this.fillCells(label.style?.fill) +
            geometry(0, [['MoveTo', { X: zero, Y: zero }], ['LineTo', { X: W, Y: zero }], ['LineTo', { X: W, Y: H }], ['LineTo', { X: zero, Y: H }], ['LineTo', { X: zero, Y: zero }]],
                { noFill: !hasFill, noLine: true }) +
            this.characterSection(label.style) +
            `<Text>${esc(label.text)}</Text></Shape>`;
    }
}
