// Entry point for the injected bundle (dist/extractor.iife.js). Exposes the
// pipeline on a single global so the Node renderer can call it from
// page.evaluate without serialising functions, and so the GUI preview can
// reuse buildMermaidConfig.

import { renderAndExtract, extractGraph, RENDER_ERROR_TAG } from './index.js';
import { buildMermaidConfig } from '../core/mermaidConfig.js';
import { detectDiagramType } from '../core/detect.js';

const api = { renderAndExtract, extractGraph, buildMermaidConfig, detectDiagramType, RENDER_ERROR_TAG };

export type ExtractorApi = typeof api;

(globalThis as any).__m2v = api;
