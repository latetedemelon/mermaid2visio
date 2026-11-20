// Extractor for every diagram Mermaid draws with its unified renderer:
// flowchart, class, state, ER, requirement, mindmap, kanban, usecase,
// swimlane, agentflow. They all share one SVG scaffold (.node, .cluster,
// .edgePaths path, g.edgeLabel).
//
// Geometry comes from the DOM. Meaning comes from Mermaid's parsed model when
// it is available: which node an element is, where an edge starts and ends,
// what sits at each end, the line pattern and the shape's name. None of that
// is reliably recoverable from the SVG alone.

import type { GraphCluster, GraphData, GraphEdge, GraphLabel, GraphNode } from '../core/types.js';
import type { ModelEdge, UnifiedModel } from './model.js';
import { all, toRootPoint, translateOf, type Box } from './dom.js';

// Mermaid shape name (and its aliases) -> the geometry family the generator
// draws. Anything not listed is drawn as a rectangle for now.
const SHAPE_TYPE: Record<string, string> = {
    rect: 'rectangle', squareRect: 'rectangle', roundedRect: 'rectangle', rounded: 'rectangle',
    stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
    diamond: 'diamond', diam: 'diamond', question: 'diamond', decision: 'diamond', choice: 'diamond',
    cylinder: 'cylinder', cyl: 'cylinder', database: 'cylinder', db: 'cylinder',
    subroutine: 'subroutine', subproc: 'subroutine', subprocess: 'subroutine', 'fr-rect': 'subroutine', 'framed-rectangle': 'subroutine',
    circle: 'circle', circ: 'circle', doublecircle: 'circle', 'dbl-circ': 'circle', 'double-circle': 'circle',
    stateStart: 'circle', stateEnd: 'circle', mindmapCircle: 'circle',
    ellipse: 'ellipse', usecaseEllipse: 'ellipse',
    lean_right: 'parallelogram', 'lean-r': 'parallelogram', 'lean-right': 'parallelogram', 'in-out': 'parallelogram',
    lean_left: 'parallelogram', 'lean-l': 'parallelogram', 'lean-left': 'parallelogram', 'out-in': 'parallelogram',
};

const visiblePaint = (value: string | null | undefined): boolean => {
    if (!value || value === 'none' || value === 'transparent') return false;
    const alpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(value)?.[1];
    return alpha === undefined || parseFloat(alpha) > 0;
};

// Bounding box of `el` in the root SVG's user space.
function rootBox(svg: SVGSVGElement, el: Element | null | undefined, fallbackFrom?: Element | null): Box {
    if (!el) return { x: 0, y: 0, width: 0, height: 0 };
    const b = (el as SVGGraphicsElement).getBBox();
    const p1 = toRootPoint(svg, el, b.x, b.y);
    const p2 = toRootPoint(svg, el, b.x + b.width, b.y + b.height);
    if (p1 && p2) {
        return {
            x: Math.min(p1.x, p2.x),
            y: Math.min(p1.y, p2.y),
            width: Math.abs(p2.x - p1.x),
            height: Math.abs(p2.y - p1.y),
        };
    }
    // No CTM available: fall back to the owning group's translate().
    const t = translateOf(fallbackFrom ?? el);
    return { x: t.x + b.x, y: t.y + b.y, width: b.width, height: b.height };
}

interface LabelInfo {
    text: string;
    // Element whose computed style describes the text.
    styleEl: Element | null;
    // Element whose box is the label's extent.
    boxEl: Element | null;
}

const tidy = (text: string): string => text.split('\n').map(l => l.trim()).join('\n').trim();

// Reads a label rendered either as HTML (foreignObject) or as SVG text.
function readLabel(root: Element | null | undefined): LabelInfo {
    if (!root) return { text: '', styleEl: null, boxEl: null };
    const fo = root.querySelector('foreignObject');
    if (fo) {
        const clone = fo.cloneNode(true) as Element;
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        const paragraphs = Array.from(clone.querySelectorAll('p'));
        const text = paragraphs.length > 1
            ? paragraphs.map(p => p.textContent || '').join('\n')
            : clone.textContent || '';
        const styleEl = fo.querySelector('.nodeLabel, .edgeLabel') ?? fo.querySelector('span, p, div') ?? fo;
        return { text: tidy(text), styleEl, boxEl: fo };
    }
    const textEl = root.querySelector('text');
    if (textEl) {
        // Mermaid wraps each line in a top-level tspan.
        const lines = Array.from(textEl.children).filter(c => c.tagName.toLowerCase() === 'tspan');
        const text = lines.length > 1 ? lines.map(l => l.textContent || '').join('\n') : textEl.textContent || '';
        return { text: tidy(text), styleEl: textEl, boxEl: textEl };
    }
    return { text: tidy(root.textContent || ''), styleEl: root, boxEl: null };
}

// The element(s) that draw a node's outline. Simple shapes are one element;
// most newer shapes are a group holding a fill path and a stroke path.
function outlineOf(node: Element): { el: SVGGraphicsElement | null; fillEl: Element | null; strokeEl: Element | null } {
    const el = (node.querySelector('.label-container') ?? node.querySelector('rect, circle, polygon, path, ellipse')) as SVGGraphicsElement | null;
    if (!el) return { el: null, fillEl: null, strokeEl: null };
    if (el.tagName.toLowerCase() !== 'g') return { el, fillEl: el, strokeEl: el };
    const parts = all(el, 'path, rect, circle, ellipse, polygon');
    const fillEl = parts.find(p => visiblePaint(window.getComputedStyle(p).fill)) ?? parts[0] ?? el;
    const strokeEl = parts.find(p => visiblePaint(window.getComputedStyle(p).stroke)) ?? parts[0] ?? el;
    return { el, fillEl, strokeEl };
}

// Shape guess from the SVG alone, used only when Mermaid's model is missing.
function typeFromDom(node: Element, el: Element | null): string {
    if (!el) return 'rectangle';
    const tag = el.tagName.toLowerCase();
    if (Array.from(node.classList).join(' ').includes('stadium')) return 'stadium';
    if (tag === 'circle') return 'circle';
    if (tag === 'ellipse') return 'ellipse';
    if (tag === 'polygon') {
        const nums = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(parseFloat);
        if (nums.length !== 8) return nums.length > 8 ? 'subroutine' : 'rectangle';
        const xs = [nums[0], nums[2], nums[4], nums[6]];
        const ys = [nums[1], nums[3], nums[5], nums[7]];
        // A diamond has one vertex on each side of its bounding box, so no
        // two vertices share an extreme x or an extreme y.
        const count = (arr: number[], v: number) => arr.filter(a => Math.abs(a - v) < 0.5).length;
        const diamond = [Math.min(...xs), Math.max(...xs)].every(v => count(xs, v) === 1)
            && [Math.min(...ys), Math.max(...ys)].every(v => count(ys, v) === 1);
        if (diamond) return 'diamond';
        // Four corners on two horizontal lines: rectangle if the sides are
        // vertical, otherwise a parallelogram/trapezoid.
        return count(xs, Math.min(...xs)) === 2 && count(xs, Math.max(...xs)) === 2 ? 'rectangle' : 'parallelogram';
    }
    return 'rectangle';
}

// Recover an edge's endpoints from an auto-generated id "L_<start>_<end>_<n>".
// Ids may themselves contain underscores, so try every split and keep the one
// where both halves are ids that actually exist.
function endpointsFromId(edgeId: string, known: Set<string>): { start?: string; end?: string } {
    const body = /^L_(.+)_\d+$/.exec(edgeId)?.[1];
    if (!body) return {};
    for (let i = body.indexOf('_'); i > 0; i = body.indexOf('_', i + 1)) {
        const start = body.slice(0, i);
        const end = body.slice(i + 1);
        if (known.has(start) && known.has(end)) return { start, end };
    }
    const greedy = /^(.+)_(.+)$/.exec(body);
    return greedy ? { start: greedy[1], end: greedy[2] } : {};
}

const isArrow = (kind: string | undefined): boolean => !!kind && kind !== 'none';

function patternOf(edge: ModelEdge | undefined): GraphEdge['pattern'] {
    if (!edge) return undefined;
    if (edge.pattern === 'dotted') return 'dotted';
    if (edge.pattern === 'dashed') return 'dashed';
    return 'solid';
}

export function extractUnified(
    svg: SVGSVGElement,
    graphWidth: number,
    graphHeight: number,
    model: UnifiedModel | null,
): GraphData {
    // Since Mermaid 11.14 every internal element id (nodes, edges, clusters,
    // markers) is prefixed with the diagram's own SVG id, e.g.
    // "<svgId>-flowchart-A-0". Strip it so ids match what the user wrote.
    const idPrefix = svg.id ? `${svg.id}-` : '';
    const stripPrefix = (id: string) => (idPrefix && id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);

    // ---------------------------------------------------------- subgraphs
    const clusters: GraphCluster[] = all(svg, '.cluster').map(cluster => {
        const domId = stripPrefix(cluster.id);
        const modelNode = model?.resolveNode(domId);
        const frame = cluster.querySelector('rect, polygon, path');
        const box = rootBox(svg, frame, cluster);
        const label = readLabel(cluster.querySelector('.cluster-label') ?? cluster);
        const frameStyle = window.getComputedStyle(frame || cluster);
        const textStyle = label.styleEl ? window.getComputedStyle(label.styleEl) : null;
        return {
            id: modelNode?.id ?? domId,
            ...box,
            text: label.text || undefined,
            parentId: modelNode?.parentId,
            style: {
                fill: frameStyle.fill,
                stroke: frameStyle.stroke,
                strokeWidth: frameStyle.strokeWidth,
                strokeDasharray: frameStyle.strokeDasharray,
                color: textStyle ? textStyle.color : '#000000',
            },
        };
    });

    // -------------------------------------------------------------- nodes
    const nodes: GraphNode[] = all(svg, '.node').map(node => {
        const domId = stripPrefix(node.id);
        const modelNode = model?.resolveNode(domId);
        // Without a model, peel the "flowchart-<id>-<n>" scaffold by hand.
        const id = modelNode?.id ?? /^flowchart-(.+)-\d+$/.exec(domId)?.[1] ?? domId;

        const outline = outlineOf(node);
        const box = rootBox(svg, outline.el, node);
        const fillStyle = window.getComputedStyle(outline.fillEl || node);
        const strokeStyle = window.getComputedStyle(outline.strokeEl || node);

        const type = modelNode?.shape
            ? SHAPE_TYPE[modelNode.shape] ?? (outline.el?.tagName.toLowerCase() === 'circle' ? 'circle' : outline.el?.tagName.toLowerCase() === 'ellipse' ? 'ellipse' : 'rectangle')
            : typeFromDom(node, outline.el);

        let rounding = 0;
        if (outline.el?.tagName.toLowerCase() === 'rect') {
            const rx = parseFloat(outline.el.getAttribute('rx') || '0');
            if (rx > 0) rounding = rx;
        }

        const label = readLabel(node.querySelector('.label') ?? node);
        const textStyle = label.styleEl ? window.getComputedStyle(label.styleEl) : null;
        let textAlign = 'center';
        const anchorVal = textStyle?.getPropertyValue('text-anchor');
        if (anchorVal === 'start') textAlign = 'left';
        else if (anchorVal === 'end') textAlign = 'right';

        const anchor = node.querySelector('a') || node.closest('a');
        const url = (anchor ? anchor.getAttribute('href') || anchor.getAttribute('xlink:href') : undefined) || undefined;

        return {
            id,
            ...box,
            text: label.text,
            type,
            shape: modelNode?.shape,
            parentId: modelNode?.parentId,
            rounding,
            url,
            style: {
                fill: fillStyle.fill,
                stroke: strokeStyle.stroke,
                strokeWidth: strokeStyle.strokeWidth,
                strokeDasharray: strokeStyle.strokeDasharray,
                color: textStyle ? textStyle.color : '#000000',
                fontSize: textStyle ? textStyle.fontSize : undefined,
                fontFamily: textStyle ? textStyle.fontFamily : undefined,
                fontWeight: textStyle ? textStyle.fontWeight : undefined,
                fontStyle: textStyle ? textStyle.fontStyle : undefined,
                textAlign,
            },
        };
    });

    const knownIds = new Set<string>([...nodes.map(n => n.id), ...clusters.map(c => c.id)]);

    // -------------------------------------------------------- edge labels
    // Each g.edgeLabel holds a g.label carrying the id of the edge it
    // belongs to; that id is the join key. DOM order is kept only as a
    // fallback for output without those ids.
    interface RawLabel extends GraphLabel { edgeId?: string; used?: boolean }
    const rawLabels: RawLabel[] = all(svg, 'g.edgeLabel').map(labelG => {
        const info = readLabel(labelG);
        const box = rootBox(svg, info.boxEl ?? labelG, labelG);
        const bg = labelG.querySelector('.labelBkg, .label-container rect, rect.background');
        const bgFill = bg ? window.getComputedStyle(bg).fill : undefined;
        const textStyle = window.getComputedStyle(info.styleEl ?? labelG);
        return {
            edgeId: labelG.querySelector('[data-id]')?.getAttribute('data-id') || labelG.getAttribute('data-id') || undefined,
            x: box.x,
            y: box.y,
            width: box.width || 10,
            height: box.height || 10,
            text: info.text,
            style: {
                color: textStyle.color,
                fill: visiblePaint(bgFill) ? bgFill : undefined,
                fontSize: textStyle.fontSize,
                fontFamily: textStyle.fontFamily,
                fontWeight: textStyle.fontWeight,
                fontStyle: textStyle.fontStyle,
            },
        };
    });
    const labelByEdgeId = new Map<string, RawLabel>();
    for (const l of rawLabels) if (l.edgeId && !labelByEdgeId.has(l.edgeId)) labelByEdgeId.set(l.edgeId, l);

    // -------------------------------------------------------------- edges
    const edgePaths = Array.from(new Set([
        ...all<SVGPathElement>(svg, '.edgePaths path'),
        ...all<SVGPathElement>(svg, 'path[data-edge="true"]'),
    ]));
    const edges: GraphEdge[] = [];
    edgePaths.forEach((path, index) => {
        // data-id is the un-prefixed edge id; fall back to the element id.
        const edgeId = path.getAttribute('data-id') || stripPrefix(path.getAttribute('id') || '');
        const modelEdge = model?.edgeById.get(edgeId);

        // `A ~~~ B` only influences layout; it is not drawn.
        if (modelEdge?.pattern === 'invisible' || path.classList.contains('edge-thickness-invisible')) return;

        const fromId = modelEdge ? { start: modelEdge.start, end: modelEdge.end } : endpointsFromId(edgeId, knownIds);
        const startKind = modelEdge ? modelEdge.arrowTypeStart ?? 'none' : undefined;
        const endKind = modelEdge ? modelEdge.arrowTypeEnd ?? 'none' : undefined;

        const label = labelByEdgeId.get(edgeId) ?? (rawLabels[index]?.edgeId ? undefined : rawLabels[index]);
        if (label) label.used = true;
        const labelText = label?.text || undefined;

        const style = window.getComputedStyle(path);
        edges.push({
            d: path.getAttribute('d') || '',
            startId: fromId.start,
            endId: fromId.end,
            arrowStart: modelEdge ? isArrow(startKind) : !!path.getAttribute('marker-start'),
            arrowEnd: modelEdge ? isArrow(endKind) : !!path.getAttribute('marker-end'),
            arrowStartKind: startKind,
            arrowEndKind: endKind,
            pattern: patternOf(modelEdge),
            text: labelText,
            ...(labelText && label ? { labelX: label.x, labelY: label.y, labelWidth: label.width, labelHeight: label.height } : {}),
            // Forward label font styling alongside the text so the
            // generator can emit a matching Character section.
            labelStyle: labelText && label ? {
                color: label.style?.color,
                fontSize: label.style?.fontSize,
                fontWeight: label.style?.fontWeight,
                fontStyle: label.style?.fontStyle,
            } : undefined,
            style: {
                stroke: style.stroke,
                strokeWidth: style.strokeWidth,
                strokeDasharray: style.strokeDasharray,
            },
        });
    });

    // Labels that belong to no edge stand alone.
    const labels: GraphLabel[] = rawLabels
        .filter(l => !l.used && l.text)
        .map(({ edgeId: _edgeId, used: _used, ...label }) => label);

    return { width: graphWidth, height: graphHeight, nodes, edges, clusters, labels };
}
