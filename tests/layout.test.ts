import { describe, it, expect } from '@jest/globals';
import { parseMermaid } from '../src/parser';

// Mermaid 12 bundles ELK, and silently falls back to dagre for a layout name
// it doesn't know. This test asserts that asking for ELK really re-positions
// nodes compared to dagre for the same source, i.e. that no fallback happened.
//
// We use a graph with enough nodes that any hierarchical layout (dagre) and
// orthogonal layered layout (ELK) will disagree on at least one coordinate.
const SOURCE = `
graph TD
  A[Start] --> B[Step 1]
  A --> C[Step 2]
  B --> D[Merge]
  C --> D
  D --> E[End]
`;

function fingerprint(nodes: { id: string; x: number; y: number }[]) {
    return nodes
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((n) => `${n.id}:${Math.round(n.x)},${Math.round(n.y)}`)
        .join('|');
}

// A minimal diagram whose frontmatter requests ELK. parseMermaid is called
// without an explicit config, so the layout must come from the frontmatter.
const FRONTMATTER_ELK = `---
config:
  layout: elk
---
graph TD
  A[Start] --> B[Step 1]
  B --> C[End]
`;

describe('layout engine selection', () => {
    it(
        'reads layout from YAML frontmatter when no config is passed',
        async () => {
            const graph = await parseMermaid(FRONTMATTER_ELK);
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect(graph.edges.length).toBeGreaterThan(0);
            // The tool's default is dagre, so a layout that differs from the
            // same diagram without frontmatter proves it was honoured.
            const body = FRONTMATTER_ELK.replace(/^---[\s\S]*?---\n/, '');
            const dagre = await parseMermaid(body);
            expect(fingerprint(graph.nodes)).not.toBe(fingerprint(dagre.nodes));
        },
        60000,
    );

    it(
        'produces distinct coordinates for dagre vs elk',
        async () => {
            const dagre = await parseMermaid(SOURCE, { layout: 'dagre' });
            const elk = await parseMermaid(SOURCE, { layout: 'elk' });

            expect(dagre.nodes.length).toBeGreaterThan(0);
            expect(elk.nodes.length).toBe(dagre.nodes.length);

            const dagreFp = fingerprint(dagre.nodes);
            const elkFp = fingerprint(elk.nodes);

            // A silent fallback to dagre would make the fingerprints match.
            expect(elkFp).not.toBe(dagreFp);
        },
        60000,
    );

    it(
        'keeps the classic look and dagre layout by default, whatever Mermaid defaults to',
        async () => {
            // Mermaid 12 defaults to ELK + the "neo" look, whose gradient
            // strokes and dash-array marker offsets don't convert. Edges must
            // stay glued, solid and plainly coloured without any config.
            const graph = await parseMermaid(SOURCE);
            expect(fingerprint(graph.nodes)).toBe(fingerprint((await parseMermaid(SOURCE, { layout: 'dagre' })).nodes));
            for (const e of graph.edges) {
                expect(e.startId).toBeTruthy();
                expect(e.endId).toBeTruthy();
                expect(parseFloat(e.style?.strokeDasharray || '0')).toBe(0);
                expect(e.style?.stroke).toMatch(/^rgb/);
            }
            for (const n of graph.nodes) {
                expect(n.id).toMatch(/^[A-E]$/);
                expect(n.style?.stroke).toMatch(/^rgb/);
            }
        },
        60000,
    );
});
