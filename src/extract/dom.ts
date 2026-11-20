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
// space. Uses the current transformation matrix rather than parsing
// `transform` attributes, so every ancestor transform is accounted for
// (essential for nodes inside nested subgraphs). Returns null when the
// environment can't supply a CTM.
export function toRootPoint(svg: SVGSVGElement, el: Element, x: number, y: number): { x: number; y: number } | null {
    const ctm = (el as SVGGraphicsElement).getCTM?.();
    const svgCTM = svg.getScreenCTM?.();
    if (!ctm || !svgCTM) return null;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const abs = pt.matrixTransform(svgCTM.inverse().multiply(ctm));
    return { x: abs.x, y: abs.y };
}

// Fallback for toRootPoint: read a single translate(x,y) off an element.
export function translateOf(el: Element | null | undefined): { x: number; y: number } {
    const m = /translate\(([^,]+),([^)]+)\)/.exec(el?.getAttribute('transform') || '');
    return { x: m ? parseFloat(m[1]) : 0, y: m ? parseFloat(m[2]) : 0 };
}

export const all = <T extends Element = Element>(root: ParentNode, selector: string): T[] =>
    Array.from(root.querySelectorAll(selector)) as T[];
