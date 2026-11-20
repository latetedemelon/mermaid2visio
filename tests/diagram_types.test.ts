import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseMermaid, detectDiagramType } from '../src/parser';
import { DIAGRAM_KINDS, diagramKind, supportLevel } from '../src/core/detect';
import { VsdxGenerator } from '../src/vsdx';
import { validateVsdx } from '../src/validate';

// Pins the *actual* support matrix so it can't silently regress and so the
// docs stay honest. The extractor is flowchart-oriented; other types either
// partially map (class/state/ER) or produce a blank-but-valid package
// (sequence/pie/gantt). Every type must at least yield a structurally valid
// VSDX — we never want a diagram type to produce a file Visio rejects.

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

// Every diagram type Mermaid can render must convert without throwing and
// produce a structurally valid package, whether or not shapes are extracted.
describe('every Mermaid diagram type converts to a valid package', () => {
    it.each(fixtureFiles)('%s', async (file) => {
        const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
        const warn = console.warn;
        console.warn = () => {};
        try {
            const graph = await parseMermaid(src);
            const report = await validateVsdx(await new VsdxGenerator().generate(graph, src));
            expect(report.errors).toEqual([]);
        } finally {
            console.warn = warn;
        }
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
        [`pie title Pets\n "Dogs" : 386\n "Cats" : 85`, 'pie', false],
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
            // Documents the known limitation: these types extract no geometry.
            // If a future Mermaid/extractor change starts supporting them, this
            // line will fail and prompt updating the support matrix + docs.
            expect(total).toBe(0);
        }
    }, 60000);
});
