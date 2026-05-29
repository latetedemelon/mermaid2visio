import { describe, it, expect } from '@jest/globals';
import { parseMermaid, detectDiagramType } from '../src/parser';
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
