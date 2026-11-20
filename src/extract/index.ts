// The in-page pipeline: initialise Mermaid, render, extract geometry and
// normalise it. Runs inside a browser page — the Node renderer injects the
// bundled copy of this module (dist/extractor.iife.js, built by
// scripts/build-extractor.mjs) and the client-side app imports it directly —
// so both paths execute exactly the same code.

import type { GraphData } from '../core/types.js';
import { normalizeContentBounds, type ContentBounds } from '../core/normalize.js';
import { readRawModel, toUnifiedModel, type UnifiedModel } from './model.js';
import { extractSequence } from './sequence.js';
import { extractUnified } from './unified.js';

// Prefix on errors thrown by a failed mermaid.render(), so callers can tell a
// diagram syntax error from a bug in the extraction code.
export const RENDER_ERROR_TAG = '__MERMAID_RENDER_ERROR__:';

export interface PipelineResult {
    graph: GraphData;
    // Content bounds before the graph was translated to a top-left origin.
    bounds: ContentBounds;
}

// Extract a GraphData, still in raw SVG coordinates, from a rendered diagram.
// `model` is Mermaid's parsed model for the same source, when available.
export function extractGraph(svg: SVGSVGElement, diagramType: string, model: UnifiedModel | null = null): GraphData {
    const viewBox = svg.getAttribute('viewBox')?.split(' ').map(parseFloat) || [0, 0, 0, 0];
    const graphWidth = viewBox[2] || parseFloat(svg.getAttribute('width') || '0');
    const graphHeight = viewBox[3] || parseFloat(svg.getAttribute('height') || '0');

    if (diagramType === 'sequenceDiagram') return extractSequence(svg, graphWidth, graphHeight);
    return extractUnified(svg, graphWidth, graphHeight, model);
}

let renderCounter = 0;

// `mermaid` is the Mermaid API object (window.mermaid in the injected page,
// the ESM default export in the client-side bundle). `initConfig` comes from
// buildMermaidConfig(). The SVG is placed in `host` so getBBox/getCTM see
// laid-out geometry.
export async function renderAndExtract(
    mermaid: any,
    definition: string,
    initConfig: Record<string, unknown>,
    diagramType: string,
    host: Element,
): Promise<PipelineResult> {
    mermaid.initialize(initConfig);

    let svgText: string;
    try {
        ({ svg: svgText } = await mermaid.render(`m2v-diagram-${renderCounter++}`, definition));
    } catch (renderErr: any) {
        throw new Error(RENDER_ERROR_TAG + (renderErr?.message ?? String(renderErr)));
    }
    host.innerHTML = svgText;

    const svg = host.querySelector('svg') as SVGSVGElement | null;
    if (!svg) throw new Error('Mermaid produced no <svg> element');

    // Parsed after rendering, so the parse can't disturb the render's state.
    const model = toUnifiedModel(await readRawModel(mermaid, definition));
    const graph = extractGraph(svg, diagramType, model);
    const bounds = normalizeContentBounds(graph);
    return { graph, bounds };
}
