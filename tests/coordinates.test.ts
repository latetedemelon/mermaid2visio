import JSZip from 'jszip';
import { VsdxGenerator } from '../src/vsdx';
import { parseMermaid } from '../src/parser';
import type { GraphData } from '../src/parser';

async function unzipPage(buffer: Buffer): Promise<string> {
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
    // expected center in SVG-space = (1.5, 2.25); Y is flipped against page height.
    expect(node.pinX).toBeCloseTo(1.5, 6);
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
    // 10 flattened segments for Q + 1 fallback segment for A = 11
    expect(lineTos).toBeGreaterThanOrEqual(11);
  });
});
