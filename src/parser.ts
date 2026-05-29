import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

// Core (environment-agnostic) modules. The Node parser orchestrates Puppeteer
// + ELK + page lifecycle; the actual DOM extraction and pure helpers live in
// src/core/* so the same logic can be imported by a browser build without
// pulling in Puppeteer/fs/http.
import { renderMermaidToDom, extractGraphFromDom } from './core/extract.js';
import { normalizeContentBounds } from './core/normalize.js';
import {
    detectDiagramType,
    formatMermaidError,
    FULLY_SUPPORTED,
    PARTIALLY_SUPPORTED,
} from './core/detect.js';

// Re-exports for back-compat with the existing test/CLI/GUI/MCP import surface
// (which historically pulled everything out of src/parser.js).
export { translatePathD } from './core/normalize.js';
export { detectDiagramType, formatMermaidError } from './core/detect.js';
export type {
    GraphNode, GraphEdge, GraphCluster, GraphLabel, GraphData, MermaidConfig,
} from './core/types.js';

import type { GraphData, MermaidConfig } from './core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export async function parseMermaid(definition: string, config?: MermaidConfig): Promise<GraphData> {
    const log = (msg: string) => {
        if (config?.verbose) console.error(`[parseMermaid] ${msg}`);
    };

    log(`input: ${definition.split('\n').length} lines, ${definition.length} chars`);

    // --no-sandbox is required when running as root in CI containers;
    // --disable-dev-shm-usage avoids /dev/shm size limits on small runners.
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
    } catch (err: any) {
        throw new Error(explainLaunchFailure(err));
    }
    const page = await browser.newPage();
    if (config?.verbose) {
        page.on('console', (m) => log(`[browser:${m.type()}] ${m.text()}`));
        page.on('pageerror', (e) => log(`[browser:pageerror] ${e.message}`));
    }

    // Inject Mermaid from node_modules so the page can call mermaid.render().
    const mermaidPath = path.resolve(__dirname, '../node_modules/mermaid/dist/mermaid.min.js');
    await page.addScriptTag({ path: mermaidPath });

    // Prepare theme variables with defaults
    const defaultThemeVars: Record<string, string> = {
        primaryColor: '#e1f5fe',
        primaryTextColor: '#000',
        primaryBorderColor: '#01579b',
        lineColor: '#01579b',
        secondBkgColor: '#f0f0f0',
        tertiaryColor: '#ffffff',
        fontSize: '14px',
        fontFamily: 'Segoe UI, sans-serif'
    };

    const themeVars = { ...defaultThemeVars, ...config?.themeVariables };
    const theme = config?.theme || 'neutral';

    // When the caller doesn't supply a layout, check the diagram's YAML frontmatter
    // (between ---...--- delimiters) so that `layout: elk` in the diagram itself
    // still triggers ELK adapter registration.  Without this, Mermaid's internal
    // frontmatter parser overrides the initialize() layout at render time and tries
    // to use ELK — but the adapter was never registered, causing a render failure.
    let requestedLayout: MermaidConfig['layout'] = config?.layout ?? 'dagre';
    let layoutSource = config?.layout ? 'config' : 'default';
    if (!config?.layout) {
        const frontmatter = /^---[\s\S]*?---/.exec(definition)?.[0] ?? '';
        const fmLayout = /\blayout:\s*(\S+)/.exec(frontmatter)?.[1];
        if (fmLayout) {
            requestedLayout = fmLayout as MermaidConfig['layout'];
            layoutSource = 'frontmatter';
        }
    }
    log(`layout=${requestedLayout} (source=${layoutSource})`);

    // Mermaid 11 moved non-dagre layouts into separate packages that must be
    // registered before `initialize`. Serve the ELK bundle from node_modules
    // via a short-lived localhost HTTP server so relative chunk imports
    // resolve, ESM MIME type is correct, and no network is required.
    let layoutEngine = requestedLayout;
    let elkServer: http.Server | null = null;
    if (requestedLayout === 'elk') {
        const elkDistDir = path.resolve(__dirname, '../node_modules/@mermaid-js/layout-elk/dist');
        let registered = false;
        try {
            if (!fs.existsSync(elkDistDir)) {
                throw new Error(`@mermaid-js/layout-elk not installed at ${elkDistDir}`);
            }
            elkServer = http.createServer((req, res) => {
                const rel = (req.url || '/').split('?')[0].replace(/^\/+/, '');
                const abs = path.resolve(elkDistDir, rel);
                if (!abs.startsWith(elkDistDir + path.sep) && abs !== elkDistDir) {
                    res.writeHead(403); res.end(); return;
                }
                fs.readFile(abs, (err, buf) => {
                    if (err) { res.writeHead(404); res.end(); return; }
                    res.writeHead(200, {
                        'Content-Type': 'application/javascript',
                        'Access-Control-Allow-Origin': '*',
                    });
                    res.end(buf);
                });
            });
            await new Promise<void>((resolve) => elkServer!.listen(0, '127.0.0.1', resolve));
            const port = (elkServer.address() as any).port;
            const elkUrl = `http://127.0.0.1:${port}/mermaid-layout-elk.esm.min.mjs`;
            await page.addScriptTag({
                content: `
                    import elk from '${elkUrl}';
                    window.__elkLoader = elk;
                    window.__elkReady = true;
                `,
                type: 'module',
            });
            // Module scripts fire their load event before their top-level
            // await chain resolves the sub-chunk imports, so poll briefly
            // until the loader is actually on `window`.
            await page.waitForFunction(() => (window as any).__elkReady === true, { timeout: 5000 });
            registered = await page.evaluate(() => {
                const loader = (window as any).__elkLoader;
                if (!loader) return false;
                (window as any).mermaid.registerLayoutLoaders(loader);
                return true;
            });
        } catch (e) {
            console.warn('ELK layout loader failed, falling back to dagre:', e);
        }
        if (!registered) layoutEngine = 'dagre';
        log(registered ? 'ELK adapter registered' : 'ELK registration failed; falling back to dagre');
    }

    await page.setContent(`
        <div id="graphDiv"></div>
        <script>
            mermaid.initialize({
                startOnLoad: false,
                theme: ${JSON.stringify(theme)},
                layout: ${JSON.stringify(layoutEngine)},
                themeVariables: ${JSON.stringify(themeVars)},
                flowchart: {
                    nodeSpacing: ${config?.flowchart?.nodeSpacing || 50},
                    rankSpacing: ${config?.flowchart?.rankSpacing || 50},
                    curve: ${JSON.stringify(config?.flowchart?.curve || 'basis')},
                    useMaxWidth: ${config?.flowchart?.useMaxWidth !== false}
                },
                securityLevel: 'loose'
            });
        </script>
    `);

    const diagramType = detectDiagramType(definition);

    try {
        // Two page.evaluate calls so the render and extract phases are
        // independent. Both target functions live in src/core/extract.ts —
        // Puppeteer serializes them by reference, the same functions are
        // importable by a browser build, and neither closes over any
        // Node-side state.
        await page.evaluate(renderMermaidToDom, definition);
        const result = await page.evaluate(extractGraphFromDom, diagramType);

        // Translate to top-left origin so off-viewBox content lands on-page.
        // normalizeContentBounds mutates and returns the pre-translation bounds
        // for diagnostic logging.
        const bounds = normalizeContentBounds(result);

        // If the extractor found no geometry at all, the output VSDX will open
        // but be blank. That's a silent failure for diagram types this
        // flowchart-oriented extractor doesn't understand (sequence, pie,
        // gantt, journey, ...), so warn loudly with the detected type. The
        // warning goes to stderr, which is safe for the CLI, GUI, and the MCP
        // server (whose JSON-RPC channel is stdout).
        const totalShapes = result.nodes.length + result.edges.length +
            result.clusters.length + result.labels.length;
        if (totalShapes === 0) {
            const type = detectDiagramType(definition);
            const support = FULLY_SUPPORTED.has(type) || PARTIALLY_SUPPORTED.has(type)
                ? `Expected shapes for "${type}" but found none — the diagram may be empty or use unsupported syntax.`
                : `Diagram type "${type}" is not supported by the geometry extractor ` +
                  `(supported: flowchart/graph fully; sequence/class/state/ER partially). ` +
                  `The generated VSDX will open but be blank.`;
            console.warn(`[mermaid2visio] Warning: no shapes extracted. ${support}`);
        }

        log(`render OK: ${result.nodes.length} nodes, ${result.edges.length} edges, ` +
            `${result.clusters.length} clusters, ${result.labels.length} labels`);
        log(`content bounds: x=[${bounds.minX.toFixed(1)}, ${bounds.maxX.toFixed(1)}] ` +
            `y=[${bounds.minY.toFixed(1)}, ${bounds.maxY.toFixed(1)}] ` +
            `(translated by ${(-bounds.minX).toFixed(1)}, ${(-bounds.minY).toFixed(1)})`);
        return result;
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        const tagged = msg.match(/__MERMAID_RENDER_ERROR__:([\s\S]+)$/);
        if (tagged) {
            const formatted = formatMermaidError(tagged[1], definition);
            log(`render FAILED: ${tagged[1].split('\n')[0]}`);
            throw new Error(formatted);
        }
        log(`evaluate threw: ${msg.split('\n')[0]}`);
        throw e;
    } finally {
        await browser.close();
        if (elkServer) {
            await new Promise<void>((resolve, reject) => elkServer!.close(err => err ? reject(err) : resolve()));
        }
    }
}
