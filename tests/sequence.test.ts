import { describe, it, expect } from '@jest/globals';
import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';
import { validateVsdx } from '../src/validate';

// Sequence diagrams use a different SVG structure than flowcharts (actor
// boxes + lifelines + message lines). The parser has a dedicated extractor
// that maps them into the shared IR. These tests pin that mapping.

const SRC = `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>B: Hello Bob
    B-->>A: Hi Alice
    A-)B: async msg`;

describe('sequence diagram extraction', () => {
    it('extracts actor boxes as nodes with their labels', async () => {
        const g = await parseMermaid(SRC);
        // Mermaid draws each actor twice (top and bottom): 2 actors -> 4 boxes.
        expect(g.nodes.length).toBe(4);
        const texts = new Set(g.nodes.map(n => n.text));
        expect(texts.has('Alice')).toBe(true);
        expect(texts.has('Bob')).toBe(true);
    }, 60000);

    it('extracts messages as labelled edges and lifelines as edges', async () => {
        const g = await parseMermaid(SRC);
        const labels = g.edges.map(e => e.text).filter(Boolean);
        expect(labels).toEqual(expect.arrayContaining(['Hello Bob', 'Hi Alice', 'async msg']));
        // 3 messages + 2 lifelines.
        expect(g.edges.length).toBeGreaterThanOrEqual(5);
        // The dashed return message (-->>) must be dashed; at least one dashed edge.
        expect(g.edges.some(e => e.style?.strokeDasharray)).toBe(true);
    }, 60000);

    it('message edges are horizontal (begin.y ~= end.y)', async () => {
        const g = await parseMermaid(SRC);
        const messages = g.edges.filter(e => e.text);
        expect(messages.length).toBe(3);
        for (const m of messages) {
            // d is "M x1 y1 L x2 y2" (possibly translated). Pull all numbers.
            const nums = (m.d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
            expect(nums.length).toBeGreaterThanOrEqual(4);
            const [, y1, , y2] = nums;
            expect(Math.abs(y1 - y2)).toBeLessThan(1); // horizontal
        }
    }, 60000);

    it('extracts activation bars and notes as nodes', async () => {
        const src = `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>+B: Request
    Note right of B: thinking
    B-->>-A: Response
    Note over A,B: done`;
        const g = await parseMermaid(src);
        // 4 actor boxes + >=1 activation + 2 notes.
        const noteNodes = g.nodes.filter(n => n.text === 'thinking' || n.text === 'done');
        expect(noteNodes.length).toBe(2);
        // Activation bars are narrow, empty-text rectangles.
        const activations = g.nodes.filter(n => n.id.includes('activation'));
        expect(activations.length).toBeGreaterThanOrEqual(1);
        // Whole thing still validates.
        const buf = await new VsdxGenerator().generate(g, src);
        expect((await validateVsdx(buf)).ok).toBe(true);
    }, 60000);

    it('produces a structurally valid VSDX with no empty-output warning path', async () => {
        const g = await parseMermaid(SRC);
        const buf = await new VsdxGenerator().generate(g, SRC);
        const result = await validateVsdx(buf);
        if (!result.ok) throw new Error(`Validation failed:\n  - ${result.errors.join('\n  - ')}`);
        expect(result.ok).toBe(true);
    }, 60000);
});
