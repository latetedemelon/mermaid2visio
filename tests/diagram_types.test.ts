import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseMermaid, detectDiagramType } from '../src/parser';
import { DIAGRAM_KINDS, diagramKind, supportLevel } from '../src/core/detect';
import { VsdxGenerator } from '../src/vsdx';
import { validateVsdx } from '../src/validate';
import { unzipPage } from './helpers';

// Pins the support matrix so it can't silently regress and so the docs stay
// honest. Graph-like diagrams map to shapes and glued connectors; chart-like
// ones are drawn as static shapes and text. No type may produce a blank page
// or a file that fails structural validation.

describe('detectDiagramType', () => {
    it.each([
        ['flowchart TD\n A-->B', 'flowchart'],
        ['graph LR\n A-->B', 'graph'],
        ['sequenceDiagram\n A->>B: hi', 'sequenceDiagram'],
        ['stateDiagram-v2\n [*]-->S', 'stateDiagram-v2'],
        ['erDiagram\n A ||--o{ B : has', 'erDiagram'],
        ['---\ntitle: x\n---\nflowchart TD\n A-->B', 'flowchart'],
        ['%% a comment\n%% another\nclassDiagram\n A <|-- B', 'classDiagram'],
    ])('detects %s', (src, expected) => {
        expect(detectDiagramType(src)).toBe(expected);
    });
});

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'mermaid');
const fixtureFiles = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.mmd')).sort();

describe('diagram type registry', () => {
    it('classifies well-known keywords', () => {
        expect(supportLevel('flowchart')).toBe('full');
        expect(supportLevel('graph')).toBe('full');
        expect(supportLevel('flowchart-elk')).toBe('full');
        expect(diagramKind('stateDiagram-v2')?.kind).toBe('state');
        expect(diagramKind('classDiagram-v2')?.kind).toBe('class');
        expect(diagramKind('xychart-beta')?.kind).toBe('xychart');
        expect(diagramKind('C4Container')?.kind).toBe('c4');
        expect(diagramKind('notADiagram')).toBeUndefined();
        expect(supportLevel('notADiagram')).toBe('none');
    });

    // Every fixture is a diagram type Mermaid really renders, so each must be
    // known to the registry. A fixture for a new Mermaid type fails here
    // until the registry is taught about it.
    it.each(fixtureFiles)('knows the type of fixture %s', (file) => {
        const type = detectDiagramType(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
        expect(diagramKind(type)).toBeDefined();
    });

    it('has a fixture for every registered diagram kind', () => {
        const covered = new Set(fixtureFiles.map(f => diagramKind(detectDiagramType(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')))?.kind));
        expect(DIAGRAM_KINDS.map(k => k.kind).filter(k => !covered.has(k))).toEqual([]);
    });
});

// Words that must survive conversion for each fixture: a sample of the text
// a reader would look for in the Visio file.
const EXPECTED_TEXT: Record<string, string[]> = {
    'agentflow.mmd': ['Review Agent', 'Gather changes', 'Clean?'],
    'architecture.mmd': ['API', 'Database', 'Server', 'Storage'],
    'block.mmd': ['Input', 'Process', 'Output', 'Store'],
    'c4.mmd': ['Customer', 'Web shop', 'Payments', 'Uses'],
    'class.mmd': ['Animal', 'Dog', 'Owner', 'extends', '+String name', '+eat() : void', '«interface»'],
    'cynefin.mmd': ['Incident Response', 'Restart service'],
    'er.mmd': ['CUSTOMER', 'ORDER', 'places', 'customer_id', 'FK'],
    'eventmodeling.mmd': ['CartUI', 'AddItem', 'ItemAdded'],
    'flowchart.mmd': ['Start', 'Valid?', 'User DB', 'Services', 'yes'],
    'flowchart-shapes.mmd': ['Document', 'Cloud', 'Triangle', 'Lean left'],
    'gantt.mmd': ['Release plan', 'Design', 'Implement', 'Launch'],
    'gitgraph.mmd': ['develop', 'v1.0'],
    'ishikawa.mmd': ['Blurry', 'Photo', 'Shaky hands'],
    'journey.mmd': ['Working day', 'Make tea', 'Commute'],
    'kanban.mmd': ['To do', 'Write docs', 'Ship v1'],
    'mindmap.mmd': ['Product', 'Research', 'Backend', 'Launch'],
    'packet.mmd': ['Source Port', 'Sequence Number'],
    'pie.mmd': ['Pets adopted', 'Dogs'],
    'quadrant.mmd': ['Reach and engagement', 'Campaign A', 'Expand'],
    'radar.mmd': ['Skills', 'Speed', 'Model X'],
    'railroad.mmd': ['digit'],
    'requirement.mmd': ['login_req', 'auth_service', 'Users can sign in'],
    'sankey.mmd': ['Source A', 'Hub', 'Sink Y'],
    'sequence.mmd': ['Web', 'Database', 'Sign in', 'Shared cache'],
    'state.mmd': ['Idle', 'Warm', 'Failed', 'retry'],
    'swimlane.mmd': ['Customer', 'Warehouse', 'Pick items', 'Raise invoice'],
    'timeline.mmd': ['Company history', 'Founded', 'Series A'],
    'treemap.mmd': ['Engineering', 'Backend', 'Marketing'],
    'treeview.mmd': ['src', 'index.ts', 'README.md'],
    'usecase.mmd': ['Customer', 'Place order', 'Order system'],
    'venn.mmd': ['Desirable', 'Feasible', 'Ship it'],
    'wardley.mmd': ['Cup of Tea', 'Kettle', 'Power'],
    'xychart.mmd': ['Sales', 'Revenue', 'feb'],
};

// Every diagram type Mermaid can render must convert to a structurally valid
// package that is not blank, sits on its page, and carries its text across.
describe('every Mermaid diagram type converts to a non-blank, valid package', () => {
    it('has expectations for every fixture', () => {
        expect(fixtureFiles.filter(f => !EXPECTED_TEXT[f])).toEqual([]);
    });

    it.each(fixtureFiles)('%s', async (file) => {
        const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
        const graph = await parseMermaid(src);
        const bytes = await new VsdxGenerator().generate(graph, src);
        expect((await validateVsdx(bytes)).errors).toEqual([]);

        expect(graph.nodes.length + graph.clusters.length + graph.labels.length).toBeGreaterThan(0);

        // Everything lies on the page (content is normalised to start at 0,0).
        for (const item of [...graph.nodes, ...graph.clusters, ...graph.labels]) {
            expect(item.x).toBeGreaterThanOrEqual(-1);
            expect(item.y).toBeGreaterThanOrEqual(-1);
            expect(item.x + item.width).toBeLessThanOrEqual(graph.width + 1);
            expect(item.y + item.height).toBeLessThanOrEqual(graph.height + 1);
        }
        // A sane page: no stray element thousands of pixels away.
        expect(graph.width).toBeLessThan(5000);
        expect(graph.height).toBeLessThan(5000);

        const page = await unzipPage(bytes);
        const texts = [...page.matchAll(/<Text>([\s\S]*?)<\/Text>/g)].map(m => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')).join('\n');
        for (const expected of EXPECTED_TEXT[file] ?? []) expect(texts).toContain(expected);
    }, 60000);
});

describe('diagram type coverage (parse -> generate -> validate)', () => {
    // [source, label, expectShapes]
    const cases: Array<[string, string, boolean]> = [
        [`flowchart TD\n A[Start]-->B{Q}\n B-->|yes|C[OK]\n B-->|no|D[Stop]`, 'flowchart', true],
        [`classDiagram\n Animal <|-- Duck\n Animal : +int age\n class Duck{ +swim() }`, 'class', true],
        [`stateDiagram-v2\n [*] --> Still\n Still --> Moving\n Moving --> [*]`, 'state', true],
        [`erDiagram\n CUSTOMER ||--o{ ORDER : places\n ORDER ||--|{ LINE : contains`, 'er', true],
        [`sequenceDiagram\n Alice->>John: Hello\n John-->>Alice: Hi`, 'sequence', true],
        [`pie title Pets\n "Dogs" : 386\n "Cats" : 85`, 'pie', true],
    ];

    it.each(cases)('%s — produces a structurally valid VSDX', async (src, label, expectShapes) => {
        const graph = await parseMermaid(src);
        const buf = await new VsdxGenerator().generate(graph, src);
        const result = await validateVsdx(buf);
        if (!result.ok) {
            throw new Error(`Validation failed for ${label}:\n  - ${result.errors.join('\n  - ')}`);
        }
        expect(result.ok).toBe(true);

        const total = graph.nodes.length + graph.edges.length + graph.clusters.length + graph.labels.length;
        if (expectShapes) {
            expect(total).toBeGreaterThan(0);
        } else {
            expect(total).toBe(0);
        }
    }, 60000);
});
