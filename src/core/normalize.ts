// Pure coordinate-normalization helpers shared by the Node parser and any
// future browser entry point. No DOM, no Node-only modules.

import type { GraphData } from './types.js';

// Translate every absolute coordinate pair in an SVG path `d` string by (dx, dy).
// Mermaid's edge paths use absolute commands (M, L, C, S, Q, T, A); we don't
// see relative commands in practice, but if any appear we leave them alone
// (their values are deltas, unaffected by translation).
export function translatePathD(d: string, dx: number, dy: number): string {
    return d.replace(
        /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g,
        (_, cmd: string, args: string) => {
            const isRelative = cmd >= 'a' && cmd <= 'z';
            const upper = cmd.toUpperCase();
            if (upper === 'Z' || isRelative) return cmd + args;
            const nums = args.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
            if (!nums) return cmd + args;
            const vals = nums.map(parseFloat);
            // Per-command pattern of which numeric slots are X (true), Y (false), or neither (null).
            // A command: rx ry x-axis-rotation large-arc-flag sweep-flag x y → [null,null,null,null,null,X,Y]
            let pattern: Array<'x' | 'y' | null>;
            if (upper === 'M' || upper === 'L' || upper === 'T') pattern = ['x', 'y'];
            else if (upper === 'H') pattern = ['x'];
            else if (upper === 'V') pattern = ['y'];
            else if (upper === 'C') pattern = ['x', 'y', 'x', 'y', 'x', 'y'];
            else if (upper === 'S' || upper === 'Q') pattern = ['x', 'y', 'x', 'y'];
            else if (upper === 'A') pattern = [null, null, null, null, null, 'x', 'y'];
            else return cmd + args;
            const out = vals.map((v, i) => {
                const slot = pattern[i % pattern.length];
                if (slot === 'x') return v + dx;
                if (slot === 'y') return v + dy;
                return v;
            });
            return cmd + ' ' + out.join(' ');
        },
    );
}

// Translate every shape's coordinates so the page origin is the top-left of
// the actual rendered content. Mermaid+ELK place shapes in SVG user space whose
// origin doesn't match the viewBox top-left (ELK can emit y=-11 above viewBox
// y=4). Without this, shapes with x<0 or y<0 land off-page in Visio. Mutates
// the input graph and also rewrites edge `d` strings via translatePathD so
// fallback-path edges share the node coordinate space. Returns the raw
// pre-translation bounds for diagnostic logging.
export interface ContentBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

// Extent of the coordinates in an SVG path `d` string (absolute commands).
// Control points are included, so for curves this is a slight over-estimate,
// which is what a page-bounds calculation wants.
export function pathBounds(d: string): ContentBounds | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let curX = 0, curY = 0;
    const see = (x: number, y: number) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        curX = x; curY = y;
    };
    for (const [, cmd, args] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
        const upper = cmd.toUpperCase();
        if (upper === 'Z' || cmd !== upper) continue;
        const v = (args.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(parseFloat);
        if (upper === 'H') { for (const x of v) see(x, curY); continue; }
        if (upper === 'V') { for (const y of v) see(curX, y); continue; }
        const step = upper === 'A' ? 7 : 2;
        for (let i = upper === 'A' ? 5 : 0; i + 1 < v.length; i += step) see(v[i], v[i + 1]);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function normalizeContentBounds(graph: GraphData): ContentBounds {
    const xs: number[] = [];
    const ys: number[] = [];
    const maxXs: number[] = [];
    const maxYs: number[] = [];
    for (const n of graph.nodes) {
        xs.push(n.x); ys.push(n.y);
        maxXs.push(n.x + n.width); maxYs.push(n.y + n.height);
    }
    for (const c of graph.clusters) {
        xs.push(c.x); ys.push(c.y);
        maxXs.push(c.x + c.width); maxYs.push(c.y + c.height);
    }
    for (const l of graph.labels) {
        xs.push(l.x); ys.push(l.y);
        maxXs.push(l.x + l.width); maxYs.push(l.y + l.height);
    }
    // Edges can reach outside every node (self-loops, wide curves, sequence
    // self-messages), and so can their labels.
    for (const e of graph.edges) {
        const b = e.d ? pathBounds(e.d) : null;
        if (b) {
            xs.push(b.minX); ys.push(b.minY);
            maxXs.push(b.maxX); maxYs.push(b.maxY);
        }
        if (e.labelX !== undefined && e.labelY !== undefined) {
            xs.push(e.labelX); ys.push(e.labelY);
            maxXs.push(e.labelX + (e.labelWidth ?? 0)); maxYs.push(e.labelY + (e.labelHeight ?? 0));
        }
    }
    const minX = xs.length ? Math.min(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxX = maxXs.length ? Math.max(...maxXs) : graph.width;
    const maxY = maxYs.length ? Math.max(...maxYs) : graph.height;

    for (const n of graph.nodes) {
        n.x -= minX; n.y -= minY;
        if (n.textX !== undefined) n.textX -= minX;
        if (n.textY !== undefined) n.textY -= minY;
        for (const child of n.children ?? []) { child.x -= minX; child.y -= minY; }
        for (const part of n.parts ?? []) {
            part.x -= minX; part.y -= minY;
            if (part.textX !== undefined) part.textX -= minX;
            if (part.textY !== undefined) part.textY -= minY;
        }
    }
    for (const c of graph.clusters) { c.x -= minX; c.y -= minY; }
    for (const l of graph.labels) { l.x -= minX; l.y -= minY; }
    for (const e of graph.edges) {
        if (e.d) e.d = translatePathD(e.d, -minX, -minY);
        if (e.labelX !== undefined) e.labelX -= minX;
        if (e.labelY !== undefined) e.labelY -= minY;
    }

    graph.width = maxX - minX;
    graph.height = maxY - minY;
    return { minX, minY, maxX, maxY };
}
