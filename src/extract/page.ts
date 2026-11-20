// Entry point for the injected bundle (dist/extractor.iife.js). Exposes the
// pipeline on a single global so the Node renderer can call it from
// page.evaluate without serialising functions, and so the GUI preview can
// reuse buildMermaidConfig.

import { renderAndExtract, extractGraph, RENDER_ERROR_TAG } from './index.js';
import { buildMermaidConfig } from '../core/mermaidConfig.js';
import { detectDiagramType } from '../core/detect.js';
import { plain, readRawModel } from './model.js';

// Diagnostic used by scripts/probe-render.mjs: render a diagram and return the
// raw SVG plus a JSON-safe dump of Mermaid's parsed model, so extractors can
// be written against what Mermaid actually emits.
async function probe(mermaid: any, definition: string, initConfig: Record<string, unknown>, host: Element) {
    mermaid.initialize(initConfig);
    const { svg } = await mermaid.render('m2v-probe', definition);
    host.innerHTML = svg;
    const model = await readRawModel(mermaid, definition);
    // For databases without getData(), call their zero-argument getters.
    const getters: Record<string, unknown> = {};
    if (model?.db && !model.data) {
        const names = new Set<string>();
        for (let o = model.db; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
            for (const k of Object.getOwnPropertyNames(o)) names.add(k);
        }
        for (const k of names) {
            const fn = (model.db as any)[k];
            if (!/^get[A-Z]/.test(k) || typeof fn !== 'function' || fn.length !== 0) continue;
            try { getters[k] = plain(fn.call(model.db)); } catch { /* ignore */ }
        }
    }
    const count = (sel: string) => host.querySelectorAll(sel).length;
    return {
        svg,
        mermaidType: model?.type ?? null,
        data: plain(model?.data ?? null),
        getters,
        counts: {
            node: count('.node'), edgePath: count('.edgePaths path'), cluster: count('.cluster'), edgeLabel: count('g.edgeLabel'),
            rect: count('rect'), circle: count('circle'), ellipse: count('ellipse'), polygon: count('polygon'),
            path: count('path'), line: count('line'), text: count('text'), foreignObject: count('foreignObject'), image: count('image'),
        },
    };
}

const api = { renderAndExtract, extractGraph, buildMermaidConfig, detectDiagramType, RENDER_ERROR_TAG, probe };

export type ExtractorApi = typeof api;

(globalThis as any).__m2v = api;
