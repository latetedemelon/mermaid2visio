import JSZip from 'jszip';
import { VsdxGenerator } from '../src/vsdx';
import { parseMermaid, translatePathD } from '../src/parser';
import { flattenPath, simplifyPolyline, polylineMidpoint } from '../src/core/svgPath';
import type { GraphData } from '../src/parser';

async function unzipPage(buffer: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('visio/pages/page1.xml');
  if (!file) throw new Error('page1.xml not found');
  return file.async('string');
}

function pinOf(xml: string, shapeId: number): { pinX: number, pinY: number } {
  const shapeRe = new RegExp(`<Shape\\b[^>]*ID="${shapeId}"[^>]*>([\\s\\S]*?)</Shape>`);
  const m = shapeRe.exec(xml);
  if (!m) throw new Error(`Shape ${shapeId} not found`);
  const body = m[1];
  const pinX = /<Cell\s+N="PinX"\s+V="([^"]+)"/.exec(body);
  const pinY = /<Cell\s+N="PinY"\s+V="([^"]+)"/.exec(body);
  if (!pinX || !pinY) throw new Error(`PinX/PinY not found on shape ${shapeId}`);
  return { pinX: parseFloat(pinX[1]), pinY: parseFloat(pinY[1]) };
}

describe('Coordinate conversion', () => {
  it('places nodes and clusters using a single top-left convention', async () => {
    // Two shapes, same top-left and size, one a cluster and one a node.
    // After conversion they must land at the same PinX/PinY.
    const graph: GraphData = {
      width: 500,
      height: 500,
      nodes: [{ id: 'n1', x: 96, y: 192, width: 96, height: 48, text: 'N' }],
      edges: [],
      clusters: [{ id: 'c1', x: 96, y: 192, width: 96, height: 48, text: 'C' }],
      labels: [],
    };

    const buffer = await new VsdxGenerator().generate(graph);
    const xml = await unzipPage(buffer);

    // Cluster is emitted first (shape 1), node second (shape 2).
    const cluster = pinOf(xml, 1);
    const node = pinOf(xml, 2);

    expect(node.pinX).toBeCloseTo(cluster.pinX, 6);
    expect(node.pinY).toBeCloseTo(cluster.pinY, 6);

    // Spot-check the math: top-left (96, 192) px at 96 dpi -> (1, 2) inches;
    // center offset (48, 24) px -> (0.5, 0.25) inches;
    // SVG-space center = (1.5, 2.25); add 0.5" margin → PinX = 2.0".
    expect(node.pinX).toBeCloseTo(2.0, 6);
  });

  it('wires BeginX/BeginY/EndX/EndY when both endpoints resolve', async () => {
    const graph: GraphData = {
      width: 500,
      height: 500,
      nodes: [
        { id: 'a', x: 0,   y: 0,   width: 96, height: 48, text: 'A' },
        { id: 'b', x: 192, y: 144, width: 96, height: 48, text: 'B' },
      ],
      edges: [{ d: 'M0,0 L1,1', startId: 'a', endId: 'b', arrowStart: false, arrowEnd: true }],
      clusters: [],
      labels: [],
    };

    const buffer = await new VsdxGenerator().generate(graph);
    const xml = await unzipPage(buffer);

    // Nodes are shapes 1 and 2; the connector is shape 3.
    const connectorMatch = /<Shape\b[^>]*ID="3"[^>]*>([\s\S]*?)<\/Shape>/.exec(xml);
    expect(connectorMatch).not.toBeNull();
    const body = connectorMatch![1];

    expect(body).toMatch(/<Cell\s+N="BeginX"/);
    expect(body).toMatch(/<Cell\s+N="BeginY"/);
    expect(body).toMatch(/<Cell\s+N="EndX"/);
    expect(body).toMatch(/<Cell\s+N="EndY"/);
    expect(body).toMatch(/<Cell\s+N="ObjType"\s+V="2"/);

    expect(xml).toMatch(/<Connect\b[^/]*FromCell="BeginX"[^/]*ToCell="PinX"/);
    expect(xml).toMatch(/<Connect\b[^/]*FromCell="EndX"[^/]*ToCell="PinX"/);
  });

  it('parser emits nodes as top-left corners, matching cluster convention', async () => {
    // Regression guard for the center-vs-top-left bug: Mermaid's node <g>
    // groups translate to the node CENTER with the inner rect at (-W/2, -H/2).
    // The parser must add bbox.x/y so (x, y) becomes the top-left corner,
    // otherwise every shape lands offset by (W/2, H/2) in Visio.
    const graph = await parseMermaid(`flowchart TB
  A[Alpha] --> B[Bravo]`);

    expect(graph.nodes.length).toBe(2);
    for (const n of graph.nodes) {
      // Top-left must fit inside the SVG viewport. If x were the center,
      // x + width would overflow graph.width.
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(graph.width + 1);
      expect(n.y + n.height).toBeLessThanOrEqual(graph.height + 1);
    }
  }, 60000);

  it('parses user-facing node ids (not the "flowchart-X-N" scaffold)', async () => {
    // Mermaid wraps nodes as id="<svgId>-flowchart-<USERID>-<IDX>". Edges still
    // carry the plain user id, so the parser MUST strip the scaffold or every
    // lookup in the generator's nodeIdToPin map misses and every connector
    // falls through to the unglued path-drawing branch.
    const graph = await parseMermaid(`flowchart TB
  A[Alpha] --> B[Bravo]`);
    const ids = graph.nodes.map(n => n.id).sort();
    expect(ids).toEqual(['A', 'B']);
  }, 60000);

  it('links edges to their endpoints via startId/endId', async () => {
    // Regression for the LS-/LE- vs L_src_dst_idx format change. Without
    // endpoint ids, every connector falls back to raw path drawing — the
    // shape is no longer a real Visio connector and Visio renders it as a
    // static line that does not follow its nodes when they move.
    const graph = await parseMermaid(`flowchart TB
  A[Alpha] --> B[Bravo]
  B --> C[Charlie]`);
    expect(graph.edges.length).toBe(2);
    for (const e of graph.edges) {
      expect(e.startId).toBeTruthy();
      expect(e.endId).toBeTruthy();
    }
    const pairs = graph.edges.map(e => `${e.startId}->${e.endId}`).sort();
    expect(pairs).toEqual(['A->B', 'B->C']);
  }, 60000);

  it('glues edges whose endpoints are clusters (subgraphs)', async () => {
    // Mermaid allows `subgraphName --> node` edges. Clusters need to be
    // registered in the same id -> pin map as nodes so the glue branch fires.
    const graph = await parseMermaid(`flowchart TB
  subgraph G [Group]
    A[Alpha]
  end
  G --> B[Bravo]`);
    const buffer = await new VsdxGenerator().generate(graph);
    const xml = await unzipPage(buffer);
    // If the G->B edge was unglued, there'd be no Connect rows at all.
    expect(xml).toMatch(/<Connect\b[^/]*FromCell="BeginX"[^/]*ToCell="PinX"/);
    expect(xml).toMatch(/<Connect\b[^/]*FromCell="EndX"[^/]*ToCell="PinX"/);
  }, 60000);

  it('embeds edge label text in the connector Shape Text element', async () => {
    // Regression guard: edge.text must appear in the connector's <Text> child,
    // not as a separate floating label shape. This keeps the label attached to
    // the connector so it moves when nodes are repositioned in Visio.
    const graph: GraphData = {
      width: 200,
      height: 200,
      nodes: [
        { id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' },
        { id: 'b', x: 0, y: 100, width: 96, height: 48, text: 'B' },
      ],
      edges: [{ d: 'M0,0 L1,1', startId: 'a', endId: 'b', text: 'yes', arrowEnd: true }],
      clusters: [],
      labels: [],
    };
    const xml = await unzipPage(await new VsdxGenerator().generate(graph));
    // Connector is shape 3 (after the two nodes). Its body must contain <Text>yes</Text>.
    const connectorMatch = /<Shape\b[^>]*ID="3"[^>]*>([\s\S]*?)<\/Shape>/.exec(xml);
    expect(connectorMatch).not.toBeNull();
    expect(connectorMatch![1]).toMatch(/<Text>yes<\/Text>/);
  });

  it('forwards edge label style to a connector Character section before the text', async () => {
    // The label's color/size must ride along as a Character section so the
    // caption renders in the Mermaid theme colour, not Visio's default.
    const graph: GraphData = {
      width: 200,
      height: 200,
      nodes: [
        { id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' },
        { id: 'b', x: 0, y: 100, width: 96, height: 48, text: 'B' },
      ],
      edges: [{
        d: 'M0,0 L1,1', startId: 'a', endId: 'b', text: 'yes', arrowEnd: true,
        labelStyle: { color: 'rgb(255, 0, 0)', fontSize: '14px', fontWeight: 'bold' },
      }],
      clusters: [],
      labels: [],
    };
    const xml = await unzipPage(await new VsdxGenerator().generate(graph));
    const body = /<Shape\b[^>]*ID="3"[^>]*>([\s\S]*?)<\/Shape>/.exec(xml)![1];
    // Character section present with normalised colour and inch-based size.
    expect(body).toMatch(/<Section N="Character"/);
    expect(body).toMatch(/<Cell N="Color" V="#ff0000"/);
    expect(body).toMatch(/<Cell N="Size" V="0\.1458"/); // 14/96
    expect(body).toMatch(/<Cell N="Style" V="1"/);      // bold
    // Order: the Character section must precede the <Text> element.
    expect(body.indexOf('N="Character"')).toBeLessThan(body.indexOf('<Text>'));
  });

  it('Connects is a sibling of Shapes, not nested inside it', async () => {
    // VSDX spec: PageContents contains <Shapes> and <Connects> as siblings.
    // If <Connects> were a child of <Shapes>, Visio would silently ignore
    // the connections and shapes would appear unglued.
    const graph: GraphData = {
      width: 200,
      height: 200,
      nodes: [
        { id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' },
        { id: 'b', x: 0, y: 100, width: 96, height: 48, text: 'B' },
      ],
      edges: [{ d: 'M0,0 L1,1', startId: 'a', endId: 'b', arrowEnd: true }],
      clusters: [],
      labels: [],
    };
    const xml = await unzipPage(await new VsdxGenerator().generate(graph));
    // <Connects> must appear AFTER </Shapes>, not before it.
    const shapesEnd = xml.indexOf('</Shapes>');
    const connectsStart = xml.indexOf('<Connects');
    expect(shapesEnd).toBeGreaterThan(-1);
    expect(connectsStart).toBeGreaterThan(shapesEnd);
  });
});

describe('flattenPath', () => {
  it('handles M, L, H, V, Z commands (absolute and relative)', () => {
    expect(flattenPath('M 10 10 L 20 10 H 30 V 30 Z')).toEqual([
      [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 10 }],
    ]);
    expect(flattenPath('m 10 10 l 10 0 h 10 v 20 z')).toEqual(flattenPath('M 10 10 L 20 10 H 30 V 30 Z'));
  });

  it('starts a new polyline at every M', () => {
    const subpaths = flattenPath('M 0 0 L 10 0 M 20 20 L 30 20');
    expect(subpaths.length).toBe(2);
    expect(subpaths[1][0]).toEqual({ x: 20, y: 20 });
  });

  it('does not silently drop quadratic, cubic or arc commands', () => {
    const [pts] = flattenPath('M 0 0 Q 10 10 20 0 C 25 -10 35 -10 40 0 A 5 5 0 0 1 50 0');
    expect(pts.length).toBeGreaterThan(12);
    expect(pts[pts.length - 1]).toEqual({ x: 50, y: 0 });
  });

  it('flattens an elliptical arc into a curve that ends at the endpoint', () => {
    // A quarter circle from (0,0) to (10,10), r=10.
    const [pts] = flattenPath('M 0 0 A 10 10 0 0 1 10 10');
    expect(pts.length).toBeGreaterThanOrEqual(5); // curved, not a single chord
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 10 });
    // Every point lies on the circle centred (0,10): not on the chord y = x.
    for (const p of pts) expect(Math.hypot(p.x - 0, p.y - 10)).toBeCloseTo(10, 6);
    const mid = pts[Math.floor(pts.length / 2)];
    expect(Math.abs(mid.x - mid.y)).toBeGreaterThan(1);
  });

  it('reflects the control point for smooth curve commands', () => {
    // S after C continues the curve smoothly: its first control point mirrors
    // the previous one, so the tangent at the join is continuous.
    const [pts] = flattenPath('M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0', { curveSteps: 16 });
    const join = pts.findIndex(p => p.x === 10 && p.y === 0);
    const before = pts[join - 1], after = pts[join + 1];
    const slopeIn = (0 - before.y) / (10 - before.x);
    const slopeOut = (after.y - 0) / (after.x - 10);
    expect(Math.sign(slopeIn)).toBe(Math.sign(slopeOut));
  });
});

describe('simplifyPolyline / polylineMidpoint', () => {
  it('drops collinear points but keeps corners and ends', () => {
    const line = [{ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    expect(simplifyPolyline(line, 0.35)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it('finds the point halfway along by length', () => {
    expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }])).toEqual({ x: 10, y: 10 });
  });
});

describe('connector geometry', () => {
  const connector = async (edge: GraphData['edges'][number], nodes = true) => {
    const graph: GraphData = {
      width: 400, height: 400,
      nodes: nodes ? [
        { id: 'a', x: 0, y: 0, width: 96, height: 48, text: 'A' },
        { id: 'b', x: 192, y: 192, width: 96, height: 48, text: 'B' },
      ] : [],
      edges: [edge], clusters: [], labels: [],
    };
    const xml = await unzipPage(await new VsdxGenerator().generate(graph));
    const id = nodes ? 3 : 1;
    return { xml, body: new RegExp(`<Shape\\b[^>]*ID="${id}"[^>]*>([\\s\\S]*?)</Shape>`).exec(xml)![1] };
  };
  const cellOf = (body: string, n: string) => {
    const m = new RegExp(`<Cell N="${n}" V="([^"]*)"(?: F="([^"]*)")?`).exec(body);
    return m ? { v: parseFloat(m[1]), f: m[2] } : null;
  };
  const rowsOf = (body: string) =>
    [...body.matchAll(/<Row T="(MoveTo|LineTo)"[^>]*><Cell N="X" V="([^"]+)"[^>]*\/><Cell N="Y" V="([^"]+)"/g)]
      .map(m => ({ t: m[1], x: parseFloat(m[2]), y: parseFloat(m[3]) }));

  // The route Mermaid drew: out of A's right side, across, down into B's top.
  const ROUTE = 'M 96 24 L 240 24 L 240 192';

  it('uses the same page transform as nodes (0.5" margin, y flipped)', async () => {
    const { body } = await connector({ d: 'M 96 96 L 192 96' }, false);
    // 96 px = 1": X = 0.5 + 1; Y = 11 - 0.5 - 1.
    expect(cellOf(body, 'BeginX')!.v).toBeCloseTo(1.5, 6);
    expect(cellOf(body, 'BeginY')!.v).toBeCloseTo(9.5, 6);
    expect(cellOf(body, 'EndX')!.v).toBeCloseTo(2.5, 6);
  });

  it("keeps Mermaid's route as the connector's geometry, relative to its begin point", async () => {
    const { body } = await connector({ d: ROUTE, startId: 'a', endId: 'b', arrowEnd: true });
    // Begin and End are the ends of the route, not the shape centres.
    expect(cellOf(body, 'BeginX')!.v).toBeCloseTo(1.5, 6);   // 0.5 + 96/96
    expect(cellOf(body, 'BeginY')!.v).toBeCloseTo(10.25, 6); // 11 - 0.5 - 24/96
    expect(cellOf(body, 'EndX')!.v).toBeCloseTo(3.0, 6);
    expect(cellOf(body, 'EndY')!.v).toBeCloseTo(8.5, 6);
    // Three points: start, the corner, the end. y runs upward on the page.
    const rows = rowsOf(body);
    expect(rows.map(r => r.t)).toEqual(['MoveTo', 'LineTo', 'LineTo']);
    expect([rows[0].x, rows[0].y]).toEqual([0, 0]);
    expect(rows[1].x).toBeCloseTo(1.5, 6);
    expect(rows[1].y).toBeCloseTo(0, 6);
    expect(rows[2].x).toBeCloseTo(1.5, 6);
    expect(rows[2].y).toBeCloseTo(-1.75, 6);
    // The 1-D transform is derived from the endpoints, as in Visio's own
    // connectors: width and height are signed.
    expect(cellOf(body, 'Width')).toEqual({ v: 1.5, f: 'GUARD(EndX-BeginX)' });
    expect(cellOf(body, 'Height')).toEqual({ v: -1.75, f: 'GUARD(EndY-BeginY)' });
    expect(cellOf(body, 'PinX')!.f).toBe('GUARD((BeginX+EndX)/2)');
  });

  it('glues both ends with dynamic glue so the connector follows its shapes', async () => {
    const { xml, body } = await connector({ d: ROUTE, startId: 'a', endId: 'b', arrowEnd: true });
    expect(cellOf(body, 'BeginX')!.f).toBe('_WALKGLUE(BegTrigger,EndTrigger,WalkPreference)');
    expect(cellOf(body, 'EndY')!.f).toBe('_WALKGLUE(EndTrigger,BegTrigger,WalkPreference)');
    expect(cellOf(body, 'BegTrigger')!.f).toBe('_XFTRIGGER(Sheet.1!EventXFMod)');
    expect(cellOf(body, 'EndTrigger')!.f).toBe('_XFTRIGGER(Sheet.2!EventXFMod)');
    expect(cellOf(body, 'ObjType')!.v).toBe(2);
    // Which end is glued (9 = begin, 12 = end) and to what (3 = the whole shape).
    expect(xml).toContain('<Connect FromSheet="3" FromCell="BeginX" FromPart="9" ToSheet="1" ToCell="PinX" ToPart="3"/>');
    expect(xml).toContain('<Connect FromSheet="3" FromCell="EndX" FromPart="12" ToSheet="2" ToCell="PinX" ToPart="3"/>');
  });

  it('draws an edge with no resolvable endpoints as a plain line, unglued', async () => {
    const { xml, body } = await connector({ d: ROUTE, startId: 'a', endId: 'missing' });
    expect(cellOf(body, 'BeginX')!.f).toBeUndefined();
    expect(cellOf(body, 'ObjType')).toBeNull();
    expect(xml).not.toContain('<Connects>');
    // Still a tight 1-D shape, not a page-sized one.
    expect(cellOf(body, 'Width')!.v).toBeCloseTo(1.5, 6);
    expect(rowsOf(body).length).toBe(3);
  });

  it('keeps a self-loop as drawn rather than gluing both ends to one shape', async () => {
    const { xml, body } = await connector({ d: 'M 96 10 C 140 10 140 40 96 40', startId: 'a', endId: 'a' });
    expect(xml).not.toContain('<Connects>');
    expect(rowsOf(body).length).toBeGreaterThan(3);
  });

  it("puts the caption where Mermaid placed it, in the connector's own coordinates", async () => {
    // Label box centred on (240, 100) px, i.e. on the vertical leg.
    const { body } = await connector({
      d: ROUTE, startId: 'a', endId: 'b', text: 'yes',
      labelX: 225, labelY: 90, labelWidth: 30, labelHeight: 20,
    });
    // Begin is (96, 24) px. Offset to the label centre: +144 px right, 76 px down.
    expect(cellOf(body, 'TxtPinX')!.v).toBeCloseTo(144 / 96, 6);
    expect(cellOf(body, 'TxtPinY')!.v).toBeCloseTo(-76 / 96, 6);
    expect(cellOf(body, 'TxtLocPinX')!.f).toBe('TxtWidth*0.5');
    expect(cellOf(body, 'TextBkgnd')!.v).toBe(2);
    expect(body).toMatch(/<Section N="Control"><Row N="TextPosition">/);
    expect(body).toMatch(/<Text>yes<\/Text>/);
  });

  it('falls back to the middle of the route when the caption has no recorded position', async () => {
    const { body } = await connector({ d: 'M 0 0 L 192 0', text: 'mid' }, false);
    expect(cellOf(body, 'TxtPinX')!.v).toBeCloseTo(1, 6);
    expect(cellOf(body, 'TxtPinY')!.v).toBeCloseTo(0, 6);
  });

  it('maps each kind of edge end to a Visio line end', async () => {
    const ends = async (edge: Partial<GraphData['edges'][number]>) => {
      const { body } = await connector({ d: ROUTE, startId: 'a', endId: 'b', ...edge });
      return [cellOf(body, 'BeginArrow')!.v, cellOf(body, 'EndArrow')!.v];
    };
    expect(await ends({ arrowStartKind: 'none', arrowEndKind: 'arrow_point' })).toEqual([0, 13]);
    expect(await ends({ arrowStartKind: 'arrow_point', arrowEndKind: 'arrow_point' })).toEqual([13, 13]);
    expect(await ends({ arrowStartKind: 'none', arrowEndKind: 'none' })).toEqual([0, 0]);
    expect(await ends({ arrowStartKind: 'none', arrowEndKind: 'arrow_circle' })).toEqual([0, 10]);
    expect(await ends({ arrowStartKind: 'extension', arrowEndKind: 'none' })).toEqual([16, 0]);
    expect(await ends({ arrowStartKind: 'aggregation', arrowEndKind: 'none' })).toEqual([22, 0]);
    expect(await ends({ arrowStartKind: 'only_one', arrowEndKind: 'zero_or_more' })).toEqual([25, 29]);
    expect(await ends({ arrowStartKind: 'zero_or_one', arrowEndKind: 'one_or_more' })).toEqual([30, 28]);
    // Without kinds, the booleans decide; an edge with neither gets the
    // conventional end arrow.
    expect(await ends({ arrowStart: true, arrowEnd: false })).toEqual([13, 0]);
    expect(await ends({})).toEqual([0, 13]);
  });

  it('writes the line pattern from the model, falling back to the dash array', async () => {
    const pattern = async (edge: Partial<GraphData['edges'][number]>) =>
      cellOf((await connector({ d: ROUTE, startId: 'a', endId: 'b', ...edge })).body, 'LinePattern')!.v;
    expect(await pattern({ pattern: 'solid', style: { stroke: '#000', strokeDasharray: '0px' } })).toBe(1);
    expect(await pattern({ pattern: 'dashed', style: { stroke: '#000' } })).toBe(2);
    expect(await pattern({ pattern: 'dotted', style: { stroke: '#000' } })).toBe(3);
    expect(await pattern({ style: { stroke: '#000', strokeDasharray: '3, 3' } })).toBe(2);
    expect(await pattern({ style: { stroke: '#000', strokeDasharray: '2px' } })).toBe(3);
  });
});

describe('containers', () => {
  const build = async () => {
    const graph: GraphData = {
      width: 600, height: 600,
      nodes: [
        { id: 'in1', x: 60, y: 60, width: 96, height: 48, text: 'In 1', parentId: 'inner' },
        { id: 'in2', x: 60, y: 300, width: 96, height: 48, text: 'In 2', parentId: 'outer' },
        { id: 'out', x: 450, y: 60, width: 96, height: 48, text: 'Out' },
      ],
      edges: [],
      // Listed inner-first on purpose: the generator must reorder them.
      clusters: [
        { id: 'inner', x: 40, y: 40, width: 150, height: 100, text: 'Inner', parentId: 'outer' },
        { id: 'outer', x: 20, y: 20, width: 300, height: 400, text: 'Outer' },
      ],
      labels: [],
    };
    return unzipPage(await new VsdxGenerator().generate(graph));
  };
  const shape = (xml: string, id: number) => new RegExp(`<Shape\\b[^>]*ID="${id}"[^>]*>([\\s\\S]*?)</Shape>`).exec(xml)![1];
  const relationships = (body: string) => /<Cell N="Relationships" V="0" F="([^"]*)"/.exec(body)?.[1];

  it('draws outer subgraphs before the ones inside them', async () => {
    const xml = await build();
    expect(shape(xml, 1)).toContain('<Text>Outer</Text>');
    expect(shape(xml, 2)).toContain('<Text>Inner</Text>');
  });

  it('records membership in both directions, through every level of nesting', async () => {
    const xml = await build();
    // outer(1) contains inner(2), in1(3) and in2(4); inner contains in1.
    expect(relationships(shape(xml, 1))).toBe('SUM(DEPENDSON(1,Sheet.2!SheetRef(),Sheet.3!SheetRef(),Sheet.4!SheetRef()))');
    expect(relationships(shape(xml, 2))).toBe('SUM(DEPENDSON(1,Sheet.3!SheetRef()),DEPENDSON(4,Sheet.1!SheetRef()))');
    expect(relationships(shape(xml, 3))).toBe('SUM(DEPENDSON(4,Sheet.2!SheetRef(),Sheet.1!SheetRef()))');
    expect(relationships(shape(xml, 4))).toBe('SUM(DEPENDSON(4,Sheet.1!SheetRef()))');
    // A node outside every subgraph has no relationships at all.
    expect(relationships(shape(xml, 5))).toBeUndefined();
  });

  it('works out membership from geometry when the extractor gave no parent', async () => {
    const graph: GraphData = {
      width: 400, height: 400,
      nodes: [
        { id: 'inside', x: 60, y: 60, width: 50, height: 30, text: 'in' },
        { id: 'outside', x: 300, y: 300, width: 50, height: 30, text: 'out' },
      ],
      edges: [],
      clusters: [{ id: 'c', x: 40, y: 40, width: 150, height: 100, text: 'C' }],
      labels: [],
    };
    const xml = await unzipPage(await new VsdxGenerator().generate(graph));
    expect(relationships(shape(xml, 1))).toBe('SUM(DEPENDSON(1,Sheet.2!SheetRef()))');
    expect(relationships(shape(xml, 2))).toBe('SUM(DEPENDSON(4,Sheet.1!SheetRef()))');
    expect(relationships(shape(xml, 3))).toBeUndefined();
  });
});

describe('translatePathD', () => {
  // translatePathD reconstructs commands without re-inserting inter-command
  // spaces (the original whitespace is consumed by the regex). Tests match
  // on individual command segments rather than exact string equality.

  it('translates M and L absolute coordinates', () => {
    const result = translatePathD('M 10 20 L 30 40', -10, -20);
    expect(result).toContain('M 0 0');
    expect(result).toContain('L 20 20');
  });

  it('translates C cubic bezier control and end points', () => {
    const shifted = translatePathD('M 0 0 C 10 20 30 40 50 60', -10, -20);
    expect(shifted).toContain('M -10 -20');
    expect(shifted).toContain('C 0 0 20 20 40 40');
  });

  it('leaves relative commands (lowercase) untouched', () => {
    const result = translatePathD('M 10 20 l 5 5 h 10 v 10', -10, -20);
    // M is absolute → translated; l/h/v are relative → unchanged
    expect(result).toContain('M 0 0');
    expect(result).toContain('l 5 5');
    expect(result).toContain('h 10');
    expect(result).toContain('v 10');
  });

  it('translates H and V absolute commands correctly', () => {
    const result = translatePathD('M 0 0 H 100 V 50', 5, 10);
    expect(result).toContain('M 5 10');
    expect(result).toContain('H 105');
    expect(result).toContain('V 60');
  });

  it('handles A arc endpoint (last two values) only', () => {
    // A rx ry x-rot large-arc sweep x y — only x,y are translated
    const result = translatePathD('M 0 0 A 5 5 0 0 1 20 30', -5, -10);
    expect(result).toContain('M -5 -10');
    expect(result).toContain('A 5 5 0 0 1 15 20');
  });

  it('is a no-op when dx=0 and dy=0', () => {
    const result = translatePathD('M 10 20 L 30 40', 0, 0);
    expect(result).toContain('M 10 20');
    expect(result).toContain('L 30 40');
  });
});
