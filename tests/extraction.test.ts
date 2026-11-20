import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseMermaid } from '../src/parser';
import { pathBounds } from '../src/core/normalize';
import { VsdxGenerator } from '../src/vsdx';
import { validateVsdx } from '../src/validate';
import { unzipPage } from './helpers';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'mermaid', name), 'utf8');
const edgeKey = (e: { startId?: string; endId?: string }) => `${e.startId}->${e.endId}`;

// Each case here is a defect the DOM-only extractor had. Meaning (which node,
// which endpoints, what arrowhead, what shape) now comes from Mermaid's
// parsed model; these tests pin that.
describe('flowchart extraction', () => {
    it('reads edge endpoints for ids containing underscores', async () => {
        // "L_api_user_db_0" was split greedily into api_user -> db.
        const g = await parseMermaid('flowchart TD\n  api --> user_db\n  user_db --> audit_log_v2\n  a_b --> c_d_e');
        expect(g.edges.map(edgeKey).sort()).toEqual(['a_b->c_d_e', 'api->user_db', 'user_db->audit_log_v2']);
        const ids = new Set(g.nodes.map(n => n.id));
        for (const e of g.edges) {
            expect(ids.has(e.startId!)).toBe(true);
            expect(ids.has(e.endId!)).toBe(true);
        }
    }, 60000);

    it('keeps endpoints for edges given their own id', async () => {
        const g = await parseMermaid('flowchart TD\n  A e1@--> B\n  B e2@--> C');
        expect(g.edges.map(edgeKey).sort()).toEqual(['A->B', 'B->C']);
    }, 60000);

    it('does not draw invisible links', async () => {
        const g = await parseMermaid('flowchart TD\n  A --> B\n  B ~~~ C\n  C --> D');
        expect(g.edges.map(edgeKey).sort()).toEqual(['A->B', 'C->D']);
        expect(g.nodes.length).toBe(4);
    }, 60000);

    it('extracts a self-loop as one edge without helper nodes', async () => {
        const g = await parseMermaid('flowchart TD\n  A[Retry] --> A\n  A --> B');
        expect(g.nodes.map(n => n.id).sort()).toEqual(['A', 'B']);
        expect(g.edges.map(edgeKey).sort()).toEqual(['A->A', 'A->B']);
    }, 60000);

    it('reports what is at each end of an edge', async () => {
        const g = await parseMermaid(fixture('flowchart.mmd'));
        const kinds = Object.fromEntries(g.edges.map(e => [edgeKey(e), [e.arrowStartKind, e.arrowEndKind]]));
        expect(kinds['start->check']).toEqual(['none', 'arrow_point']);
        expect(kinds['fail->done']).toEqual(['none', 'arrow_cross']);
        expect(kinds['worker->start']).toEqual(['none', 'arrow_circle']);
        expect(kinds['api->check']).toEqual(['arrow_point', 'arrow_point']);
        const both = g.edges.find(e => edgeKey(e) === 'api->check')!;
        expect(both.arrowStart).toBe(true);
        expect(both.arrowEnd).toBe(true);
    }, 60000);

    it('has no arrowhead on a plain link', async () => {
        const g = await parseMermaid('flowchart TD\n  A --- B');
        expect(g.edges[0].arrowStart).toBe(false);
        expect(g.edges[0].arrowEnd).toBe(false);
    }, 60000);

    it('distinguishes dotted from solid and thick lines', async () => {
        const g = await parseMermaid(fixture('flowchart.mmd'));
        const pattern = Object.fromEntries(g.edges.map(e => [edgeKey(e), e.pattern]));
        expect(pattern['check->fail']).toBe('dotted');
        expect(pattern['start->check']).toBe('solid');
        expect(pattern['user_db->done']).toBe('solid');
        const thick = g.edges.find(e => edgeKey(e) === 'user_db->done')!;
        const normal = g.edges.find(e => edgeKey(e) === 'start->check')!;
        expect(parseFloat(thick.style!.strokeWidth!)).toBeGreaterThan(parseFloat(normal.style!.strokeWidth!));
    }, 60000);

    it('names each shape from the model instead of guessing from its outline', async () => {
        const g = await parseMermaid([
            'flowchart TD',
            '  r[Rect] --> ro(Rounded)',
            '  ro --> st([Stadium])',
            '  st --> d{Diamond}',
            '  d --> cy[(Cylinder)]',
            '  cy --> su[[Subroutine]]',
            '  su --> ci((Circle))',
            '  ci --> lr[/Lean right/]',
            '  lr --> ll[\\Lean left\\]',
            '  ll --> hx{{Hexagon}}',
            '  hx --> tr[/Trapezoid\\]',
        ].join('\n'));
        const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
        expect(byId.r.type).toBe('rectangle');
        expect(byId.ro.type).toBe('rectangle');
        expect(byId.ro.rounding).toBeGreaterThan(0);
        expect(byId.st.type).toBe('stadium');
        expect(byId.d.type).toBe('diamond');
        expect(byId.cy.type).toBe('cylinder');
        expect(byId.su.type).toBe('subroutine');
        expect(byId.ci.type).toBe('circle');
        // Parallelograms were drawn as diamonds, hexagons as subroutines.
        expect(byId.lr.type).toBe('parallelogram');
        expect(byId.ll.type).toBe('parallelogram');
        expect(byId.hx.type).not.toBe('subroutine');
        expect(byId.tr.type).not.toBe('diamond');
        // Mermaid's own shape name is carried through for later use.
        expect(byId.lr.shape).toBe('lean_right');
        expect(byId.hx.shape).toBe('hexagon');
        expect(byId.tr.shape).toBe('trapezoid');
        // Every outline has a real border colour.
        for (const n of g.nodes) expect(n.style?.stroke).toMatch(/^rgb/);
    }, 60000);

    it('attaches each label to its own edge and records where it sits', async () => {
        const g = await parseMermaid('flowchart TD\n  A -->|first| B\n  A --> C\n  C -->|third| B');
        const text = Object.fromEntries(g.edges.map(e => [edgeKey(e), e.text]));
        expect(text).toEqual({ 'A->B': 'first', 'A->C': undefined, 'C->B': 'third' });
        expect(g.labels).toEqual([]);
        for (const e of g.edges.filter(x => x.text)) {
            // The label box lies within the diagram, near its edge.
            expect(e.labelWidth).toBeGreaterThan(5);
            expect(e.labelHeight).toBeGreaterThan(5);
            expect(e.labelX).toBeGreaterThanOrEqual(0);
            expect(e.labelX! + e.labelWidth!).toBeLessThanOrEqual(g.width + 1);
            const b = pathBounds(e.d)!;
            const cx = e.labelX! + e.labelWidth! / 2, cy = e.labelY! + e.labelHeight! / 2;
            expect(cx).toBeGreaterThan(b.minX - 40);
            expect(cx).toBeLessThan(b.maxX + 40);
            expect(cy).toBeGreaterThan(b.minY - 5);
            expect(cy).toBeLessThan(b.maxY + 5);
        }
    }, 60000);

    it('records which subgraph contains each node and subgraph', async () => {
        const g = await parseMermaid('flowchart TD\n  subgraph outer [Outer]\n    subgraph inner [Inner]\n      A\n    end\n    B\n  end\n  C --> A');
        const parent = Object.fromEntries(g.nodes.map(n => [n.id, n.parentId]));
        expect(parent).toEqual({ A: 'inner', B: 'outer', C: undefined });
        expect(Object.fromEntries(g.clusters.map(c => [c.id, c.parentId]))).toEqual({ inner: 'outer', outer: undefined });
    }, 60000);

    it('keeps every edge and its label on the page', async () => {
        // A self-loop bulges outside its node; bounds used to ignore edges.
        const g = await parseMermaid('flowchart LR\n  A[Only node] -->|loop| A');
        const b = pathBounds(g.edges[0].d)!;
        expect(b.minX).toBeGreaterThanOrEqual(-0.5);
        expect(b.minY).toBeGreaterThanOrEqual(-0.5);
        expect(b.maxX).toBeLessThanOrEqual(g.width + 0.5);
        expect(b.maxY).toBeLessThanOrEqual(g.height + 0.5);
    }, 60000);
});

describe('class, state and ER extraction', () => {
    it('attaches class relationships to their classes with UML end types', async () => {
        const g = await parseMermaid(fixture('class.mmd'));
        const ids = new Set(g.nodes.map(n => n.id));
        expect(ids).toEqual(new Set(['Animal', 'Dog', 'Owner', 'Walker', 'Address', 'Vet']));
        for (const e of g.edges) {
            expect(ids.has(e.startId!)).toBe(true);
            expect(ids.has(e.endId!)).toBe(true);
        }
        const kinds = Object.fromEntries(g.edges.map(e => [edgeKey(e), [e.arrowStartKind, e.arrowEndKind, e.pattern]]));
        expect(kinds['Animal->Dog']).toEqual(['extension', 'none', 'solid']);
        expect(kinds['Owner->Dog']).toEqual(['aggregation', 'none', 'solid']);
        expect(kinds['Owner->Address']).toEqual(['composition', 'none', 'solid']);
        expect(kinds['Dog->Walker']).toEqual(['none', 'extension', 'dashed']);
    }, 60000);

    it('gives ER relationships their cardinality at each end', async () => {
        const g = await parseMermaid(fixture('er.mmd'));
        const ids = new Set(g.nodes.map(n => n.id));
        for (const e of g.edges) {
            expect(ids.has(e.startId!)).toBe(true);
            expect(ids.has(e.endId!)).toBe(true);
        }
        const places = g.edges.find(e => e.text === 'places')!;
        expect([places.arrowStartKind, places.arrowEndKind]).toEqual(['only_one', 'zero_or_more']);
        expect(g.edges.find(e => e.text === 'ships to')!.pattern).toBe('dashed');
    }, 60000);

    it('recognises state pseudo-states by shape', async () => {
        const g = await parseMermaid(fixture('state.mmd'));
        const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
        expect(byId.root_start.type).toBe('circle');
        expect(byId.root_end.type).toBe('circle');
        expect(byId.check.type).toBe('diamond');
        expect(byId.Idle.type).toBe('rectangle');
        expect(g.edges.find(e => e.startId === 'Idle' && e.endId === 'Running')?.text).toBe('start');
    }, 60000);
});

describe('sequence extraction', () => {
    it('puts arrowheads only where the message has them', async () => {
        const g = await parseMermaid([
            'sequenceDiagram',
            '  autonumber',
            '  A->B: plain line',
            '  A->>B: arrow',
            '  B-->>A: dashed arrow',
            '  A-xB: cross',
            '  A<<->>B: both ways',
        ].join('\n'));
        const msg = Object.fromEntries(g.edges.filter(e => e.text).map(e => [e.text!, e]));
        expect([msg['plain line'].arrowStart, msg['plain line'].arrowEnd]).toEqual([false, false]);
        expect([msg['arrow'].arrowStart, msg['arrow'].arrowEnd]).toEqual([false, true]);
        expect(msg['dashed arrow'].arrowEnd).toBe(true);
        expect(msg['cross'].arrowEndKind).toBe('arrow_cross');
        expect([msg['both ways'].arrowStart, msg['both ways'].arrowEnd]).toEqual([true, true]);
    }, 60000);
});

// Shapes and connectors are read from different parts of the SVG. They must
// end up in one coordinate system: every glued edge has to start and end on
// (or within a couple of pixels of) the outline of the shape it joins.
describe('edges meet the shapes they connect', () => {
    const onBoundary = (p: { x: number; y: number }, n: { x: number; y: number; width: number; height: number }, slack = 3) => {
        const inside = p.x >= n.x - slack && p.x <= n.x + n.width + slack && p.y >= n.y - slack && p.y <= n.y + n.height + slack;
        const deep = p.x > n.x + slack + 6 && p.x < n.x + n.width - slack - 6 && p.y > n.y + slack + 6 && p.y < n.y + n.height - slack - 6;
        return inside && !deep;
    };
    const ends = (d: string) => {
        const nums = (d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(parseFloat);
        return { start: { x: nums[0], y: nums[1] }, end: { x: nums[nums.length - 2], y: nums[nums.length - 1] } };
    };
    const check = async (src: string, minEdges: number) => {
        const g = await parseMermaid(src);
        const byId = new Map<string, any>([...g.nodes, ...g.clusters].map(n => [n.id, n]));
        let checked = 0;
        for (const e of g.edges) {
            const a = byId.get(e.startId!), b = byId.get(e.endId!);
            // Only rectangular outlines: for a diamond or circle the box
            // corners are legitimately far from the outline.
            if (!a || !b || a.type !== 'rectangle' || b.type !== 'rectangle') continue;
            const { start, end } = ends(e.d);
            expect(onBoundary(start, a)).toBe(true);
            // The end stops short of the shape by the arrowhead's length.
            expect(onBoundary(end, b, 8)).toBe(true);
            checked++;
        }
        expect(checked).toBeGreaterThanOrEqual(minEdges);
    };

    it('in an ordinary flowchart', async () => {
        await check('flowchart TD\n  A[One] --> B[Two]\n  B --> C[Three]\n  A --> C', 3);
    }, 60000);

    // A diagram wider than the browser window is scaled down to fit. That
    // must not change where anything is.
    it('in a diagram much wider than the browser window', async () => {
        const nodes = Array.from({ length: 24 }, (_, i) => `N${i}[Node number ${i}]`);
        await check('flowchart LR\n  ' + nodes.join(' --> '), 20);
    }, 60000);

    // Mermaid puts these edges in a nested group with its own offset.
    it('inside a subgraph that has connections to the outside', async () => {
        await check('flowchart TD\n  subgraph S [Group]\n    A[One] --> B[Two]\n  end\n  X[Out] --> S\n  B --> Y[After]', 2);
    }, 60000);

    it('inside a composite state', async () => {
        const g = await parseMermaid(fixture('state.mmd'));
        const byId = new Map(g.nodes.map(n => [n.id, n]));
        const heat = g.edges.find(e => e.text === 'heat')!;
        const { start, end } = ends(heat.d);
        expect(onBoundary(start, byId.get('Warm')!)).toBe(true);
        expect(onBoundary(end, byId.get('Hot')!, 8)).toBe(true);
        // The composite state itself is a container holding its sub-states.
        expect(g.clusters.map(c => c.id)).toContain('Running');
        expect(byId.get('Warm')!.parentId).toBe('Running');
    }, 60000);
});

describe('shapes without parametric geometry', () => {
    it('carry the outline Mermaid drew and where it put the text', async () => {
        const g = await parseMermaid(fixture('flowchart-shapes.mmd'));
        const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
        for (const id of ['a', 'e', 'f', 'g', 'h', 'k', 'l', 'm', 'n']) {
            const n = byId[id];
            expect(n.type).toBe('path');
            expect(n.paths!.length).toBeGreaterThan(0);
            // Outline points lie within the node's box.
            for (const piece of n.paths!) for (const sub of piece.subpaths) for (const [x, y] of sub) {
                expect(x).toBeGreaterThanOrEqual(-1);
                expect(y).toBeGreaterThanOrEqual(-1);
                expect(x).toBeLessThanOrEqual(n.width + 1);
                expect(y).toBeLessThanOrEqual(n.height + 1);
            }
        }
        // A fill path and its identical stroke path are one piece.
        expect(byId.g.paths!.length).toBe(1);
        expect(byId.g.paths![0]).toMatchObject({ fill: true, line: true });
        // A triangle's label sits in its lower half.
        const tri = byId.g;
        expect(tri.textY! + tri.textHeight! / 2).toBeGreaterThan(tri.y + tri.height / 2);
        // Parametric shapes keep their family; every edge is still attached.
        expect(byId.b.type).toBe('hexagon');
        expect(byId.j.type).toBe('circle');
        expect(g.edges.every(e => byId[e.startId!] && byId[e.endId!])).toBe(true);
    }, 60000);

    it('are written as geometry that scales with the shape', async () => {
        const g = await parseMermaid('flowchart TD\n  t@{ shape: tri, label: "T" }');
        const xml = await unzipPage(await new VsdxGenerator().generate(g));
        expect(xml).toMatch(/<Row T="LineTo" IX="\d+"><Cell N="X" V="[^"]+" F="Width\*[\d.]+"\/><Cell N="Y" V="[^"]+" F="Height\*[\d.]+"\/>/);
        expect(xml).toMatch(/<Cell N="TxtPinY" V="[^"]+" F="Height\*[\d.]+"\/>/);
        expect((await validateVsdx(await new VsdxGenerator().generate(g))).errors).toEqual([]);
    }, 60000);
});

describe('nodes with several texts', () => {
    it('keep every text in place and become a group', async () => {
        const g = await parseMermaid(fixture('class.mmd'));
        const animal = g.nodes.find(n => n.id === 'Animal')!;
        expect(animal.children!.map(c => c.text)).toEqual(['Animal', '+String name', '#int age', '+eat() : void', '+sleep()']);
        // Each text lies inside the class box, in reading order.
        const ys = animal.children!.map(c => c.y);
        expect([...ys].sort((a, b) => a - b)).toEqual(ys);
        for (const c of animal.children!) {
            expect(c.x).toBeGreaterThanOrEqual(animal.x);
            expect(c.y + c.height).toBeLessThanOrEqual(animal.y + animal.height + 1);
        }
        // The outline includes the compartment dividers.
        expect(animal.paths!.length).toBeGreaterThan(1);
        // Multiplicities at the relationship ends are kept.
        expect(g.labels.map(l => l.text)).toEqual(expect.arrayContaining(['1', '*']));

        const bytes = await new VsdxGenerator().generate(g);
        expect((await validateVsdx(bytes)).errors).toEqual([]);
        const xml = await unzipPage(bytes);
        const group = /<Shape ID="1" Type="Group">([\s\S]*?)<\/Shapes><\/Shape>/.exec(xml)![1];
        expect(group).toContain('<Text>+String name</Text>');
        // Sub-shapes are placed as fractions of the group, so they follow it.
        expect(group).toMatch(/<Cell N="PinX" V="[^"]+" F="Sheet\.1!Width\*[\d.]+"\/>/);
        // Ids stay unique across top-level shapes and sub-shapes.
        const ids = [...xml.matchAll(/<Shape ID="(\d+)"/g)].map(m => m[1]);
        expect(new Set(ids).size).toBe(ids.length);
    }, 60000);
});

describe('chart-like diagrams become editable drawings', () => {
    it('draws each pie slice as its own filled shape, with the legend and title as text', async () => {
        const g = await parseMermaid(fixture('pie.mmd'));
        // Slices (and legend swatches) are filled; three series, three colours.
        const slices = g.nodes.filter(n => n.type === 'path' && n.paths![0].fill && n.height > 30);
        expect(slices.length).toBeGreaterThanOrEqual(3);
        expect(new Set(slices.map(s => s.style!.fill)).size).toBeGreaterThanOrEqual(3);
        expect(g.labels.map(l => l.text)).toEqual(expect.arrayContaining(['Pets adopted', '79%']));
        expect(g.edges).toEqual([]);
    }, 60000);

    it('ignores what lies outside the visible diagram', async () => {
        // The "today" marker of a Gantt chart about January sits far off to
        // the right for most of the year.
        const g = await parseMermaid(fixture('gantt.mmd'));
        expect(g.width).toBeLessThan(1500);
    }, 60000);

    it('keeps rotated axis titles rotated', async () => {
        const g = await parseMermaid(fixture('xychart.mmd'));
        const title = g.labels.find(l => l.text === 'Revenue')!;
        expect(Math.abs(title.angle!)).toBeCloseTo(90, 0);
        const xml = await unzipPage(await new VsdxGenerator().generate(g));
        expect(xml).toMatch(/<Cell N="Angle" V="-?1\.5707\d*"\/>/);
    }, 60000);
});

describe('C4, architecture and block diagrams have attached connectors', () => {
    const attached = async (file: string) => {
        const g = await parseMermaid(fixture(file));
        const bytes = await new VsdxGenerator().generate(g);
        expect((await validateVsdx(bytes)).errors).toEqual([]);
        return { g, xml: await unzipPage(bytes) };
    };
    const pairs = (g: Awaited<ReturnType<typeof parseMermaid>>) => g.edges.map(e => `${e.startId}->${e.endId}`).sort();

    it('C4: each element is one shape, each relationship glued and labelled', async () => {
        const { g, xml } = await attached('c4.mmd');
        expect(pairs(g)).toEqual(['customer->shop', 'shop->pay']);
        expect(g.edges.map(e => e.text).sort()).toEqual(['Charges via', 'Uses']);
        const customer = g.nodes.find(n => n.id === 'customer')!;
        // A person is a head and a body: a group whose parts keep their colour,
        // with the name, type and description as its texts.
        expect(customer.type).toBe('group');
        expect(customer.parts!.length).toBeGreaterThanOrEqual(2);
        expect(customer.children!.map(c => c.text)).toEqual(expect.arrayContaining(['Customer', '[Person]', 'Buys things']));
        expect((xml.match(/<Connect /g) || []).length).toBe(4);
        // The relationship labels are not also left behind as loose text.
        expect(g.labels.map(l => l.text)).not.toContain('Uses');
    }, 60000);

    it('architecture: services keep their icons, edges are glued, groups are containers', async () => {
        const { g, xml } = await attached('architecture.mmd');
        expect(pairs(g)).toEqual(['db->server', 'disk->server']);
        const db = g.nodes.find(n => n.id === 'db')!;
        expect(db.type).toBe('group');
        expect(db.children!.map(c => c.text)).toEqual(['Database']);
        // Icon pieces are separately coloured: blue tile, white glyph.
        expect(new Set(db.parts!.map(p => p.style!.fill)).size).toBeGreaterThan(1);
        expect(g.clusters.map(c => c.id)).toEqual(['api']);
        // The group is a container listing its members (the three services,
        // and its own icon and label drawn inside it).
        expect(xml).toMatch(/<Row N="msvStructureType"><Cell N="Value" V="Container"/);
        expect(xml).toMatch(/DEPENDSON\(1,Sheet\.\d+!SheetRef\(\),Sheet\.\d+!SheetRef\(\),Sheet\.\d+!SheetRef\(\)/);
    }, 60000);

    it('block: blocks and arrows come from the model, with heads only where drawn', async () => {
        const { g } = await attached('block.mmd');
        expect(g.nodes.map(n => [n.id, n.text])).toEqual([['a', 'Input'], ['b', 'Process'], ['c', 'Output'], ['d', 'Store']]);
        expect(pairs(g)).toEqual(['a->b', 'b->c', 'b->d']);
        // The model calls the plain start "arrow_open"; no head is drawn there.
        for (const e of g.edges) expect([e.arrowStart, e.arrowEnd]).toEqual([false, true]);
    }, 60000);
});

describe('pathBounds', () => {
    it('covers every coordinate of absolute path commands', () => {
        expect(pathBounds('M 10 20 L 30 5 H 50 V -4 C 0 0 60 60 40 40 Z')).toEqual({ minX: 0, minY: -4, maxX: 60, maxY: 60 });
        expect(pathBounds('M 0 0 A 5 5 0 0 1 70 10')).toEqual({ minX: 0, minY: 0, maxX: 70, maxY: 10 });
        expect(pathBounds('')).toBeNull();
    });
});
