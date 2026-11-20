import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseMermaid } from '../src/parser';
import { pathBounds } from '../src/core/normalize';

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

describe('pathBounds', () => {
    it('covers every coordinate of absolute path commands', () => {
        expect(pathBounds('M 10 20 L 30 5 H 50 V -4 C 0 0 60 60 40 40 Z')).toEqual({ minX: 0, minY: -4, maxX: 60, maxY: 60 });
        expect(pathBounds('M 0 0 A 5 5 0 0 1 70 10')).toEqual({ minX: 0, minY: 0, maxX: 70, maxY: 10 });
        expect(pathBounds('')).toBeNull();
    });
});
