// Render + extract — the two functions that touch the DOM. Lifted to module
// scope so:
//   (a) Puppeteer can serialize them by reference for page.evaluate (the Node
//       parseMermaid path injects mermaid + ELK into a page, then calls
//       page.evaluate(renderMermaidToDom, def) and
//       page.evaluate(extractGraphFromDom, dtype));
//   (b) a browser build can import them and run them against the real
//       document — no Puppeteer, no Node modules.
//
// Both functions reference ONLY their parameter and browser globals
// (document, window, console, Math, Array, parseFloat, parseInt, regex
// literals, language built-ins). They MUST NOT import or close over anything
// else, or the page.evaluate serialization breaks.

import type { GraphData } from './types.js';

// Renders Mermaid source into the host DOM. The `mermaid` global must already
// be available (the Node path injects it via Puppeteer addScriptTag; the
// browser build imports it normally before calling this).
export async function renderMermaidToDom(def: string): Promise<void> {
    try {
        // @ts-ignore - mermaid is a page/window global
        const { svg } = await mermaid.render('graphDiv', def);
        document.body.innerHTML = svg;
    } catch (renderErr: any) {
        // Tagged so parseMermaid can recognise a Mermaid render failure
        // (vs. a DOM bug in our extraction code) and apply formatMermaidError.
        const msg = renderErr?.message ?? String(renderErr);
        throw new Error('__MERMAID_RENDER_ERROR__:' + msg);
    }
}

// Extracts a GraphData (still in raw SVG coordinates — normalizeContentBounds
// translates to top-left origin) from the rendered SVG in document.body.
// Branches on diagram type so sequence diagrams (different SVG structure)
// hit a dedicated path.
export function extractGraphFromDom(dtype: string): GraphData {
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
                labelStyle: tEl ? {
                    color: ts?.color, fontSize: ts?.fontSize,
                    fontWeight: ts?.fontWeight, fontStyle: ts?.fontStyle,
                } : undefined,
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
                const anchorVal = textStyle.getPropertyValue('text-anchor');
                if (anchorVal === 'start') textAlign = 'left';
                else if (anchorVal === 'end') textAlign = 'right';
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
    } as GraphData;
}
