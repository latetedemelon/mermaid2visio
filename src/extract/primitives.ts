// Generic extractor: turns whatever Mermaid drew into free-form shapes and
// text boxes, one per SVG element, in drawing order. It knows nothing about
// what the diagram means, so the result is a static but fully editable
// drawing. Used for chart-like diagrams (pie, gantt, xychart, ...) and for
// flowchart shapes the generator has no parametric geometry for.

import type { GraphData, GraphLabel, GraphNode, OutlinePath } from '../core/types.js';
import { flattenPath, type Point } from '../core/svgPath.js';
import { translatePathD } from '../core/normalize.js';
import { all, readLabel, textColor, visiblePaint } from './dom.js';

export const DRAWABLE = 'path, rect, circle, ellipse, polygon, polyline, line';
// Content that is defined, not drawn.
const NOT_RENDERED = 'defs, marker, clipPath, mask, pattern, symbol, style, title, desc, linearGradient, radialGradient';

export interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }

// Maps an element's own coordinates to the root SVG's user space.
export function rootMatrix(svg: SVGSVGElement, el: Element): Matrix | null {
    const svgCTM = svg.getScreenCTM?.();
    const elScreen = (el as SVGGraphicsElement).getScreenCTM?.();
    if (!svgCTM || !elScreen) return null;
    const m = svgCTM.inverse().multiply(elScreen);
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

export const applyMatrix = (m: Matrix, x: number, y: number): Point => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

const attr = (el: Element, name: string): number => parseFloat(el.getAttribute(name) || '0') || 0;

// The element's outline as an SVG path string in its own coordinates.
export function localPath(el: Element): string {
    switch (el.tagName.toLowerCase()) {
        case 'path':
            return el.getAttribute('d') || '';
        case 'line':
            return `M ${attr(el, 'x1')} ${attr(el, 'y1')} L ${attr(el, 'x2')} ${attr(el, 'y2')}`;
        case 'polygon':
        case 'polyline': {
            const nums = (el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(parseFloat);
            if (nums.length < 4) return '';
            let d = '';
            for (let i = 0; i + 1 < nums.length; i += 2) d += `${i === 0 ? 'M' : 'L'} ${nums[i]} ${nums[i + 1]} `;
            return d + (el.tagName.toLowerCase() === 'polygon' ? 'Z' : '');
        }
        case 'rect': {
            const x = attr(el, 'x'), y = attr(el, 'y'), w = attr(el, 'width'), h = attr(el, 'height');
            if (w <= 0 || h <= 0) return '';
            const rx = Math.min(attr(el, 'rx') || attr(el, 'ry'), w / 2);
            const ry = Math.min(attr(el, 'ry') || attr(el, 'rx'), h / 2);
            if (rx <= 0 || ry <= 0) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
            return `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} ` +
                `A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
                `V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
        }
        case 'circle':
        case 'ellipse': {
            const cx = attr(el, 'cx'), cy = attr(el, 'cy');
            const rx = el.tagName.toLowerCase() === 'circle' ? attr(el, 'r') : attr(el, 'rx');
            const ry = el.tagName.toLowerCase() === 'circle' ? attr(el, 'r') : attr(el, 'ry');
            if (rx <= 0 || ry <= 0) return '';
            return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
        }
        default:
            return '';
    }
}

// Opacity an element ends up with, through every ancestor up to the root.
function inheritedOpacity(svg: SVGSVGElement, el: Element): number {
    let opacity = 1;
    for (let cur: Element | null = el; cur && cur !== svg; cur = cur.parentElement) {
        const o = parseFloat(window.getComputedStyle(cur).opacity);
        if (Number.isFinite(o)) opacity *= o;
    }
    return opacity;
}

function isRendered(svg: SVGSVGElement, el: Element): boolean {
    if (el.closest(NOT_RENDERED)) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
}

// A paint value as a flat colour with `opacity` folded into its alpha. A
// gradient reference is replaced by its first stop.
function flatPaint(svg: SVGSVGElement, value: string, opacity: number): string {
    let colour = value;
    const ref = /^url\(["']?#([^"')]+)["']?\)/.exec(value)?.[1];
    if (ref) {
        const stop = svg.querySelector(`#${CSS.escape(ref)} stop`);
        colour = stop ? window.getComputedStyle(stop).stopColor : 'none';
    }
    if (!visiblePaint(colour) || opacity <= 0.01) return 'none';
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/.exec(colour);
    if (!m) return colour;
    const alpha = (m[4] === undefined ? 1 : parseFloat(m[4])) * opacity;
    return alpha >= 0.999 ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${Math.round(alpha * 1000) / 1000})`;
}

interface Drawn {
    // Outline in root coordinates.
    subpaths: Point[][];
    fill: string;
    stroke: string;
    strokeWidth: string;
    strokeDasharray: string;
    hasMarkerStart: boolean;
    hasMarkerEnd: boolean;
}

function draw(svg: SVGSVGElement, el: Element): Drawn | null {
    if (!isRendered(svg, el)) return null;
    const matrix = rootMatrix(svg, el);
    const d = localPath(el);
    if (!matrix || !d) return null;
    // Finer than the default: these outlines are the whole drawing.
    const subpaths = flattenPath(d, { curveSteps: 12, arcStep: Math.PI / 32 })
        .filter(p => p.length >= 2)
        .map(p => p.map(pt => applyMatrix(matrix, pt.x, pt.y)));
    if (!subpaths.length) return null;

    const cs = window.getComputedStyle(el);
    const opacity = inheritedOpacity(svg, el);
    // A line has no interior, whatever its fill property says.
    const fill = el.tagName.toLowerCase() === 'line' ? 'none'
        : flatPaint(svg, cs.fill, opacity * (parseFloat(cs.fillOpacity) || (cs.fillOpacity === '0' ? 0 : 1)));
    const strokeWidth = parseFloat(cs.strokeWidth) || 0;
    const stroke = strokeWidth > 0
        ? flatPaint(svg, cs.stroke, opacity * (parseFloat(cs.strokeOpacity) || (cs.strokeOpacity === '0' ? 0 : 1)))
        : 'none';
    if (fill === 'none' && stroke === 'none') return null;
    // Stroke width scales with the element's transform.
    const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c)) || 1;
    return {
        subpaths, fill, stroke,
        strokeWidth: `${strokeWidth * scale}px`,
        strokeDasharray: cs.strokeDasharray,
        hasMarkerStart: !!el.getAttribute('marker-start'),
        hasMarkerEnd: !!el.getAttribute('marker-end'),
    };
}

function boundsOf(subpaths: Point[][]): { x: number; y: number; width: number; height: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of subpaths.flat()) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const relative = (subpaths: Point[][], x: number, y: number): OutlinePath['subpaths'] =>
    subpaths.map(p => p.map((pt): [number, number] => [pt.x - x, pt.y - y]));

// The outline of a node, for shapes with no parametric geometry: every
// element inside `container`, relative to the node's box.
export function outlinePaths(svg: SVGSVGElement, container: Element, box: { x: number; y: number }): OutlinePath[] {
    const elements = container.matches(DRAWABLE) ? [container] : all(container, DRAWABLE);
    const paths: OutlinePath[] = [];
    const keys: string[] = [];
    for (const el of elements) {
        const drawn = draw(svg, el);
        if (!drawn) continue;
        // Hand-drawn-style shapes are a fill path plus an identical stroke
        // path; merge them into one filled, outlined piece.
        const key = JSON.stringify(drawn.subpaths.map(p => p.map(pt => [Math.round(pt.x * 2), Math.round(pt.y * 2)])));
        const at = keys.indexOf(key);
        if (at !== -1) {
            paths[at].fill ||= drawn.fill !== 'none';
            paths[at].line ||= drawn.stroke !== 'none';
            continue;
        }
        keys.push(key);
        paths.push({ subpaths: relative(drawn.subpaths, box.x, box.y), fill: drawn.fill !== 'none', line: drawn.stroke !== 'none' });
    }
    return paths;
}

// The paint of a multi-piece outline: the first visible fill and the first
// visible stroke among its pieces.
export function outlinePaint(svg: SVGSVGElement, container: Element): { fill: string; stroke: string; strokeWidth: string; strokeDasharray: string } {
    const out = { fill: 'none', stroke: 'none', strokeWidth: '1px', strokeDasharray: 'none' };
    for (const el of all(container, DRAWABLE)) {
        const drawn = draw(svg, el);
        if (!drawn) continue;
        if (out.fill === 'none' && drawn.fill !== 'none') out.fill = drawn.fill;
        if (out.stroke === 'none' && drawn.stroke !== 'none') {
            out.stroke = drawn.stroke;
            out.strokeWidth = drawn.strokeWidth;
            out.strokeDasharray = drawn.strokeDasharray;
        }
        if (out.fill !== 'none' && out.stroke !== 'none') break;
    }
    return out;
}

// Where a text element sits: its unrotated box centred where it is drawn,
// plus its on-screen rotation.
function textBox(svg: SVGSVGElement, el: Element): { x: number; y: number; width: number; height: number; angle: number } | null {
    const matrix = rootMatrix(svg, el);
    if (!matrix) return null;
    const b = (el as SVGGraphicsElement).getBBox();
    if (b.width <= 0 && b.height <= 0) return null;
    const centre = applyMatrix(matrix, b.x + b.width / 2, b.y + b.height / 2);
    const scaleX = Math.hypot(matrix.a, matrix.b) || 1;
    const scaleY = Math.hypot(matrix.c, matrix.d) || 1;
    const width = b.width * scaleX, height = b.height * scaleY;
    return {
        x: centre.x - width / 2, y: centre.y - height / 2, width, height,
        angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI,
    };
}

// An edge's path data in the root SVG's coordinates. The `d` attribute is in
// the coordinates of the group the path sits in, and Mermaid nests groups
// with their own offsets (inside composite states, and around subgraphs that
// have outside connections), so it must be mapped like everything else.
export function rootPathData(svg: SVGSVGElement, path: Element): string {
    // Lines and other basic shapes are converted to path data first.
    const d = localPath(path);
    const m = rootMatrix(svg, path);
    if (!m || !d) return d;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    if (near(m.a, 1) && near(m.d, 1) && near(m.b, 0) && near(m.c, 0)) {
        // A pure offset keeps the curve commands intact.
        return near(m.e, 0) && near(m.f, 0) ? d : translatePathD(d, m.e, m.f);
    }
    // Anything else (scale, rotation): flatten and map point by point.
    return flattenPath(d).map(sub => sub.map((p, i) => {
        const q = applyMatrix(m, p.x, p.y);
        return `${i === 0 ? 'M' : 'L'} ${q.x} ${q.y}`;
    }).join(' ')).join(' ');
}

// One SVG element as a free-form shape, or null if it draws nothing.
export function primitiveNode(svg: SVGSVGElement, el: Element, id: string): GraphNode | null {
    // Text inside a foreignObject is HTML; any SVG nested there is decoration.
    if (el.closest('foreignObject')) return null;
    const drawn = draw(svg, el);
    if (!drawn) return null;
    const box = boundsOf(drawn.subpaths);
    return {
        id,
        ...box,
        text: '',
        type: 'path',
        paths: [{ subpaths: relative(drawn.subpaths, box.x, box.y), fill: drawn.fill !== 'none', line: drawn.stroke !== 'none' }],
        lineStart: drawn.hasMarkerStart ? 'arrow_point' : undefined,
        lineEnd: drawn.hasMarkerEnd ? 'arrow_point' : undefined,
        style: {
            fill: drawn.fill,
            stroke: drawn.stroke,
            strokeWidth: drawn.strokeWidth,
            strokeDasharray: drawn.strokeDasharray,
        },
    };
}

// Every piece of text under `root`, as a positioned text box.
export function textLabels(
    svg: SVGSVGElement,
    root: Element,
    visible: (box: { x: number; y: number; width: number; height: number }) => boolean = () => true,
): GraphLabel[] {
    const labels: GraphLabel[] = [];
    for (const el of all(root, 'text, foreignObject')) {
        if (!isRendered(svg, el) || el.parentElement?.closest('foreignObject, text')) continue;
        const isHtml = el.tagName.toLowerCase() === 'foreignobject';
        let text: string;
        let styleEl: Element = el;
        if (isHtml) {
            const info = readLabel(el.parentElement);
            text = info.text;
            styleEl = info.styleEl ?? el;
        } else {
            const lines = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'tspan' && (c.hasAttribute('dy') || c.hasAttribute('x')));
            text = lines.length > 1 ? lines.map(l => l.textContent || '').join('\n') : el.textContent || '';
        }
        // Words are often separate tspans with layout whitespace between them.
        text = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n').trim();
        if (!text) continue;
        const box = textBox(svg, el);
        if (!box || !visible(box)) continue;
        const cs = window.getComputedStyle(styleEl);
        const opacity = inheritedOpacity(svg, el);
        if (opacity <= 0.01) continue;
        labels.push({
            x: box.x, y: box.y, width: box.width, height: box.height,
            text,
            angle: Math.abs(box.angle) > 0.5 ? box.angle : undefined,
            style: {
                // SVG text is painted with `fill`; HTML with `color`.
                color: flatPaint(svg, isHtml ? cs.color : textColor(el), opacity),
                fontSize: cs.fontSize,
                fontFamily: cs.fontFamily,
                fontWeight: cs.fontWeight,
                fontStyle: cs.fontStyle,
            },
        });
    }
    return labels;
}

export function extractPrimitives(svg: SVGSVGElement, graphWidth: number, graphHeight: number): GraphData {
    // Anything drawn wholly outside the viewBox is not visible in the
    // diagram (a Gantt chart's "today" line can sit thousands of pixels
    // away) and must not stretch the page to reach it.
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat);
    const view = vb.length === 4 && vb.every(Number.isFinite)
        ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] }
        : null;
    const visible = (b: { x: number; y: number; width: number; height: number }): boolean =>
        !view || (b.x <= view.x + view.width && b.x + b.width >= view.x && b.y <= view.y + view.height && b.y + b.height >= view.y);

    const nodes: GraphNode[] = [];
    let counter = 0;
    for (const el of all(svg, DRAWABLE)) {
        const node = primitiveNode(svg, el, `shape-${counter}`);
        if (!node || !visible(node)) continue;
        nodes.push(node);
        counter++;
    }

    const labels = textLabels(svg, svg, visible);

    return { width: graphWidth, height: graphHeight, nodes, edges: [], clusters: [], labels };
}
