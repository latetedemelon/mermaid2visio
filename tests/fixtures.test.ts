import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';
import { unzipPage } from './helpers';

// Asserts structural invariants against the sample diagrams in examples/.
// Snapshots of raw coordinates would churn on every Mermaid release, so we
// assert shape over size: counts, required fields, and that the pipeline
// produces a non-empty VSDX with a Shapes section.
const fixtures = ['1_Metrological_Foundation.mmd', '2_Antigen_Library.mmd', '3_Product_Tiers.mmd', '4_QC_Decision_Tree.mmd', '5_Data_Architecture.mmd'];
const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(here, '..', 'examples');

describe('examples/ fixture pipeline', () => {
    for (const name of fixtures) {
        it(`parses and generates VSDX for ${name}`, async () => {
            const source = fs.readFileSync(path.join(examplesDir, name), 'utf-8');
            const graph = await parseMermaid(source);

            expect(graph.width).toBeGreaterThan(0);
            expect(graph.height).toBeGreaterThan(0);
            expect(graph.nodes.length).toBeGreaterThan(0);
            for (const n of graph.nodes) {
                expect(typeof n.id).toBe('string');
                expect(n.id.length).toBeGreaterThan(0);
                expect(n.width).toBeGreaterThan(0);
                expect(n.height).toBeGreaterThan(0);
            }
            for (const e of graph.edges) {
                expect(typeof e.d).toBe('string');
                expect(e.d.length).toBeGreaterThan(0);
            }

            const buffer = await new VsdxGenerator().generate(graph);
            expect(buffer.length).toBeGreaterThan(500); // non-trivial VSDX
            expect(buffer[0]).toBe(0x50); // 'P'
            expect(buffer[1]).toBe(0x4b); // 'K'

            const xml = await unzipPage(buffer);
            expect(xml).toContain('<Shapes>');
            // At least one shape per node.
            const shapeCount = (xml.match(/<Shape\b/g) || []).length;
            expect(shapeCount).toBeGreaterThanOrEqual(graph.nodes.length);
        }, 30000);
    }
});
