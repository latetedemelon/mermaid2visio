// Sequence-diagram extractor. Sequence SVG has a wholly different structure
// from flowcharts (actor boxes + lifelines + message lines, not
// .node/.edgePaths). Actor boxes become rectangle nodes; lifelines and
// messages become unglued edges with a synthesized `d`.

import type { GraphData } from '../core/types.js';

export function extractSequence(svg: SVGSVGElement, graphWidth: number, graphHeight: number): GraphData {
    const num = (el: Element | null, attr: string) => parseFloat(el?.getAttribute(attr) || '0');
    const actorRects = Array.from(svg.querySelectorAll('rect.actor-top, rect.actor-bottom')) as SVGGraphicsElement[];
    const allText = Array.from(svg.querySelectorAll('text')) as SVGGraphicsElement[];
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
    for (const a of Array.from(svg.querySelectorAll('rect[class*="activation"]')) as SVGGraphicsElement[]) {
        const x = num(a, 'x'), y = num(a, 'y'), width = num(a, 'width'), height = num(a, 'height');
        const cs = window.getComputedStyle(a);
        seqNodes.push({
            id: `seq-activation-${seqNodes.length}`, x, y, width, height,
            text: '', type: 'rectangle', rounding: 0,
            style: { fill: cs.fill, stroke: cs.stroke, strokeWidth: cs.strokeWidth, color: '#000000' },
        });
    }
    // Notes: boxes with text, paired with their noteText by containment.
    const noteTexts = Array.from(svg.querySelectorAll('text.noteText')) as SVGGraphicsElement[];
    for (const n of Array.from(svg.querySelectorAll('rect.note')) as SVGGraphicsElement[]) {
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
    for (const ll of Array.from(svg.querySelectorAll('line.actor-line')) as Element[]) {
        const x1 = num(ll, 'x1'), y1 = num(ll, 'y1'), x2 = num(ll, 'x2'), y2 = num(ll, 'y2');
        seqEdges.push({
            d: `M ${x1} ${y1} L ${x2} ${y2}`,
            arrowStart: false, arrowEnd: false,
            style: { stroke: '#999999', strokeWidth: '1px', strokeDasharray: '3,3' },
        });
    }
    // Messages: solid (messageLine0) or dashed (messageLine1) lines
    // with an arrowhead at the end; labels matched by DOM order.
    const msgLines = Array.from(svg.querySelectorAll('line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1')) as Element[];
    const msgTexts = Array.from(svg.querySelectorAll('text.messageText')) as SVGGraphicsElement[];
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
