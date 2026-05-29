import JSZip from 'jszip';
import { VsdxGenerator } from '../src/vsdx';
import { parseMermaid, translatePathD } from '../src/parser';
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
    // Mermaid 11.x wraps nodes as id="flowchart-<USERID>-<IDX>". Edges still
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

describe('parsePathToVisio', () => {
  // Mock geomXml that captures emitted Row entries instead of building XML.
  function mockGeom() {
    const rows: Array<{ T: string, X: string, Y: string }> = [];
    const node: any = {
      _pending: null as null | { T: string, X?: string, Y?: string },
      ele(name: string, attrs: any) {
        if (name === 'Row') {
          node._pending = { T: attrs.T };
          return node;
        }
        if (name === 'Cell') {
          if (node._pending) (node._pending as any)[attrs.N] = attrs.V;
          return node;
        }
        return node;
      },
      up() {
        if (node._pending && 'X' in node._pending && 'Y' in node._pending) {
          rows.push(node._pending as any);
          node._pending = null;
        }
        return node;
      },
    };
    return { geom: node, rows };
  }

  it('handles M, L, H, V, Z commands (absolute and relative)', () => {
    const g = new VsdxGenerator();
    const { geom, rows } = mockGeom();
    g.parsePathToVisio('M 10 10 L 20 10 H 30 V 30 Z', geom);
    // MoveTo, LineTo, LineTo (H), LineTo (V), LineTo (Z back to start)
    expect(rows.map(r => r.T)).toEqual(['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'LineTo']);
  });

  it('does not silently drop quadratic or arc commands', () => {
    const g = new VsdxGenerator();
    const { geom, rows } = mockGeom();
    g.parsePathToVisio('M 0 0 Q 10 10 20 0 A 5 5 0 0 1 30 0', geom);
    const lineTos = rows.filter(r => r.T === 'LineTo').length;
    // 4 flattened segments for Q + arc segments for A
    expect(lineTos).toBeGreaterThanOrEqual(5);
  });

  it('flattens an elliptical arc into a curved polyline ending at the endpoint', () => {
    // A quarter-circle arc from (0,0) to (10,10), r=10. The flattened polyline
    // must (a) contain several segments (not one straight line), (b) end at the
    // commanded endpoint, and (c) actually bow away from the chord midpoint.
    const g = new VsdxGenerator();
    const { geom, rows } = mockGeom();
    g.parsePathToVisio('M 0 0 A 10 10 0 0 1 10 10', geom);
    const lineTos = rows.filter(r => r.T === 'LineTo');
    expect(lineTos.length).toBeGreaterThanOrEqual(4); // curved, not a single chord
    // Endpoint (10 px) -> X = 0.5 + 10/96; Y = 11 - 0.5 - 10/96.
    const last = lineTos[lineTos.length - 1];
    expect(parseFloat(last.X)).toBeCloseTo(0.5 + 10 / 96, 4);
    expect(parseFloat(last.Y)).toBeCloseTo(11 - 0.5 - 10 / 96, 4);
    // A straight chord would keep all points colinear; an arc must deviate.
    // Check a midpoint segment is off the straight chord line y = -x (in SVG).
    const mid = lineTos[Math.floor(lineTos.length / 2)];
    const chordX = parseFloat(mid.X);
    const chordYon = 11 - 0.5 - (parseFloat((mid as any).X) - 0.5); // y if colinear
    expect(Math.abs(parseFloat(mid.Y) - chordYon)).toBeGreaterThan(0.01);
    expect(chordX).toBeGreaterThan(0); // sanity
  });

  it('applies the margin-aware transform so fallback edges align with nodes', () => {
    // Regression for the margin bug: the fallback path transform must match
    // the one nodes use (margin + px/dpi for X; pageHeight - margin - px/dpi
    // for Y). A default generator is 8.5x11" with a 0.5" margin at 96 dpi.
    const g = new VsdxGenerator();
    const { geom, rows } = mockGeom();
    g.parsePathToVisio('M 96 96 L 192 96', geom);
    // (96 px = 1") -> X = 0.5 + 1 = 1.5"; Y = 11 - 0.5 - 1 = 9.5".
    expect(parseFloat(rows[0].X)).toBeCloseTo(1.5, 6);
    expect(parseFloat(rows[0].Y)).toBeCloseTo(9.5, 6);
    // (192 px = 2") -> X = 0.5 + 2 = 2.5".
    expect(parseFloat(rows[1].X)).toBeCloseTo(2.5, 6);
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
