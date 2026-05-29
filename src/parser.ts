import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GraphNode {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    type?: string; 
    rounding?: number;
    url?: string;
    style?: {
        fill?: string;
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
        color?: string;
        fontSize?: string;
        fontFamily?: string;
        fontWeight?: string;
        fontStyle?: string;
        textAlign?: string;
    };
}

export interface GraphEdge {
    d: string;
    startId?: string;
    endId?: string;
    arrowStart?: boolean;
    arrowEnd?: boolean;
    text?: string;
    style?: {
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
    };
    // Styling for the edge's label, forwarded to the connector's embedded
    // text so the caption matches the Mermaid theme rather than inheriting
    // Visio's default font/color.
    labelStyle?: {
        color?: string;
        fontSize?: string;
        fontWeight?: string;
        fontStyle?: string;
    };
}

export interface GraphCluster {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    style?: {
        fill?: string;
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
        color?: string;
        fontSize?: string;
    };
}

export interface GraphLabel {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    style?: {
        color?: string;
        fill?: string;
        fontSize?: string;
        fontFamily?: string;
        fontWeight?: string;
        fontStyle?: string;
    };
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
    clusters: GraphCluster[];
    labels: GraphLabel[];
    width: number;
    height: number;
}

// Mermaid Configuration Interface
export interface MermaidConfig {
    layout?: 'elk' | 'dagre' | 'flexbox' | 'linear';
    theme?: 'default' | 'forest' | 'dark' | 'neutral';
    themeVariables?: Record<string, string>;
    flowchart?: {
        nodeSpacing?: number;
        rankSpacing?: number;
        curve?: 'basis' | 'linear' | 'cardinal' | 'monotoneX';
        useMaxWidth?: boolean;
    };
    // When true, parseMermaid emits diagnostic logs to stderr for layout
    // selection, ELK adapter registration, and the parsed graph summary.
    // Mermaid render errors are also re-thrown with diagram context (the
    // line number Mermaid reports plus surrounding source) so a user can
    // see *which* part of their diagram was rejected without re-running.
    verbose?: boolean;
}

// Re-shape Mermaid's "Lexical error on line N. Unrecognized text..." message
// into something a user can act on: surface the diagram lines around the
// reported line, and call out the most common cause we've seen (inline `%%`
// comments at the end of directive lines, which Mermaid lexes as part of
// the directive instead of as a comment).
export function formatMermaidError(rawMsg: string, definition: string): string {
    const lineMatch = /(?:Lexical|Parse) error on line (\d+)\./.exec(rawMsg);
    if (!lineMatch) return rawMsg;

    const reportedLine = parseInt(lineMatch[1], 10);

    // Mermaid reports errors against the diagram body *after* it strips the
    // YAML frontmatter, so add the frontmatter line count back to map to
    // the user's original line numbering.
    const fmMatch = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(definition);
    const fmLineCount = fmMatch ? (fmMatch[0].match(/\n/g)?.length ?? 0) : 0;
    const actualLine = reportedLine + fmLineCount;

    const lines = definition.split('\n');
    const start = Math.max(0, actualLine - 3);
    const end = Math.min(lines.length, actualLine + 1);
    const ctx = lines.slice(start, end).map((l, i) => {
        const num = start + i + 1;
        const marker = num === actualLine ? '>' : ' ';
        return `${marker} ${num.toString().padStart(4)} | ${l}`;
    }).join('\n');

    // Inline-%% gotcha: a directive followed by `%% something` is a parse
    // error because Mermaid only treats %% as a comment when the line begins
    // with it (after optional whitespace).
    const offending = lines[actualLine - 1] ?? '';
    const inlineComment = /^[^%\n]*\S\s+%%/.test(offending);
    const hint = inlineComment
        ? '\n\nHint: This line ends with an inline `%% ...` comment.\n' +
          '      Mermaid only recognises `%%` as a comment when it starts the line; trailing\n' +
          '      `%%` text is lexed as part of the directive and triggers a syntax error.\n' +
          '      Move the comment to its own line.'
        : '';

    return `Mermaid syntax error:\n  ${rawMsg.trim().replace(/\n/g, '\n  ')}\n\n` +
           `Diagram (line ${actualLine}):\n${ctx}${hint}`;
}

// Detect the Mermaid diagram type from its source: strip YAML frontmatter and
// full-line %% comments, then read the first token. Used to give a precise
// warning when the (flowchart-oriented) geometry extractor finds nothing.
export function detectDiagramType(definition: string): string {
    let body = definition.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const firstMeaningful = body
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('%%'));
    if (!firstMeaningful) return 'unknown';
    // First word, e.g. "sequenceDiagram", "flowchart", "stateDiagram-v2".
    return (/^([A-Za-z][\w-]*)/.exec(firstMeaningful)?.[1]) ?? 'unknown';
}

// Diagram types whose SVG structure the extractor understands. Flowchart/graph
// are fully supported; class/state/ER are partial (boxes + relationships, but
// not every embellishment). Everything else renders to an empty page today.
const FULLY_SUPPORTED = new Set(['flowchart', 'graph']);
const PARTIALLY_SUPPORTED = new Set(['classDiagram', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'sequenceDiagram']);

// Translate every absolute coordinate pair in an SVG path `d` string by (dx, dy).
// Mermaid's edge paths use absolute commands (M, L, C, S, Q, T, A); we don't
// see relative commands in practice, but if any appear we leave them alone
// (their values are deltas, unaffected by translation).
export function translatePathD(d: string, dx: number, dy: number): string {
    return d.replace(
        /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g,
        (_, cmd: string, args: string) => {
            const isRelative = cmd >= 'a' && cmd <= 'z';
            const upper = cmd.toUpperCase();
            if (upper === 'Z' || isRelative) return cmd + args;
            const nums = args.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
            if (!nums) return cmd + args;
            const vals = nums.map(parseFloat);
            // Per-command pattern of which numeric slots are X (true), Y (false), or neither (null).
            // A command: rx ry x-axis-rotation large-arc-flag sweep-flag x y → [null,null,null,null,null,X,Y]
            let pattern: Array<'x' | 'y' | null>;
            if (upper === 'M' || upper === 'L' || upper === 'T') pattern = ['x', 'y'];
            else if (upper === 'H') pattern = ['x'];
            else if (upper === 'V') pattern = ['y'];
            else if (upper === 'C') pattern = ['x', 'y', 'x', 'y', 'x', 'y'];
            else if (upper === 'S' || upper === 'Q') pattern = ['x', 'y', 'x', 'y'];
            else if (upper === 'A') pattern = [null, null, null, null, null, 'x', 'y'];
            else return cmd + args;
            const out = vals.map((v, i) => {
                const slot = pattern[i % pattern.length];
                if (slot === 'x') return v + dx;
                if (slot === 'y') return v + dy;
                return v;
            });
            return cmd + ' ' + out.join(' ');
        },
    );
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

    // Inject Mermaid from node_modules
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
        const result = await page.evaluate(async (def, dtype) => {
            try {
                // @ts-ignore
                const { svg } = await mermaid.render('graphDiv', def);
                document.body.innerHTML = svg;
            } catch (renderErr: any) {
                // Re-throw as a tagged Error so parseMermaid can recognise this
                // specifically as a Mermaid render failure (vs. e.g. a DOM bug
                // in our extraction code) and apply formatMermaidError to it.
                const msg = renderErr?.message ?? String(renderErr);
                throw new Error('__MERMAID_RENDER_ERROR__:' + msg);
            }

            const svgElement = document.querySelector('svg');
            const viewBox = svgElement?.getAttribute('viewBox')?.split(' ').map(parseFloat) || [0, 0, 0, 0];
            const graphWidth = viewBox[2] || parseFloat(svgElement?.getAttribute('width') || '0');
            const graphHeight = viewBox[3] || parseFloat(svgElement?.getAttribute('height') || '0');

            // Sequence diagrams have a wholly different SVG structure than
            // flowcharts (actor boxes + lifelines + message lines, not
            // .node/.edgePaths). Extract them into the same IR: actor boxes
            // become rectangle nodes; lifelines and messages become unglued
            // edges with a synthesized `d` (the generator's path fallback then
            // draws them in the shared coordinate space).
            if (dtype === 'sequenceDiagram') {
                const num = (el: Element | null, attr: string) => parseFloat(el?.getAttribute(attr) || '0');
                const actorRects = Array.from(document.querySelectorAll('rect.actor-top, rect.actor-bottom')) as SVGGraphicsElement[];
                const allText = Array.from(document.querySelectorAll('text')) as SVGGraphicsElement[];
                // Pair an actor box with the text whose centre falls inside it.
                const textInside = (x: number, y: number, w: number, h: number) => {
                    for (const t of allText) {
                        const b = t.getBBox();
                        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
                        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) return t;
                    }
                    return null;
                };
                const seqNodes: any[] = actorRects.map((r, i) => {
                    const x = num(r, 'x'), y = num(r, 'y'), width = num(r, 'width'), height = num(r, 'height');
                    const tEl = textInside(x, y, width, height);
                    const cs = window.getComputedStyle(r);
                    const ts = tEl ? window.getComputedStyle(tEl) : null;
                    return {
                        id: `seq-actor-${i}`, x, y, width, height,
                        text: tEl?.textContent?.trim() || '',
                        type: 'rectangle', rounding: 0,
                        style: {
                            fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth,
                            color: ts ? ts.color : '#000000',
                            fontSize: ts ? ts.fontSize : undefined,
                            fontFamily: ts ? ts.fontFamily : undefined,
                            textAlign: 'center',
                        },
                    };
                });

                // Activation bars: thin rectangles on a lifeline, no label.
                for (const a of Array.from(document.querySelectorAll('rect[class*="activation"]')) as SVGGraphicsElement[]) {
                    const x = num(a, 'x'), y = num(a, 'y'), width = num(a, 'width'), height = num(a, 'height');
                    const cs = window.getComputedStyle(a);
                    seqNodes.push({
                        id: `seq-activation-${seqNodes.length}`, x, y, width, height,
                        text: '', type: 'rectangle', rounding: 0,
                        style: { fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth, color: '#000000' },
                    });
                }
                // Notes: boxes with text, paired with their noteText by containment.
                const noteTexts = Array.from(document.querySelectorAll('text.noteText')) as SVGGraphicsElement[];
                for (const n of Array.from(document.querySelectorAll('rect.note')) as SVGGraphicsElement[]) {
                    const x = num(n, 'x'), y = num(n, 'y'), width = num(n, 'width'), height = num(n, 'height');
                    let txt = '';
                    let ts: CSSStyleDeclaration | null = null;
                    for (const t of noteTexts) {
                        const b = t.getBBox();
                        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
                        if (cx >= x && cx <= x + width && cy >= y && cy <= y + height) {
                            txt = t.textContent?.trim() || ''; ts = window.getComputedStyle(t); break;
                        }
                    }
                    const cs = window.getComputedStyle(n);
                    seqNodes.push({
                        id: `seq-note-${seqNodes.length}`, x, y, width, height,
                        text: txt, type: 'rectangle', rounding: 0,
                        style: {
                            fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth,
                            color: ts ? ts.color : '#000000',
                            fontSize: ts ? ts.fontSize : undefined,
                            textAlign: 'center',
                        },
                    });
                }

                const seqEdges: any[] = [];
                // Lifelines: dashed vertical lines, no arrowhead.
                for (const ll of Array.from(document.querySelectorAll('line.actor-line')) as Element[]) {
                    const x1 = num(ll, 'x1'), y1 = num(ll, 'y1'), x2 = num(ll, 'x2'), y2 = num(ll, 'y2');
                    seqEdges.push({
                        d: `M ${x1} ${y1} L ${x2} ${y2}`,
                        arrowStart: false, arrowEnd: false,
                        style: { stroke: '#999999', strokeWidth: '1px', strokeDasharray: '3,3' },
                    });
                }
                // Messages: solid (messageLine0) or dashed (messageLine1) lines
                // with an arrowhead at the end; labels matched by DOM order.
                const msgLines = Array.from(document.querySelectorAll('line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1')) as Element[];
                const msgTexts = Array.from(document.querySelectorAll('text.messageText')) as SVGGraphicsElement[];
                msgLines.forEach((ml, i) => {
                    const dashed = (ml.getAttribute('class') || '').includes('messageLine1');
                    const x1 = num(ml, 'x1'), y1 = num(ml, 'y1'), x2 = num(ml, 'x2'), y2 = num(ml, 'y2');
                    const d = ml.getAttribute('d') || `M ${x1} ${y1} L ${x2} ${y2}`;
                    const cs = window.getComputedStyle(ml);
                    const tEl = msgTexts[i];
                    const ts = tEl ? window.getComputedStyle(tEl) : null;
                    seqEdges.push({
                        d,
                        arrowStart: false, arrowEnd: true,
                        text: tEl?.textContent?.trim() || undefined,
                        labelStyle: tEl ? { color: ts?.color, fontSize: ts?.fontSize } : undefined,
                        style: {
                            stroke: cs.stroke || '#333333',
                            strokeWidth: cs.strokeWidth || '1px',
                            strokeDasharray: dashed ? '3,3' : undefined,
                        },
                    });
                });

                return {
                    width: graphWidth, height: graphHeight,
                    nodes: seqNodes, edges: seqEdges, clusters: [], labels: [],
                };
            }

            const nodes = Array.from(document.querySelectorAll('.node'));
            const edges = Array.from(document.querySelectorAll('.edgePaths path')); 
            
            // Clusters (Subgraphs)
            const clusters = Array.from(document.querySelectorAll('.cluster')).map(cluster => {
                const id = cluster.id;
                const rect = cluster.querySelector('rect, polygon, path');
                const bbox = rect ? (rect as SVGGraphicsElement).getBBox() : { width: 0, height: 0, x: 0, y: 0 };

                // Use the SVG current-transformation-matrix (CTM) to convert
                // the rect's local top-left corner to SVG root coordinates.
                // Simply parsing the `transform` attribute breaks for nested
                // subgraphs (like QUAL inside INS) because that attribute is
                // relative to the *parent* group, not the SVG root — so the
                // inner cluster lands near (0,0) instead of its true position.
                let x = 0;
                let y = 0;
                if (rect && svgElement) {
                    const ctm = (rect as SVGGraphicsElement).getCTM();
                    const svgCTM = (svgElement as SVGSVGElement).getScreenCTM();
                    if (ctm && svgCTM) {
                        const pt = (svgElement as SVGSVGElement).createSVGPoint();
                        pt.x = bbox.x;
                        pt.y = bbox.y;
                        const abs = pt.matrixTransform(svgCTM.inverse().multiply(ctm));
                        x = abs.x;
                        y = abs.y;
                    } else {
                        // Fallback for environments where getCTM is unavailable
                        const transform = cluster.getAttribute('transform');
                        const match = /translate\(([^,]+),([^)]+)\)/.exec(transform || '');
                        x = (match ? parseFloat(match[1]) : 0) + bbox.x;
                        y = (match ? parseFloat(match[2]) : 0) + bbox.y;
                    }
                }

                const textEl = cluster.querySelector('.nodeLabel, text');
                const text = textEl?.textContent?.trim();

                const computedStyle = window.getComputedStyle(rect || cluster);
                const textStyle = textEl ? window.getComputedStyle(textEl) : null;

                return {
                    id,
                    x,
                    y,
                    width: bbox.width,
                    height: bbox.height,
                    text,
                    style: {
                        fill: computedStyle.fill,
                        stroke: computedStyle.stroke,
                        strokeWidth: computedStyle.strokeWidth,
                        strokeDasharray: computedStyle.strokeDasharray,
                        color: textStyle ? textStyle.color : '#000000'
                    }
                };
            });

            // Edge Labels: collect g.edgeLabel groups in DOM order so they can
            // be matched to edge paths by index. Mermaid emits one g.edgeLabel
            // per edge (even if the label is empty), in the same order as the
            // .edgePaths path elements, so rawEdgeLabels[i] corresponds to edges[i].
            const rawEdgeLabels = Array.from(document.querySelectorAll('g.edgeLabel')).map(labelG => {
                // Select foreignObject (SVG element, has getBBox) or SVG text;
                // avoid selecting the HTML <div> inside foreignObject (no getBBox).
                const contentEl = labelG.querySelector('foreignObject, text') as SVGGraphicsElement | null;
                const bbox = contentEl ? contentEl.getBBox() : { width: 0, height: 0, x: 0, y: 0 };

                let x = 0;
                let y = 0;
                const ctm = (labelG as SVGGraphicsElement).getCTM();
                const svgCTM = (svgElement as SVGSVGElement).getScreenCTM();
                if (ctm && svgCTM) {
                    const pt = (svgElement as SVGSVGElement).createSVGPoint();
                    pt.x = 0; pt.y = 0;
                    const abs = pt.matrixTransform(svgCTM.inverse().multiply(ctm));
                    x = abs.x + ((bbox as any).x || 0);
                    y = abs.y + ((bbox as any).y || 0);
                } else {
                    const transform = (labelG as Element).getAttribute('transform');
                    const m = /translate\(([^,]+),([^)]+)\)/.exec(transform || '');
                    x = (m ? parseFloat(m[1]) : 0) + ((bbox as any).x || 0);
                    y = (m ? parseFloat(m[2]) : 0) + ((bbox as any).y || 0);
                }

                const text = labelG.textContent?.trim() || '';
                const bgRect = labelG.querySelector('.label-container rect');
                const bgStyle = bgRect ? window.getComputedStyle(bgRect) : null;
                const textEl = (contentEl || labelG) as Element;
                const textStyle = window.getComputedStyle(textEl);

                return {
                    x,
                    y,
                    width: (bbox as any).width || 10,
                    height: (bbox as any).height || 10,
                    text,
                    style: {
                        color: textStyle.color,
                        fill: bgStyle?.fill !== 'none' ? bgStyle?.fill : undefined,
                        fontSize: textStyle.fontSize,
                        fontFamily: textStyle.fontFamily,
                        fontWeight: textStyle.fontWeight,
                        fontStyle: textStyle.fontStyle
                    }
                };
            });
            // Standalone labels: any beyond the edge count (normally none for
            // flowcharts since every g.edgeLabel maps to an edge).
            if (rawEdgeLabels.length !== edges.length) {
                console.warn(`[parseMermaid] label/edge count mismatch: ${rawEdgeLabels.length} g.edgeLabel vs ${edges.length} edge paths — Mermaid version change?`);
            }
            const labels = rawEdgeLabels.slice(edges.length).filter(l => l.text);

            return {
                width: graphWidth,
                height: graphHeight,
                nodes: nodes.map(node => {
                    const rawId = node.id;
                    // Mermaid 11.x emits node ids as "flowchart-<USERID>-<IDX>"
                    // (e.g. "flowchart-A-0"). Edges reference the user-facing
                    // id ("A"), so strip the scaffold here so the generator's
                    // nodeId -> pin lookup matches what the edge carries.
                    const normIdMatch = /^flowchart-(.+)-\d+$/.exec(rawId);
                    const id = normIdMatch ? normIdMatch[1] : rawId;
                    const nodeClasses = Array.from(node.classList).join(' ');

                    const rect = node.querySelector('rect, circle, polygon, path, ellipse') as SVGGraphicsElement;
                    const bbox = rect ? rect.getBBox() : { width: 0, height: 0, x: 0, y: 0 };

                    // Use CTM to convert the shape's local bbox top-left to SVG
                    // root coordinates. Nodes inside a subgraph have a transform
                    // attribute relative to the parent cluster <g>, not the SVG
                    // root, so reading the attribute alone gives wrong absolute
                    // positions for nested nodes. CTM accumulates all ancestor
                    // transforms and gives the correct absolute result.
                    let x = 0;
                    let y = 0;
                    if (rect && svgElement) {
                        const ctm = (rect as SVGGraphicsElement).getCTM();
                        const svgCTM = (svgElement as SVGSVGElement).getScreenCTM();
                        if (ctm && svgCTM) {
                            const pt = (svgElement as SVGSVGElement).createSVGPoint();
                            pt.x = bbox.x;
                            pt.y = bbox.y;
                            const abs = pt.matrixTransform(svgCTM.inverse().multiply(ctm));
                            x = abs.x;
                            y = abs.y;
                        } else {
                            const transform = node.getAttribute('transform');
                            const m2 = /translate\(([^,]+),([^)]+)\)/.exec(transform || '');
                            x = (m2 ? parseFloat(m2[1]) : 0) + bbox.x;
                            y = (m2 ? parseFloat(m2[2]) : 0) + bbox.y;
                        }
                    }
                    
                    let type = 'rectangle';
                    const shapeTag = rect ? rect.tagName.toLowerCase() : 'unknown';
                    const points = rect ? rect.getAttribute('points') || '' : '';
                    const d = rect ? rect.getAttribute('d') || '' : '';
                    const dataShape = node.getAttribute('data-shape') || rect?.getAttribute('data-shape') || '';
                    
                    if (dataShape) {
                        type = dataShape;
                    } else if (nodeClasses.includes('stadium')) {
                        type = 'stadium';
                    } else if (shapeTag === 'polygon') {
                        const pts = points.split(/[\s,]+/).filter(p => p).length / 2;
                        if (pts === 4) {
                             type = 'diamond'; 
                        } else if (pts > 4) {
                             type = 'subroutine';
                        }
                    } else if (shapeTag === 'path') {
                        if (d.includes('a') || d.includes('A')) type = 'cylinder';
                        else if (d.includes('c') || d.includes('C')) type = 'stadium';
                    } else if (shapeTag === 'circle') {
                        type = 'circle';
                    } else if (shapeTag === 'ellipse') {
                        type = 'ellipse';
                    }

                    const computedStyle = window.getComputedStyle(rect || node);
                    const textEl = node.querySelector('div, span, text');
                    const textStyle = textEl ? window.getComputedStyle(textEl) : null;
                    
                    let rounding = 0;
                    if (rect && rect.tagName.toLowerCase() === 'rect') {
                        const rx = parseFloat(rect.getAttribute('rx') || '0');
                        if (rx > 0) rounding = rx;
                    }

                    const anchor = node.querySelector('a') || node.closest('a');
                    const url = anchor ? anchor.getAttribute('href') || anchor.getAttribute('xlink:href') : undefined;

                    let text = '';
                    if (textEl) {
                        const clone = textEl.cloneNode(true) as HTMLElement;
                        const brs = clone.querySelectorAll('br');
                        brs.forEach(br => br.replaceWith('\n'));
                        text = clone.textContent?.trim() || '';
                    } else {
                        text = node.textContent?.trim() || '';
                    }

                    let textAlign = 'center';
                    if (textStyle) {
                        const anchor = textStyle.getPropertyValue('text-anchor');
                        if (anchor === 'start') textAlign = 'left';
                        else if (anchor === 'end') textAlign = 'right';
                    }

                    return { 
                        id, 
                        x, 
                        y, 
                        width: bbox.width, 
                        height: bbox.height, 
                        text,
                        type,
                        rounding,
                        url,
                        style: {
                            fill: computedStyle.fill,
                            stroke: computedStyle.stroke,
                            strokeWidth: computedStyle.strokeWidth,
                            strokeDasharray: computedStyle.strokeDasharray,
                            color: textStyle ? textStyle.color : '#000000',
                            fontSize: textStyle ? textStyle.fontSize : undefined,
                            fontFamily: textStyle ? textStyle.fontFamily : undefined,
                            fontWeight: textStyle ? textStyle.fontWeight : undefined,
                            fontStyle: textStyle ? textStyle.fontStyle : undefined,
                            textAlign
                        }
                    };
                }),
                edges: edges.map((path, edgeIdx) => {
                   const computedStyle = window.getComputedStyle(path);

                    const markerStart = path.getAttribute('marker-start');
                    const markerEnd = path.getAttribute('marker-end');

                    // Mermaid 11.x stopped emitting LS-<id>/LE-<id> classes on
                    // the edge's parent <g>. Instead the edge <path> carries
                    // id="L_<src>_<dst>_<idx>" (and data-id= the same thing).
                    // Parse that to recover the endpoint user ids.
                    let startId, endId;
                    const edgeId = path.getAttribute('id') || path.getAttribute('data-id') || '';
                    const edgeMatch = /^L_(.+)_(.+)_\d+$/.exec(edgeId);
                    if (edgeMatch) {
                        startId = edgeMatch[1];
                        endId = edgeMatch[2];
                    } else {
                        // Legacy fallback for older Mermaid versions.
                        const parentGroup = path.parentElement;
                        if (parentGroup) {
                            const classes = Array.from(parentGroup.classList);
                            const ls = classes.find(c => c.startsWith('LS-'));
                            const le = classes.find(c => c.startsWith('LE-'));
                            if (ls) startId = ls.replace('LS-', '');
                            if (le) endId = le.replace('LE-', '');
                        }
                    }

                    // Attach the edge label text by DOM index: rawEdgeLabels[i]
                    // corresponds to the i-th edge path (same document order).
                    // `|| undefined` converts the empty string ("") to undefined
                    // so that edges with no label don't get an empty Text element.
                    const edgeLabel = rawEdgeLabels[edgeIdx];
                    const edgeLabelText = edgeLabel?.text || undefined;
                    // Forward label font styling alongside the text so the
                    // generator can emit a matching Character section.
                    const labelStyle = edgeLabelText && edgeLabel ? {
                        color: edgeLabel.style?.color,
                        fontSize: edgeLabel.style?.fontSize,
                        fontWeight: edgeLabel.style?.fontWeight,
                        fontStyle: edgeLabel.style?.fontStyle,
                    } : undefined;

                    return {
                        d: path.getAttribute('d') || '',
                        startId,
                        endId,
                        arrowStart: !!markerStart,
                        arrowEnd: !!markerEnd,
                        text: edgeLabelText,
                        labelStyle,
                        style: {
                            stroke: computedStyle.stroke,
                            strokeWidth: computedStyle.strokeWidth,
                            strokeDasharray: computedStyle.strokeDasharray
                        }
                    };
                }),
                clusters: clusters.map(c => {
                    return {
                        ...c,
                        style: {
                            ...c.style,
                            strokeDasharray: c.style.strokeDasharray
                        }
                    };
                }),
                labels
            };
        }, definition, diagramType);

        // Normalise all coordinates so the page origin is the top-left of the
        // actual rendered content.  Mermaid+ELK place shapes in SVG user space
        // whose origin doesn't match the viewBox top-left (e.g. ELK puts the
        // Legend subgraph at y=-11 above viewBox y=4 in this fixture).  If we
        // hand those raw SVG coordinates to the generator, shapes with x<0 or
        // y<0 land off-page in Visio.  Compute the actual content bounds across
        // every extracted shape and translate by (-minX, -minY) here, so the
        // generator only sees non-negative coordinates that fit the page.
        const xs: number[] = [];
        const ys: number[] = [];
        const maxXs: number[] = [];
        const maxYs: number[] = [];
        for (const n of result.nodes) {
            xs.push(n.x); ys.push(n.y);
            maxXs.push(n.x + n.width); maxYs.push(n.y + n.height);
        }
        for (const c of result.clusters) {
            xs.push(c.x); ys.push(c.y);
            maxXs.push(c.x + c.width); maxYs.push(c.y + c.height);
        }
        for (const l of result.labels) {
            xs.push(l.x); ys.push(l.y);
            maxXs.push(l.x + l.width); maxYs.push(l.y + l.height);
        }
        const minX = xs.length ? Math.min(...xs) : 0;
        const minY = ys.length ? Math.min(...ys) : 0;
        const maxX = maxXs.length ? Math.max(...maxXs) : result.width;
        const maxY = maxYs.length ? Math.max(...maxYs) : result.height;

        for (const n of result.nodes) { n.x -= minX; n.y -= minY; }
        for (const c of result.clusters) { c.x -= minX; c.y -= minY; }
        for (const l of result.labels) { l.x -= minX; l.y -= minY; }
        // Edge `d` strings carry absolute SVG coordinates; the only safe
        // translation in path syntax is rewriting the leading "M x y" of each
        // subpath (only M/L/C/S/Q/T/A take absolute coordinate pairs in our
        // input — Mermaid emits absolute commands).  Walk the tokens and
        // subtract (minX, minY) from every absolute coordinate pair so the
        // fallback path-drawing code lands shapes in the same space as nodes.
        for (const e of result.edges) {
            if (e.d) e.d = translatePathD(e.d, -minX, -minY);
        }

        result.width = maxX - minX;
        result.height = maxY - minY;

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
        log(`content bounds: x=[${minX.toFixed(1)}, ${maxX.toFixed(1)}] ` +
            `y=[${minY.toFixed(1)}, ${maxY.toFixed(1)}] ` +
            `(translated by ${(-minX).toFixed(1)}, ${(-minY).toFixed(1)})`);
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
