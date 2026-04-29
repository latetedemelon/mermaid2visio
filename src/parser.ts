import puppeteer from 'puppeteer';
import path from 'path';
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
    rounding?: number; // Corner radius
    url?: string; // Hyperlink
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
        textAlign?: string; // start, middle, end
    };
}

export interface GraphEdge {
    d: string;
    startId?: string; 
    endId?: string;
    arrowStart?: boolean;
    arrowEnd?: boolean;
    style?: {
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
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

export async function parseMermaid(definition: string): Promise<GraphData> {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Inject Mermaid from node_modules
    const mermaidPath = path.resolve(__dirname, '../node_modules/mermaid/dist/mermaid.min.js');
    await page.addScriptTag({ path: mermaidPath });

    await page.setContent(`
        <div id="graphDiv"></div>
        <script>
            mermaid.initialize({ startOnLoad: false });
        </script>
    `);

    try {
        const result = await page.evaluate(async (def) => {
            // @ts-ignore
            let svg: string;
            try {
                // @ts-ignore
                ({ svg } = await mermaid.render('graphDiv', def));
            } catch (renderErr) {
                // Strip YAML frontmatter (e.g. layout:elk requires the optional ELK adapter)
                // and retry with the default layout engine
                const stripped = def.replace(/^---[\s\S]*?---\s*\n?/, '');
                if (stripped !== def) {
                    // @ts-ignore
                    ({ svg } = await mermaid.render('graphDiv2', stripped));
                } else {
                    throw renderErr;
                }
            }
            document.body.innerHTML = svg;
            
            const svgElement = document.querySelector('svg');
            const viewBox = svgElement?.getAttribute('viewBox')?.split(' ').map(parseFloat) || [0, 0, 0, 0];
            const graphWidth = viewBox[2] || parseFloat(svgElement?.getAttribute('width') || '0');
            const graphHeight = viewBox[3] || parseFloat(svgElement?.getAttribute('height') || '0');

            const nodes = Array.from(document.querySelectorAll('.node'));
            // Select paths that are direct children of .edgePaths or have the flowchart-link class
            const edges = Array.from(document.querySelectorAll('.edgePaths path')); 
            
            // Clusters (Subgraphs)
            const clusters = Array.from(document.querySelectorAll('.cluster')).map(cluster => {
                const id = cluster.id;
                const rect = cluster.querySelector('rect, polygon, path');
                const bbox = rect ? (rect as SVGGraphicsElement).getBBox() : { width: 0, height: 0, x: 0, y: 0 };

                // Use the CTM to get absolute SVG coordinates; this handles nested subgraphs
                // correctly because getCTM() accumulates all ancestor transforms.
                let x = 0, y = 0;
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
                        // Fallback for environments where CTM is unavailable
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

            // Edge Labels
            const labels = Array.from(document.querySelectorAll('.edgeLabel')).map(label => {
                // Mermaid puts labels in a div inside a foreignObject, or directly as text
                // The .edgeLabel group usually has the transform
                const transform = label.getAttribute('transform');
                const match = /translate\(([^,]+),([^)]+)\)/.exec(transform || '');
                const x = match ? parseFloat(match[1]) : 0;
                const y = match ? parseFloat(match[2]) : 0;

                const div = label.querySelector('div, foreignObject, text');
                const bbox = div ? (div as SVGGraphicsElement).getBBox() : { width: 0, height: 0 };
                const text = label.textContent?.trim() || '';
                
                // Attempt to get background color if there's a label box
                const bgRect = label.querySelector('.label-container rect'); // Sometimes mermaid wraps it
                const bgStyle = bgRect ? window.getComputedStyle(bgRect) : null;
                const textStyle = window.getComputedStyle(div || label);

                return {
                    x,
                    y,
                    width: bbox.width || 10, // Fallback
                    height: bbox.height || 10,
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
            }).filter(l => l.text); // Filter empty labels

            return {
                width: graphWidth,
                height: graphHeight,
                nodes: nodes.map(node => {
                    const rawId = node.id;
                    // Mermaid renders node IDs as 'flowchart-ORIGINALID-N'; strip to short form
                    // so it matches the LS-/LE- class IDs used in edge extraction
                    const id = rawId.replace(/^flowchart-/, '').replace(/-\d+$/, '');
                    const nodeClasses = Array.from(node.classList).join(' ');
                    const transform = node.getAttribute('transform');
                    const match = /translate\(([^,]+),([^)]+)\)/.exec(transform || '');
                    const x = match ? parseFloat(match[1]) : 0;
                    const y = match ? parseFloat(match[2]) : 0;
                    
                    const rect = node.querySelector('rect, circle, polygon, path, ellipse') as SVGGraphicsElement;
                    const bbox = rect ? rect.getBBox() : { width: 0, height: 0, x: 0, y: 0 };
                    
                    // Infer shape type from classes and tags
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

                    // Extract styles
                    const computedStyle = window.getComputedStyle(rect || node);
                    const textEl = node.querySelector('div, span, text');
                    const textStyle = textEl ? window.getComputedStyle(textEl) : null;
                    
                    // Rounding (rx/ry)
                    let rounding = 0;
                    if (rect && rect.tagName.toLowerCase() === 'rect') {
                        const rx = parseFloat(rect.getAttribute('rx') || '0');
                        if (rx > 0) rounding = rx;
                    }

                    // Hyperlink
                    const anchor = node.querySelector('a') || node.closest('a');
                    const url = anchor ? anchor.getAttribute('href') || anchor.getAttribute('xlink:href') : undefined;

                    // Improved text extraction (preserve breaks)
                    let text = '';
                    if (textEl) {
                        // Clone to not mess up DOM
                        const clone = textEl.cloneNode(true) as HTMLElement;
                        // Replace <br> with newlines
                        const brs = clone.querySelectorAll('br');
                        brs.forEach(br => br.replaceWith('\n'));
                        text = clone.textContent?.trim() || '';
                    } else {
                        text = node.textContent?.trim() || '';
                    }

                    // Text Alignment
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
                edges: edges.map(path => {
                   const computedStyle = window.getComputedStyle(path);
                   
                   // Arrow detection
                   const markerStart = path.getAttribute('marker-start');
                   const markerEnd = path.getAttribute('marker-end');

                   // ID Extraction (Start/End Nodes)
                   // Mermaid v10+ puts classes on the group wrapping the path: <g class="edgePaths ... LS-startId LE-endId">
                   let startId, endId;
                   const parentGroup = path.parentElement;
                   if (parentGroup) {
                       const classes = Array.from(parentGroup.classList);
                       // Look for LS-* and LE-*
                       const ls = classes.find(c => c.startsWith('LS-'));
                       const le = classes.find(c => c.startsWith('LE-'));
                       if (ls) startId = ls.replace('LS-', '');
                       if (le) endId = le.replace('LE-', '');
                   }

                   return { 
                       d: path.getAttribute('d') || '',
                       startId,
                       endId,
                       arrowStart: !!markerStart, 
                       arrowEnd: !!markerEnd,
                       style: {
                           stroke: computedStyle.stroke,
                           strokeWidth: computedStyle.strokeWidth,
                           strokeDasharray: computedStyle.strokeDasharray
                       }
                   };
                }),
                clusters: clusters.map(c => {
                    // Re-map cluster styles to include dasharray
                    return {
                        ...c,
                        style: {
                            ...c.style,
                            strokeDasharray: c.style.strokeDasharray // Was missing in previous replacement
                        }
                    };
                }),
                labels
            };
        }, definition);

        return result;
    } finally {
        await browser.close();
    }
}
