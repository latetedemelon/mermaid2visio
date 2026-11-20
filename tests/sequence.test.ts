import { describe, it, expect } from '@jest/globals';
import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';
import { validateVsdx } from '../src/validate';
import { parseColor } from '../src/core/color';
import { unzipPage } from './helpers';
import fs from 'fs';
import path from 'path';

const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'mermaid', name), 'utf8');

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

    it('draws every kind of participant, top and bottom, as one named shape', async () => {
        const g = await parseMermaid(fixture('sequence-participants.mmd'));
        const actors = g.nodes.filter(n => n.id.startsWith('seq-actor'));
        const names = ['Plain', 'Person', 'Boundary', 'Control', 'Entity', 'Store', 'Items', 'Jobs', 'Service'];
        for (const name of names) expect(actors.filter(a => a.text === name).length).toBe(2);
        expect(actors.length).toBe(names.length * 2);
        // Boxes stay boxes; stick figures and symbols keep their drawn outline.
        const kind = Object.fromEntries(actors.map(a => [a.text, a.type]));
        expect(kind.Plain).toBe('rectangle');
        for (const name of ['Person', 'Boundary', 'Control', 'Entity', 'Store', 'Jobs']) expect(kind[name]).toBe('path');
        // A stick figure's name sits below the figure.
        const person = actors.find(a => a.text === 'Person')!;
        expect(person.textY!).toBeGreaterThan(person.y + person.height / 2);
        // Names are legible: dark text, not the light colour of the box.
        for (const a of actors) {
            const c = parseColor(a.style!.color)!;
            const lum = parseInt(c.hex.slice(1, 3), 16) + parseInt(c.hex.slice(3, 5), 16) + parseInt(c.hex.slice(5, 7), 16);
            expect(lum).toBeLessThan(300);
        }
    }, 60000);

    it('draws frames as one grouped shape with all their labels', async () => {
        const g = await parseMermaid(fixture('sequence-participants.mmd'));
        const frames = g.nodes.filter(n => n.id.startsWith('seq-frame'));
        expect(frames.length).toBe(3);
        const texts = frames.map(f => f.children!.map(c => c.text));
        expect(texts).toEqual(expect.arrayContaining([
            expect.arrayContaining(['par', '[first]', '[second]']),
            expect.arrayContaining(['critical', '[check]', '[fail]']),
            expect.arrayContaining(['break', '[stop]']),
        ]));
        // The outline includes the separator between sections.
        const par = frames.find(f => f.children!.some(c => c.text === 'par'))!;
        expect(par.paths!.length).toBeGreaterThanOrEqual(5);
    }, 60000);

    it('draws autonumber badges as numbered circles at the start of each message', async () => {
        const g = await parseMermaid(fixture('sequence.mmd'));
        const badges = g.nodes.filter(n => n.id.startsWith('seq-number'));
        expect(badges.map(b => b.text)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
        for (const b of badges) {
            expect(b.type).toBe('circle');
            expect(b.width).toBeCloseTo(24, 0);
            expect(parseColor(b.style!.color)!.hex).toBe('#ffffff');
        }
        // The numbers are not also left behind as loose text.
        expect(g.labels.filter(l => /^\d+$/.test(l.text))).toEqual([]);
    }, 60000);

    it('keeps backgrounds behind the participants they enclose', async () => {
        const g = await parseMermaid(fixture('sequence-participants.mmd'));
        const order = g.nodes.map(n => n.id);
        const box = g.nodes.find(n => parseColor(n.style?.fill)?.hex === '#00ffff')!;
        const service = g.nodes.find(n => n.text === 'Service')!;
        expect(order.indexOf(box.id)).toBeLessThan(order.indexOf(service.id));
        expect(g.labels.map(l => l.text)).toContain('Backend');
        const bytes = await new VsdxGenerator().generate(g);
        expect((await validateVsdx(bytes)).errors).toEqual([]);
        expect(await unzipPage(bytes)).toContain('<Text>Boundary</Text>');
    }, 60000);
});
