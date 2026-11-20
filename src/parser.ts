// Node entry point for "Mermaid source -> GraphData". A thin wrapper over
// MermaidRenderer (src/render/renderer.ts), kept so the CLI, GUI, MCP server
// and tests have one stable import surface.

import { MermaidRenderer } from './render/renderer.js';
import type { GraphData, MermaidConfig } from './core/types.js';

export { translatePathD } from './core/normalize.js';
export { detectDiagramType, formatMermaidError } from './core/detect.js';
export { explainLaunchFailure, launchBrowser, MermaidRenderer, RendererBusyError } from './render/renderer.js';
export type {
    GraphNode, GraphEdge, GraphCluster, GraphLabel, GraphData, MermaidConfig,
} from './core/types.js';

// Renders one diagram. Pass a long-lived `renderer` to reuse its browser
// across calls (the GUI and MCP server do); otherwise a browser is started
// for this call and closed afterwards.
export async function parseMermaid(
    definition: string,
    config?: MermaidConfig,
    renderer?: MermaidRenderer,
): Promise<GraphData> {
    if (renderer) return (await renderer.render(definition, config)).graph;
    const oneShot = new MermaidRenderer();
    try {
        return (await oneShot.render(definition, config)).graph;
    } finally {
        await oneShot.close();
    }
}
