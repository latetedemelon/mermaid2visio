// Sequence-diagram extractor. Sequence SVG has its own structure (no
// .node/.edgePaths scaffold); Mermaid tags the important parts with
// data-et: participant, life-line, message, note, control-structure.
//
// - Participants of every kind (box, stick figure, boundary, control,
//   entity, database, collections, queue), top and bottom copies, become one
//   shape each with the participant's name.
// - Lifelines and messages become lines, with arrowheads read from their
//   markers and captions placed where Mermaid drew them.
// - Activation bars and notes become rectangles.
// - Frames (loop, alt, opt, par, critical, break) become one grouped shape:
//   outline, separators and label box, with every label in place.
// - Autonumber badges become numbered circles.
// - Anything else Mermaid draws (group boxes, highlight rectangles, their
//   labels, and whatever future versions add) is drawn as free-form shapes
//   and text, so nothing is silently dropped.
//
// Everything is kept in document order, which is Mermaid's stacking order.

import type { GraphData, GraphEdge, GraphLabel, GraphNode } from '../core/types.js';
import { all, readLabel, rootBox, textColor, visiblePaint } from './dom.js';
import { DRAWABLE, outlinePaint, outlinePaths, primitiveNode, textLabels } from './primitives.js';

// Sequence markers are referenced as url(#<svgId>-<name>).
function markerKind(ref: string | null): string {
    const name = /#[^)]*?-?(arrowhead|crosshead|filled-head|solidTopArrowHead|solidBottomArrowHead|stickTopArrowHead|stickBottomArrowHead)\)?$/.exec(ref || '')?.[1];
    if (!name) return 'none';
    if (name === 'crosshead') return 'arrow_cross';
    if (name === 'filled-head') return 'open_head';
    return 'arrow_point';
}

const num = (el: Element | null, attr: string) => parseFloat(el?.getAttribute(attr) || '0') || 0;

const textStyleOf = (el: Element | null) => {
    if (!el) return {};
    const cs = window.getComputedStyle(el);
    return {
        color: textColor(el),
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
    };
};

interface Entry {
    // Element whose document position decides the stacking order.
    anchor: Element;
    node?: GraphNode;
    edge?: GraphEdge;
    label?: GraphLabel;
}

export function extractSequence(svg: SVGSVGElement, graphWidth: number, graphHeight: number): GraphData {
    const entries: Entry[] = [];
    // Elements already accounted for; they and their descendants are not
    // drawn again by the catch-all at the end.
    const claimed = new Set<Element>();
    const isClaimed = (el: Element): boolean => {
        for (let cur: Element | null = el; cur && cur !== svg; cur = cur.parentElement) {
            if (claimed.has(cur)) return true;
        }
        return false;
    };
    let counter = 0;
    const nextId = (kind: string) => `seq-${kind}-${counter++}`;

    // ------------------------------------------------------ participants
    // Top copies are tagged; bottom copies only carry the actor-bottom
    // class, sometimes on a bare <rect> whose name is a sibling <text>.
    // A bottom copy that is a bare shape sits in its own small group with
    // the rest of its drawing and its name; that group is the participant.
    const bottomRoot = (el: Element): Element => {
        const parent = el.parentElement;
        if (!parent || (parent as Element) === svg || parent.tagName.toLowerCase() !== 'g') return el;
        const ownsOnlyThis = parent.querySelectorAll('.actor-bottom').length === 1 && !parent.querySelector('[data-et]');
        return ownsOnlyThis ? parent : el;
    };
    const participantRoots = [
        ...all(svg, '[data-et="participant"]'),
        ...all(svg, '.actor-bottom')
            .filter(el => !el.parentElement?.closest('.actor-bottom') && !el.closest('[data-et="participant"]'))
            .map(bottomRoot),
    ];
    const actorTexts = all<SVGGraphicsElement>(svg, 'text.actor');
    for (const root of participantRoots) {
        if (isClaimed(root)) continue;
        // The participant's name: inside the drawing when it is a group,
        // otherwise the actor text whose centre sits in the box.
        const box = rootBox(svg, root);
        let nameEl: Element | null = root.tagName.toLowerCase() === 'text' ? root : root.querySelector('text');
        if (!nameEl) {
            nameEl = actorTexts.find(t => {
                if (claimed.has(t)) return false;
                const b = rootBox(svg, t);
                const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
                return cx >= box.x && cx <= box.x + box.width && cy >= box.y - 4 && cy <= box.y + box.height + 30;
            }) ?? null;
        }
        const name = readLabel(nameEl ? wrap(nameEl) : null);

        const drawables = root.matches(DRAWABLE) ? [root] : all(root, DRAWABLE).filter(el => !el.closest('defs, marker'));
        const singleRect = drawables.length === 1 && drawables[0].tagName.toLowerCase() === 'rect';
        let node: GraphNode;
        if (singleRect) {
            const rect = drawables[0];
            const cs = window.getComputedStyle(rect);
            node = {
                id: nextId('actor'),
                ...rootBox(svg, rect),
                text: name.text,
                type: 'rectangle',
                rounding: num(rect, 'rx') || undefined,
                style: { fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth, ...textStyleOf(name.styleEl), textAlign: 'center' },
            };
        } else {
            // Stick figures and symbols: the outline exactly as drawn, with
            // the name where Mermaid put it (usually underneath).
            const outlineBox = drawables.length ? unionBox(svg, drawables) : box;
            const nameBox = name.boxEl ? rootBox(svg, name.boxEl) : null;
            node = {
                id: nextId('actor'),
                ...outlineBox,
                text: name.text,
                type: 'path',
                paths: outlinePaths(svg, root, outlineBox),
                ...(nameBox ? { textX: nameBox.x, textY: nameBox.y, textWidth: nameBox.width, textHeight: nameBox.height } : {}),
                style: { ...outlinePaint(svg, root), ...textStyleOf(name.styleEl), textAlign: 'center' },
            };
        }
        claimed.add(root);
        if (nameEl) claimed.add(nameEl);
        entries.push({ anchor: root, node });
    }

    // --------------------------------------------------------- lifelines
    for (const ll of all(svg, 'line.actor-line, [data-et="life-line"]')) {
        if (claimed.has(ll)) continue;
        claimed.add(ll);
        const cs = window.getComputedStyle(ll);
        entries.push({
            anchor: ll,
            edge: {
                d: `M ${num(ll, 'x1')} ${num(ll, 'y1')} L ${num(ll, 'x2')} ${num(ll, 'y2')}`,
                arrowStart: false, arrowEnd: false,
                pattern: 'dashed',
                style: { stroke: visiblePaint(cs.stroke) ? cs.stroke : '#999999', strokeWidth: cs.strokeWidth || '1px', strokeDasharray: '3,3' },
            },
        });
    }

    // ------------------------------------------------------ activations
    for (const a of all(svg, 'rect[class*="activation"]')) {
        claimed.add(a);
        const cs = window.getComputedStyle(a);
        entries.push({
            anchor: a,
            node: {
                id: nextId('activation'), ...rootBox(svg, a),
                text: '', type: 'rectangle', rounding: 0,
                style: { fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth, color: '#000000' },
            },
        });
    }

    // ------------------------------------------------------------- notes
    for (const rect of all(svg, 'rect.note')) {
        const group = rect.closest('[data-et="note"]') ?? rect.parentElement ?? rect;
        const box = rootBox(svg, rect);
        // The note's text is in the same group; fall back to containment.
        const textEl = group.querySelector('text.noteText') ?? all(svg, 'text.noteText').find(t => {
            const b = rootBox(svg, t);
            const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
            return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
        }) ?? null;
        const text = textEl ? textLines(textEl) : '';
        const cs = window.getComputedStyle(rect);
        claimed.add(rect);
        if (textEl) claimed.add(textEl);
        entries.push({
            anchor: rect,
            node: {
                id: nextId('note'), ...box, text, type: 'rectangle', rounding: 0,
                style: { fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth, ...textStyleOf(textEl), textAlign: 'center' },
            },
        });
    }

    // ------------------------------------------------------------ frames
    for (const frame of all(svg, '[data-et="control-structure"]')) {
        const box = rootBox(svg, frame);
        const paths = outlinePaths(svg, frame, box);
        if (!paths.length) continue;
        claimed.add(frame);
        entries.push({
            anchor: frame,
            node: {
                id: nextId('frame'), ...box, text: '', type: 'path', paths,
                children: textLabels(svg, frame),
                style: outlinePaint(svg, frame),
            },
        });
    }

    // ---------------------------------------------------------- messages
    const msgLines = all(svg, 'line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1');
    const msgTexts = all<SVGGraphicsElement>(svg, 'text.messageText');
    const numberTexts = all<SVGGraphicsElement>(svg, 'text.sequenceNumber');
    msgLines.forEach((ml, i) => {
        claimed.add(ml);
        const dashed = (ml.getAttribute('class') || '').includes('messageLine1');
        const x1 = num(ml, 'x1'), y1 = num(ml, 'y1'), x2 = num(ml, 'x2'), y2 = num(ml, 'y2');
        const d = ml.getAttribute('d') || `M ${x1} ${y1} L ${x2} ${y2}`;
        const cs = window.getComputedStyle(ml);
        const tEl = msgTexts[i];
        const text = tEl ? textLines(tEl) : '';
        if (tEl) claimed.add(tEl);
        const labelBox = tEl && text ? rootBox(svg, tEl) : null;
        const startKind = markerKind(ml.getAttribute('marker-start'));
        const endKind = markerKind(ml.getAttribute('marker-end'));
        entries.push({
            anchor: ml,
            edge: {
                d,
                // The arrowhead, if any, is a marker reference: `A->B` draws a
                // plain line, `A->>B` an arrowhead, `A<<->>B` one at each end.
                // (`autonumber` also uses marker-start, for the number badge,
                // which markerKind() reports as 'none'.)
                arrowStart: startKind !== 'none',
                arrowEnd: endKind !== 'none',
                arrowStartKind: startKind,
                arrowEndKind: endKind,
                pattern: dashed ? 'dashed' : 'solid',
                text: text || undefined,
                // Mermaid draws the caption above its line; keep it there.
                ...(labelBox ? { labelX: labelBox.x, labelY: labelBox.y, labelWidth: labelBox.width, labelHeight: labelBox.height } : {}),
                labelStyle: tEl ? textStyleOf(tEl) : undefined,
                style: {
                    stroke: visiblePaint(cs.stroke) ? cs.stroke : '#333333',
                    strokeWidth: cs.strokeWidth || '1px',
                    strokeDasharray: dashed ? '3,3' : undefined,
                },
            },
        });
    });

    // -------------------------------------------------- autonumber badges
    // Each badge is a zero-length line whose start marker draws the circle;
    // the number is a separate text centred on it.
    for (const badge of all(svg, 'line[marker-start*="sequencenumber"], path[marker-start*="sequencenumber"]')) {
        claimed.add(badge);
        const cx = num(badge, 'x1'), cy = num(badge, 'y1');
        const markerId = /#([^)"']+)/.exec(badge.getAttribute('marker-start') || '')?.[1];
        const marker = markerId ? svg.querySelector(`[id="${markerId}"]`) : null;
        const circle = marker?.querySelector('circle') ?? null;
        // Markers scale with the stroke width unless told otherwise.
        const scale = marker?.getAttribute('markerUnits') === 'userSpaceOnUse' ? 1 : parseFloat(window.getComputedStyle(badge).strokeWidth) || 1;
        const r = (circle ? num(circle, 'r') : 6) * scale;
        const numEl = numberTexts.find(t => {
            if (claimed.has(t)) return false;
            const b = rootBox(svg, t);
            return Math.abs(b.x + b.width / 2 - cx) < r && Math.abs(b.y + b.height / 2 - cy) < r;
        }) ?? null;
        if (numEl) claimed.add(numEl);
        const ccs = circle ? window.getComputedStyle(circle) : null;
        entries.push({
            anchor: badge,
            node: {
                id: nextId('number'), x: cx - r, y: cy - r, width: 2 * r, height: 2 * r,
                text: numEl?.textContent?.trim() || '', type: 'circle',
                style: {
                    fill: ccs && visiblePaint(ccs.fill) ? ccs.fill : '#333333',
                    stroke: ccs && visiblePaint(ccs.stroke) ? ccs.stroke : 'none',
                    strokeWidth: '1px',
                    ...textStyleOf(numEl),
                    textAlign: 'center',
                },
            },
        });
    }

    // ---------------------------------------------------------- the rest
    for (const el of all(svg, DRAWABLE)) {
        if (isClaimed(el) || el.closest('defs, marker, symbol')) continue;
        const node = primitiveNode(svg, el, nextId('shape'));
        if (node) entries.push({ anchor: el, node });
    }
    for (const el of all(svg, 'text')) {
        if (isClaimed(el) || el.closest('defs, marker, symbol')) continue;
        claimed.add(el);
        for (const label of textLabels(svg, wrap(el))) entries.push({ anchor: el, label });
    }

    // Document order is Mermaid's stacking order.
    entries.sort((a, b) =>
        a.anchor === b.anchor ? 0
            : a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    return {
        width: graphWidth, height: graphHeight,
        nodes: entries.flatMap(e => (e.node ? [e.node] : [])),
        edges: entries.flatMap(e => (e.edge ? [e.edge] : [])),
        clusters: [],
        labels: entries.flatMap(e => (e.label ? [e.label] : [])),
    };
}

// Lines of a multi-line SVG text (one tspan per line), or its whole text.
function textLines(el: Element): string {
    const lines = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'tspan');
    const text = lines.length > 1 ? lines.map(l => l.textContent || '').join('\n') : el.textContent || '';
    return text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n').trim();
}

// A stand-in parent holding just `el`, for helpers that search a subtree.
function wrap(el: Element): Element {
    return {
        querySelector: (sel: string) => (el.matches(sel) ? el : el.querySelector(sel)),
        querySelectorAll: (sel: string) => (el.matches(sel) ? [el] : el.querySelectorAll(sel)),
        textContent: el.textContent,
    } as unknown as Element;
}

function unionBox(svg: SVGSVGElement, els: Element[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
        const b = rootBox(svg, el);
        if (b.width === 0 && b.height === 0) continue;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: 0, height: 0 };
}
