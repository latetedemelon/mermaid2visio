// SVG path `d` strings -> polylines. Pure; no DOM. Visio geometry is written
// from these points, so every curve command is flattened here.

export interface Point {
    x: number;
    y: number;
}

export interface FlattenOptions {
    // Straight segments used per cubic / quadratic Bézier.
    curveSteps?: number;
    // Radians of arc covered by one straight segment.
    arcStep?: number;
}

export function tokenizePath(d: string): Array<{ cmd: string; args: number[] }> {
    const out: Array<{ cmd: string; args: number[] }> = [];
    for (const [, cmd, rest] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
        out.push({ cmd, args: (rest.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(parseFloat) });
    }
    return out;
}

// Flattens a path into one polyline per subpath (each `M` starts a new one).
// Handles M L H V C S Q T A Z, absolute and relative.
export function flattenPath(d: string, options: FlattenOptions = {}): Point[][] {
    const curveSteps = Math.max(1, options.curveSteps ?? 8);
    const arcStep = options.arcStep ?? Math.PI / 12;

    const subpaths: Point[][] = [];
    let current: Point[] | null = null;
    let cx = 0, cy = 0, sx = 0, sy = 0;
    let prevCtrl: Point | null = null;
    let prevCmd = '';

    const lineTo = (x: number, y: number) => {
        if (!current) { current = [{ x: cx, y: cy }]; subpaths.push(current); }
        current.push({ x, y });
        cx = x; cy = y;
    };
    const cubicTo = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
        const x0 = cx, y0 = cy;
        for (let s = 1; s <= curveSteps; s++) {
            const t = s / curveSteps, mt = 1 - t;
            lineTo(
                mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
                mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y,
            );
        }
    };
    const quadTo = (x1: number, y1: number, x: number, y: number) => {
        const x0 = cx, y0 = cy;
        for (let s = 1; s <= curveSteps; s++) {
            const t = s / curveSteps, mt = 1 - t;
            lineTo(mt * mt * x0 + 2 * mt * t * x1 + t * t * x, mt * mt * y0 + 2 * mt * t * y1 + t * t * y);
        }
    };
    // SVG endpoint-to-centre arc parameterisation (SVG spec, implementation
    // notes F.6).
    const arcTo = (rx: number, ry: number, rotDeg: number, largeArc: number, sweep: number, x2: number, y2: number) => {
        const x1 = cx, y1 = cy;
        if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) { lineTo(x2, y2); return; }
        rx = Math.abs(rx); ry = Math.abs(ry);
        const phi = (rotDeg % 360) * Math.PI / 180;
        const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
        const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
        const x1p = cosPhi * dx + sinPhi * dy;
        const y1p = -sinPhi * dx + cosPhi * dy;
        let rx2 = rx * rx, ry2 = ry * ry;
        const lambda = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
        if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; rx2 = rx * rx; ry2 = ry * ry; }
        const sign = largeArc !== sweep ? 1 : -1;
        const num = Math.max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p);
        const denom = rx2 * y1p * y1p + ry2 * x1p * x1p;
        const coef = denom === 0 ? 0 : sign * Math.sqrt(num / denom);
        const cxp = coef * (rx * y1p / ry);
        const cyp = coef * (-ry * x1p / rx);
        const centreX = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
        const centreY = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
        const angle = (ux: number, uy: number, vx: number, vy: number) => {
            const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1;
            const a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / len)));
            return ux * vy - uy * vx < 0 ? -a : a;
        };
        const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
        const theta1 = angle(1, 0, ux, uy);
        let dTheta = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
        else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
        const segs = Math.max(2, Math.ceil(Math.abs(dTheta) / arcStep));
        for (let i = 1; i <= segs; i++) {
            const t = theta1 + dTheta * (i / segs);
            // Land exactly on the commanded endpoint.
            if (i === segs) { lineTo(x2, y2); break; }
            lineTo(
                centreX + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi,
                centreY + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi,
            );
        }
    };

    for (const { cmd, args } of tokenizePath(d)) {
        const rel = cmd >= 'a' && cmd <= 'z';
        const upper = cmd.toUpperCase();
        const X = (v: number) => (rel ? cx + v : v);
        const Y = (v: number) => (rel ? cy + v : v);

        if (upper === 'M') {
            for (let i = 0; i + 1 < args.length; i += 2) {
                const x = X(args[i]), y = Y(args[i + 1]);
                if (i === 0) {
                    current = [{ x, y }];
                    subpaths.push(current);
                    cx = sx = x; cy = sy = y;
                } else {
                    lineTo(x, y);
                }
            }
            prevCtrl = null;
        } else if (upper === 'L') {
            for (let i = 0; i + 1 < args.length; i += 2) lineTo(X(args[i]), Y(args[i + 1]));
            prevCtrl = null;
        } else if (upper === 'H') {
            for (const v of args) lineTo(X(v), cy);
            prevCtrl = null;
        } else if (upper === 'V') {
            for (const v of args) lineTo(cx, Y(v));
            prevCtrl = null;
        } else if (upper === 'C') {
            for (let i = 0; i + 5 < args.length; i += 6) {
                const x2 = X(args[i + 2]), y2 = Y(args[i + 3]);
                cubicTo(X(args[i]), Y(args[i + 1]), x2, y2, X(args[i + 4]), Y(args[i + 5]));
                prevCtrl = { x: x2, y: y2 };
            }
        } else if (upper === 'S') {
            for (let i = 0; i + 3 < args.length; i += 4) {
                const reflect = /[CcSs]/.test(prevCmd) && prevCtrl;
                const x1 = reflect ? 2 * cx - prevCtrl!.x : cx;
                const y1 = reflect ? 2 * cy - prevCtrl!.y : cy;
                const x2 = X(args[i]), y2 = Y(args[i + 1]);
                cubicTo(x1, y1, x2, y2, X(args[i + 2]), Y(args[i + 3]));
                prevCtrl = { x: x2, y: y2 };
                prevCmd = cmd;
            }
        } else if (upper === 'Q') {
            for (let i = 0; i + 3 < args.length; i += 4) {
                const x1 = X(args[i]), y1 = Y(args[i + 1]);
                quadTo(x1, y1, X(args[i + 2]), Y(args[i + 3]));
                prevCtrl = { x: x1, y: y1 };
            }
        } else if (upper === 'T') {
            for (let i = 0; i + 1 < args.length; i += 2) {
                const reflect = /[QqTt]/.test(prevCmd) && prevCtrl;
                const x1 = reflect ? 2 * cx - prevCtrl!.x : cx;
                const y1 = reflect ? 2 * cy - prevCtrl!.y : cy;
                quadTo(x1, y1, X(args[i]), Y(args[i + 1]));
                prevCtrl = { x: x1, y: y1 };
                prevCmd = cmd;
            }
        } else if (upper === 'A') {
            for (let i = 0; i + 6 < args.length; i += 7) {
                arcTo(args[i], args[i + 1], args[i + 2], args[i + 3], args[i + 4], X(args[i + 5]), Y(args[i + 6]));
            }
            prevCtrl = null;
        } else if (upper === 'Z') {
            if (current && (cx !== sx || cy !== sy)) lineTo(sx, sy);
            cx = sx; cy = sy;
            prevCtrl = null;
        }
        prevCmd = cmd;
    }
    return subpaths;
}

// Drops points that don't change the line's shape by more than `tolerance`
// (Ramer-Douglas-Peucker). Flattened curves carry many near-collinear points.
export function simplifyPolyline(points: Point[], tolerance: number): Point[] {
    if (points.length <= 2) return points.slice();
    const keep = new Array<boolean>(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop()!;
        const ax = points[a].x, ay = points[a].y;
        const dx = points[b].x - ax, dy = points[b].y - ay;
        const len = Math.hypot(dx, dy);
        let worst = -1, worstDist = tolerance;
        for (let i = a + 1; i < b; i++) {
            const px = points[i].x - ax, py = points[i].y - ay;
            const dist = len === 0 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
            if (dist > worstDist) { worstDist = dist; worst = i; }
        }
        if (worst !== -1) {
            keep[worst] = true;
            stack.push([a, worst], [worst, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

// The point halfway along a polyline, by length.
export function polylineMidpoint(points: Point[]): Point {
    if (points.length === 0) return { x: 0, y: 0 };
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    let remaining = total / 2;
    for (let i = 1; i < points.length; i++) {
        const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        if (seg >= remaining && seg > 0) {
            const t = remaining / seg;
            return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
        }
        remaining -= seg;
    }
    return { ...points[points.length - 1] };
}
