// Extractor for diagrams Mermaid draws with its own per-type renderers but
// which are still graphs: boxes joined by lines (C4, architecture). Each box
// becomes one Visio shape (or a group, when it has several differently
// coloured parts), each line a connector attached to the boxes it touches,
// and anything not recognised is drawn as free-form shapes and text so
// nothing is lost. Document order is kept as the stacking order.

import type { GraphCluster, GraphData, GraphEdge, GraphLabel, GraphNode } from '../core/types.js';
import { pathBounds } from '../core/normalize.js';
import { all, rootBox, textColor, type Box } from './dom.js';
import { DRAWABLE, outlinePaint, primitiveNode, rootPathData, textLabels } from './primitives.js';
import { endpointsFromId } from './unified.js';

export interface DrawnGraphSpec {
    // The groups that are boxes.
    nodes: string;
    // A box's id from its (svg-id-stripped) DOM id.
    nodeId(domId: string): string;
    // The elements that are lines between boxes.
    edges: string;
    // Endpoints encoded in an edge's own id, when the renderer does that.
    endpointsFromId?: boolean;
    // Text elements that label an edge.
    edgeLabels?(edge: Element): Element[];
    // Background rectangles that are groups of boxes.
    clusters?: string;
    clusterId?(domId: string): string;
}

const OUTSIDE = 'defs, marker, symbol';

function distanceToBox(p: { x: number; y: number }, b: Box): number {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
    return Math.hypot(dx, dy);
}

function unionBox(boxes: Box[]): Box | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
        if (b.width === 0 && b.height === 0) continue;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

// A box as one node: a single drawn piece carrying its text, or a group of
// differently coloured pieces with its texts.
export function boxNode(svg: SVGSVGElement, el: Element, id: string): GraphNode | null {
    const drawables = all(el, DRAWABLE).filter(d => !d.closest(OUTSIDE));
    const parts = drawables
        .map((d, i) => primitiveNode(svg, d, `${id}-part-${i}`))
        .filter((n): n is GraphNode => !!n);
    const texts = textLabels(svg, el);
    const box = unionBox([...parts, ...texts]);
    if (!box) return null;
    if (parts.length === 1 && texts.length <= 1) {
        const [part] = parts;
        const [text] = texts;
        return {
            ...part,
            id,
            text: text?.text ?? '',
            ...(text ? { textX: text.x, textY: text.y, textWidth: text.width, textHeight: text.height } : {}),
            style: { ...part.style, ...text?.style, textAlign: 'center' },
        };
    }
    return {
        id, ...box, text: '', type: 'group', parts, children: texts,
        style: outlinePaint(svg, el),
    };
}

export function extractDrawnGraph(svg: SVGSVGElement, graphWidth: number, graphHeight: number, spec: DrawnGraphSpec): GraphData {
    const idPrefix = svg.id ? `${svg.id}-` : '';
    const stripPrefix = (id: string) => (idPrefix && id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);

    interface Entry { anchor: Element; node?: GraphNode; label?: GraphLabel }
    const entries: Entry[] = [];
    const claimed = new Set<Element>();
    const isClaimed = (el: Element): boolean => {
        for (let cur: Element | null = el; cur && (cur as Element) !== svg; cur = cur.parentElement) {
            if (claimed.has(cur)) return true;
        }
        return false;
    };

    // ------------------------------------------------------------- boxes
    const nodes: GraphNode[] = [];
    for (const el of all(svg, spec.nodes)) {
        if (isClaimed(el)) continue;
        const node = boxNode(svg, el, spec.nodeId(stripPrefix(el.id || '')) || `box-${nodes.length}`);
        if (!node) continue;
        claimed.add(el);
        nodes.push(node);
        entries.push({ anchor: el, node });
    }
    const known = new Set(nodes.map(n => n.id));

    // ---------------------------------------------------------- clusters
    const clusters: GraphCluster[] = [];
    for (const el of spec.clusters ? all(svg, spec.clusters) : []) {
        if (isClaimed(el)) continue;
        claimed.add(el);
        const cs = window.getComputedStyle(el);
        clusters.push({
            id: spec.clusterId ? spec.clusterId(stripPrefix(el.id || '')) : stripPrefix(el.id || `group-${clusters.length}`),
            ...rootBox(svg, el),
            style: { fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth, strokeDasharray: cs.strokeDasharray },
        });
    }

    // ------------------------------------------------------------- lines
    const edges: GraphEdge[] = [];
    for (const el of all(svg, spec.edges)) {
        if (isClaimed(el) || el.closest(OUTSIDE)) continue;
        const d = rootPathData(svg, el);
        const bounds = d ? pathBounds(d) : null;
        if (!d || !bounds) continue;
        claimed.add(el);

        let ends: { start?: string; end?: string } = {};
        if (spec.endpointsFromId) ends = endpointsFromId(stripPrefix(el.id || ''), known);
        if (!ends.start || !ends.end || !known.has(ends.start) || !known.has(ends.end)) {
            // Otherwise: the box each end of the line touches.
            const nums = (d.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(parseFloat);
            const first = { x: nums[0], y: nums[1] };
            const last = { x: nums[nums.length - 2], y: nums[nums.length - 1] };
            const nearest = (p: { x: number; y: number }) => {
                let best: GraphNode | undefined, bestDist = 30;
                for (const n of nodes) {
                    const dist = distanceToBox(p, n);
                    if (dist < bestDist) { best = n; bestDist = dist; }
                }
                return best?.id;
            };
            ends = { start: nearest(first), end: nearest(last) };
        }

        const labelEls = spec.edgeLabels ? spec.edgeLabels(el).filter(t => !isClaimed(t)) : [];
        labelEls.forEach(t => claimed.add(t));
        const labelTexts = labelEls.map(t => (t.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const labelBox = unionBox(labelEls.map(t => rootBox(svg, t)));
        const labelCs = labelEls[0] ? window.getComputedStyle(labelEls[0]) : null;

        const cs = window.getComputedStyle(el);
        const dash = parseFloat(cs.strokeDasharray);
        const hasStart = !!el.getAttribute('marker-start');
        const hasEnd = !!el.getAttribute('marker-end');
        edges.push({
            d,
            startId: ends.start,
            endId: ends.end,
            arrowStart: hasStart, arrowEnd: hasEnd,
            arrowStartKind: hasStart ? 'arrow_point' : 'none',
            arrowEndKind: hasEnd ? 'arrow_point' : 'none',
            pattern: Number.isFinite(dash) && dash > 0 ? (dash <= 2 ? 'dotted' : 'dashed') : 'solid',
            text: labelTexts.length ? labelTexts.join('\n') : undefined,
            ...(labelBox ? { labelX: labelBox.x, labelY: labelBox.y, labelWidth: labelBox.width, labelHeight: labelBox.height } : {}),
            labelStyle: labelCs ? { color: textColor(labelEls[0]), fontSize: labelCs.fontSize, fontWeight: labelCs.fontWeight, fontStyle: labelCs.fontStyle } : undefined,
            style: { stroke: cs.stroke, strokeWidth: cs.strokeWidth, strokeDasharray: cs.strokeDasharray },
        });
    }

    // ---------------------------------------------------------- the rest
    let counter = 0;
    for (const el of all(svg, DRAWABLE)) {
        if (isClaimed(el) || el.closest(OUTSIDE)) continue;
        const node = primitiveNode(svg, el, `shape-${counter++}`);
        if (node) entries.push({ anchor: el, node });
    }
    for (const el of all(svg, 'text, foreignObject')) {
        if (isClaimed(el) || el.closest(OUTSIDE) || el.parentElement?.closest('foreignObject, text')) continue;
        claimed.add(el);
        const holder = el.tagName.toLowerCase() === 'text' ? { querySelectorAll: () => [el] } as unknown as Element : el.parentElement!;
        for (const label of textLabels(svg, holder)) entries.push({ anchor: el, label });
    }

    entries.sort((a, b) =>
        a.anchor === b.anchor ? 0
            : a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    return {
        width: graphWidth, height: graphHeight,
        nodes: entries.flatMap(e => (e.node ? [e.node] : [])),
        edges,
        clusters,
        labels: entries.flatMap(e => (e.label ? [e.label] : [])),
    };
}

// Following text siblings: how C4 places a relationship's label and
// technology right after its line.
function followingTexts(el: Element): Element[] {
    const out: Element[] = [];
    for (let sib = el.nextElementSibling; sib && sib.tagName.toLowerCase() === 'text'; sib = sib.nextElementSibling) out.push(sib);
    return out;
}

export const C4_SPEC: DrawnGraphSpec = {
    nodes: '.c4-shape',
    nodeId: id => id,
    edges: 'line[marker-end], line[marker-start], path[marker-end], path[marker-start]',
    edgeLabels: followingTexts,
};

export const ARCHITECTURE_SPEC: DrawnGraphSpec = {
    nodes: '.architecture-service, .architecture-junction',
    nodeId: id => id.replace(/^(service|junction)-/, ''),
    edges: '.architecture-edges path.edge',
    endpointsFromId: true,
    clusters: '.architecture-groups rect.node-bkg',
    clusterId: id => id.replace(/^group-/, ''),
};
