// Node-side rendering: owns the headless browser, loads Mermaid and the
// bundled extractor into a page, and runs the shared in-page pipeline
// (src/extract/index.ts). Everything DOM-related happens in the page; this
// file only does lifecycle and I/O.

import puppeteer, { type Browser } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

import { buildMermaidConfig } from '../core/mermaidConfig.js';
import { detectDiagramType, formatMermaidError, supportLevel } from '../core/detect.js';
import type { ContentBounds } from '../core/normalize.js';
import type { GraphData, MermaidConfig } from '../core/types.js';
import type { ExtractorApi } from '../extract/page.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/render and dist/render both sit two levels below the package root.
const PACKAGE_ROOT = path.resolve(here, '../..');
const requireFromHere = createRequire(import.meta.url);

// Must match RENDER_ERROR_TAG in src/extract/index.ts (not imported, so this
// file never pulls DOM-only code into the Node module graph).
const RENDER_ERROR_TAG = '__MERMAID_RENDER_ERROR__:';

// A browser started elsewhere (Jest's global setup) that renderers should
// attach to instead of launching their own.
const SHARED_BROWSER_ENV = 'M2V_BROWSER_WS_ENDPOINT';

// --no-sandbox is required when running as root in CI containers;
// --disable-dev-shm-usage avoids /dev/shm size limits on small runners.
export const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

function resolveNodeModule(specifier: string): string {
    try {
        return requireFromHere.resolve(specifier);
    } catch {
        return path.resolve(PACKAGE_ROOT, 'node_modules', specifier);
    }
}

export function mermaidScriptPath(): string {
    return resolveNodeModule('mermaid/dist/mermaid.min.js');
}

export function extractorScriptPath(): string {
    return path.join(PACKAGE_ROOT, 'dist', 'extractor.iife.js');
}

// Turn Puppeteer's opaque "Failed to launch the browser process" errors into
// something a user can act on. Exit code 127 means the binary is missing or
// its shared libraries can't be resolved; ENOENT means the path is wrong.
export function explainLaunchFailure(err: any): string {
    const raw = String(err?.message || err);
    const base = 'Puppeteer could not launch Chromium.';
    const remediation = [
        '',
        'To fix:',
        '  1. Download the bundled browser:',
        '       npx puppeteer browsers install chrome',
        '  2. Or point Puppeteer at an existing Chrome/Chromium:',
        '       export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome',
        '  3. On Linux, you may also need system libraries. Debian/Ubuntu:',
        '       sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 \\',
        '         libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \\',
        '         libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \\',
        '         libasound2',
    ].join('\n');

    // Puppeteer formats the exit status as either "Code: 127" or "Code 127"
    // depending on version, so accept either.
    if (/code:?\s*127\b/i.test(raw) || /ENOENT/i.test(raw)) {
        return `${base} The browser binary is missing or cannot find its shared libraries (exit 127 / ENOENT).\n\nOriginal error: ${raw}${remediation}`;
    }
    if (/code:?\s*126\b/i.test(raw)) {
        return `${base} The browser binary is not executable (exit 126). Check file permissions on the Chromium binary.\n\nOriginal error: ${raw}${remediation}`;
    }
    if (/Running as root without --no-sandbox/i.test(raw)) {
        return `${base} Chromium refuses to run as root without --no-sandbox. This project already passes that flag, so something else is overriding it.\n\nOriginal error: ${raw}`;
    }
    return `${base}\n\nOriginal error: ${raw}${remediation}`;
}

export interface RenderOutput {
    graph: GraphData;
    bounds: ContentBounds;
    diagramType: string;
    layout: string;
}

// Holds one browser and renders each diagram in a fresh page. Reusable across
// many render() calls; call close() when done.
export class MermaidRenderer {
    private browserPromise: Promise<Browser> | null = null;
    private attached = false;

    private getBrowser(): Promise<Browser> {
        if (!this.browserPromise) {
            const shared = process.env[SHARED_BROWSER_ENV];
            if (shared) {
                this.attached = true;
                this.browserPromise = puppeteer.connect({ browserWSEndpoint: shared });
            } else {
                this.browserPromise = puppeteer
                    .launch({ headless: true, args: LAUNCH_ARGS })
                    .catch((err: any) => { throw new Error(explainLaunchFailure(err)); });
            }
            // A failed launch should be retried on the next call, not cached.
            this.browserPromise.catch(() => { this.browserPromise = null; });
        }
        return this.browserPromise;
    }

    async close(): Promise<void> {
        const pending = this.browserPromise;
        this.browserPromise = null;
        if (!pending) return;
        let browser: Browser;
        try { browser = await pending; } catch { return; }
        if (this.attached) await browser.disconnect();
        else await browser.close();
    }

    async render(definition: string, config?: MermaidConfig): Promise<RenderOutput> {
        const log = (msg: string) => {
            if (config?.verbose) console.error(`[parseMermaid] ${msg}`);
        };
        log(`input: ${definition.split('\n').length} lines, ${definition.length} chars`);

        const extractorPath = extractorScriptPath();
        if (!fs.existsSync(extractorPath)) {
            throw new Error(`Extractor bundle not found at ${extractorPath}. Run "npm run build" first.`);
        }

        const resolved = buildMermaidConfig(config, definition);
        log(`layout=${resolved.layout} (source=${resolved.layoutSource})`);
        const diagramType = detectDiagramType(definition);

        const browser = await this.getBrowser();
        const page = await browser.newPage();
        try {
            if (config?.verbose) {
                page.on('console', (m) => log(`[browser:${m.type()}] ${m.text()}`));
                page.on('pageerror', (e) => log(`[browser:pageerror] ${(e as Error).message}`));
            }
            await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="m2v-host"></div></body></html>');
            await page.addScriptTag({ path: mermaidScriptPath() });
            await page.addScriptTag({ path: extractorPath });

            const init = resolved.init;
            const { graph, bounds } = await page.evaluate(
                (def: string, initConfig: Record<string, unknown>, dtype: string) => {
                    const api = (window as any).__m2v as ExtractorApi;
                    const host = document.getElementById('m2v-host')!;
                    return api.renderAndExtract((window as any).mermaid, def, initConfig, dtype, host);
                },
                definition, init, diagramType,
            );

            // If the extractor found no geometry at all, the output VSDX will
            // open but be blank. Warn loudly with the detected type. stderr is
            // safe for the CLI, GUI, and the MCP server (whose JSON-RPC
            // channel is stdout).
            const totalShapes = graph.nodes.length + graph.edges.length + graph.clusters.length + graph.labels.length;
            if (totalShapes === 0) {
                const support = supportLevel(diagramType) !== 'none'
                    ? `Expected shapes for "${diagramType}" but found none — the diagram may be empty or use unsupported syntax.`
                    : `Diagram type "${diagramType}" is not supported by the geometry extractor ` +
                      `(supported: flowchart/graph fully; sequence/class/state/ER partially). ` +
                      `The generated VSDX will open but be blank.`;
                console.warn(`[mermaid2visio] Warning: no shapes extracted. ${support}`);
            }

            log(`render OK: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
                `${graph.clusters.length} clusters, ${graph.labels.length} labels`);
            log(`content bounds: x=[${bounds.minX.toFixed(1)}, ${bounds.maxX.toFixed(1)}] ` +
                `y=[${bounds.minY.toFixed(1)}, ${bounds.maxY.toFixed(1)}] ` +
                `(translated by ${(-bounds.minX).toFixed(1)}, ${(-bounds.minY).toFixed(1)})`);
            return { graph, bounds, diagramType, layout: String(init.layout) };
        } catch (e: any) {
            const msg = e?.message ?? String(e);
            const at = msg.indexOf(RENDER_ERROR_TAG);
            if (at >= 0) {
                const raw = msg.slice(at + RENDER_ERROR_TAG.length);
                log(`render FAILED: ${raw.split('\n')[0]}`);
                throw new Error(formatMermaidError(raw, definition));
            }
            log(`evaluate threw: ${msg.split('\n')[0]}`);
            throw e;
        } finally {
            await page.close().catch(() => {});
        }
    }
}
