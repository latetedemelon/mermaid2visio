// Flowchart-oriented extractor: nodes (.node), edges (.edgePaths path),
// subgraphs (.cluster) and edge labels (g.edgeLabel). Also what class, state
// and ER diagrams currently fall through to, since Mermaid renders them with
// the same node/edge scaffolding.

import type { GraphData } from '../core/types.js';

export function extractFlowchart(svg: SVGSVGElement, graphWidth: number, graphHeight: number): GraphData {
    // Since Mermaid 11.14 every internal element id (nodes, edges, clusters,
    // markers) is prefixed with the diagram's own SVG id, e.g.
    // "<svgId>-flowchart-A-0". Strip it so ids match what the user wrote.
    const idPrefix = svg.id ? `${svg.id}-` : '';
    const stripPrefix = (id: string) => (idPrefix && id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);

    const nodes = Array.from(svg.querySelectorAll('.node'));
    const edges = Array.from(svg.querySelectorAll('.edgePaths path'));

    // Clusters (Subgraphs)
    const clusters = Array.from(svg.querySelectorAll('.cluster')).map(cluster => {
        const id = stripPrefix(cluster.id);
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
        if (rect && svg) {
            const ctm = (rect as SVGGraphicsElement).getCTM();
            const svgCTM = svg.getScreenCTM();
            if (ctm && svgCTM) {
                const pt = svg.createSVGPoint();
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
    const rawEdgeLabels = Array.from(svg.querySelectorAll('g.edgeLabel')).map(labelG => {
        // Select foreignObject (SVG element, has getBBox) or SVG text;
        // avoid selecting the HTML <div> inside foreignObject (no getBBox).
        const contentEl = labelG.querySelector('foreignObject, text') as SVGGraphicsElement | null;
        const bbox = contentEl ? contentEl.getBBox() : { width: 0, height: 0, x: 0, y: 0 };

        let x = 0;
        let y = 0;
        const ctm = (labelG as SVGGraphicsElement).getCTM();
        const svgCTM = svg.getScreenCTM();
        if (ctm && svgCTM) {
            const pt = svg.createSVGPoint();
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
            const rawId = stripPrefix(node.id);
            // Mermaid emits node ids as "flowchart-<USERID>-<IDX>"
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
            if (rect && svg) {
                const ctm = (rect as SVGGraphicsElement).getCTM();
                const svgCTM = svg.getScreenCTM();
                if (ctm && svgCTM) {
                    const pt = svg.createSVGPoint();
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
            // data-id is the un-prefixed edge id; fall back to the element id.
            const edgeId = path.getAttribute('data-id') || stripPrefix(path.getAttribute('id') || '');
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
