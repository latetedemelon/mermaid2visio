import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';

// Puppeteer cold-starts the headless browser on the first parse, which can
// exceed Jest's 5s default on CI. Give each case a generous ceiling.
const TEST_TIMEOUT_MS = 30000;

describe('Mermaid to Visio Conversion', () => {
  it('should generate a valid VSDX buffer from a simple graph', async () => {
    const mermaidCode = `
      graph TD
        A[Start] --> B{Decision}
        B -- Yes --> C[End]
    `;

    const graph = await parseMermaid(mermaidCode);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    const generator = new VsdxGenerator();
    const buffer = await generator.generate(graph);

    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.length).toBeGreaterThan(0);

    // Check for PK zip header (VSDX is a zip file)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  }, TEST_TIMEOUT_MS);

  it('should handle subgraphs (containers)', async () => {
    const mermaidCode = `
      graph TD
        subgraph Container
          A[Start] --> B[End]
        end
    `;

    const graph = await parseMermaid(mermaidCode);
    expect(graph.clusters).toBeDefined();
    expect(graph.clusters!.length).toBe(1);
    expect(graph.clusters![0].id).toBeDefined();

    const generator = new VsdxGenerator();
    const buffer = await generator.generate(graph);

    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);
});
