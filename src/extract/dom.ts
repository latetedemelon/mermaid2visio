// Small DOM helpers shared by the per-diagram extractors. Everything in
// src/extract/ runs inside a browser page (Puppeteer or the client-side
// bundle) and must not import Node-only modules.

export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

export const EMPTY_BOX: Box = { x: 0, y: 0, width: 0, height: 0 };

export function bboxOf(el: Element | null | undefined): Box {
    if (!el) return { ...EMPTY_BOX };
    const b = (el as SVGGraphicsElement).getBBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// Convert a point in `el`'s local coordinate system to the root SVG's user
// space, through every ancestor transform (essential for nodes inside nested
// subgraphs). Both matrices are taken relative to the screen, so the result
// does not depend on where the SVG sits on the page or how it is scaled to
// fit; mixing getCTM() with getScreenCTM() here shifted every shape by the
// page margin, and by more when a wide diagram was scaled down. Returns null
// when the environment can't supply the matrices.
export function toRootPoint(svg: SVGSVGElement, el: Element, x: number, y: number): { x: number; y: number } | null {
    const elScreen = (el as SVGGraphicsElement).getScreenCTM?.();
    const svgScreen = svg.getScreenCTM?.();
    if (!elScreen || !svgScreen) return null;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const abs = pt.matrixTransform(svgScreen.inverse().multiply(elScreen));
    return { x: abs.x, y: abs.y };
}

// Fallback for toRootPoint: read a single translate(x,y) off an element.
export function translateOf(el: Element | null | undefined): { x: number; y: number } {
    const m = /translate\(([^,]+),([^)]+)\)/.exec(el?.getAttribute('transform') || '');
    return { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2]) : 0 };
}

export const all = <T extends Element = Element>(root: ParentNode, selector: string): T[] =>
    Array.from(root.querySelectorAll(selector)) as T[];

export const visiblePaint = (value: string | null | undefined): boolean => {
    if (!value || value === 'none' || value === 'transparent') return false;
    const alpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(value)?.[1];
    return alpha === undefined || parseFloat(alpha) > 0;
};

// Bounding box of `el` in the root SVG's user space.
export function rootBox(svg: SVGSVGElement, el: Element | null | undefined, fallbackFrom?: Element | null): Box {
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

export interface LabelInfo {
    text: string;
    // Element whose computed style describes the text.
    styleEl: Element | null;
    // Element whose box is the label's extent.
    boxEl: Element | null;
}

const tidy = (text: string): string => text.split('\n').map(l => l.trim()).join('\n').trim();

// Reads a label rendered either as HTML (foreignObject) or as SVG text.
export function readLabel(root: Element | null | undefined): LabelInfo {
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

// The colour text is actually painted in. SVG text is painted with `fill`;
// its CSS `color` is usually just the inherited default. HTML uses `color`.
export function textColor(el: Element | null | undefined): string {
    if (!el) return '#000000';
    if (el instanceof SVGElement) {
        // The glyphs are painted by the innermost tspan holding them, which
        // can have its own fill: sequence actors colour their <text> like the
        // box and only the tspan in the text colour.
        const glyphs = Array.from(el.querySelectorAll('tspan')).find(t => (t.textContent || '').trim() && !t.querySelector('tspan')) ?? el;
        const fill = window.getComputedStyle(glyphs).fill;
        if (visiblePaint(fill)) return fill;
    }
    return window.getComputedStyle(el).color;
}
