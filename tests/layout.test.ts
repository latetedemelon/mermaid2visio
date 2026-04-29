import { describe, it, expect } from '@jest/globals';
import { parseMermaid } from '../src/parser';

// Guards against the silent ELK regression: when mermaid.registerLayoutLoaders
// is not called for 'elk', mermaid quietly falls back to dagre and produces
// exactly the same coordinates as if the user picked dagre. This test asserts
// that ELK actually re-positions nodes compared to dagre for the same source.
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

// A minimal diagram whose frontmatter requests ELK.  parseMermaid is
// intentionally called without an explicit config so the test exercises the
// code path where the frontmatter must be read to decide whether to register
// the ELK adapter.  Without the fix, Mermaid's internal frontmatter parser
// picks up `layout: elk` at render time and throws because the adapter was
// never registered.
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
            // Should not throw; before the fix this raised "No layout engine for elk".
            const graph = await parseMermaid(FRONTMATTER_ELK);
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect(graph.edges.length).toBeGreaterThan(0);
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

            // If the ELK loader silently fails, mermaid falls back to dagre
            // and the fingerprints match exactly. That is the regression we
            // are guarding against.
            expect(elkFp).not.toBe(dagreFp);
        },
        60000,
    );
});
