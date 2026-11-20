// CSS colour -> what Visio needs: an opaque #rrggbb plus a separate alpha.
// Pure; no DOM. Browsers report computed colours as rgb()/rgba(), but style
// values that come straight from Mermaid's model can be in any CSS form.

export interface Paint {
    // Lower-case #rrggbb.
    hex: string;
    // Opacity, 0 (invisible) to 1 (solid).
    alpha: number;
}

const NAMED: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
    silver: '#c0c0c0', navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000',
    lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff',
    pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
    lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
    lightblue: '#add8e6', lightgreen: '#90ee90', lightyellow: '#ffffe0', darkblue: '#00008b',
    darkgreen: '#006400', darkred: '#8b0000', whitesmoke: '#f5f5f5', steelblue: '#4682b4',
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const toHex = (r: number, g: number, b: number) =>
    '#' + [r, g, b].map(c => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0')).join('');

// A channel written as a number (0-255) or a percentage.
const channel = (s: string): number => (s.endsWith('%') ? parseFloat(s) * 2.55 : parseFloat(s));
const alphaOf = (s: string | undefined): number =>
    s === undefined ? 1 : clamp(s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s), 0, 1);

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
    };
    return [f(0), f(8), f(4)];
}

// Returns null when there is nothing to paint: no value, `none`,
// `transparent`, zero alpha, or something that isn't a flat colour (a
// gradient or pattern reference such as url(#g)).
export function parseColor(input: string | undefined | null): Paint | null {
    if (!input) return null;
    const t = String(input).trim().toLowerCase();
    if (!t || t === 'none' || t === 'transparent') return null;

    let hex: string | undefined;
    let alpha = 1;

    let m: RegExpExecArray | null;
    if ((m = /^#([0-9a-f]{3,8})$/.exec(t))) {
        const h = m[1];
        if (h.length === 3 || h.length === 4) {
            hex = '#' + h.slice(0, 3).split('').map(c => c + c).join('');
            if (h.length === 4) alpha = parseInt(h[3] + h[3], 16) / 255;
        } else if (h.length === 6 || h.length === 8) {
            hex = '#' + h.slice(0, 6);
            if (h.length === 8) alpha = parseInt(h.slice(6), 16) / 255;
        }
    } else if ((m = /^rgba?\(([^)]*)\)$/.exec(t))) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean);
        if (p.length >= 3) {
            hex = toHex(channel(p[0]), channel(p[1]), channel(p[2]));
            alpha = alphaOf(p[3]);
        }
    } else if ((m = /^hsla?\(([^)]*)\)$/.exec(t))) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean);
        if (p.length >= 3) {
            const [r, g, b] = hslToRgb(((parseFloat(p[0]) % 360) + 360) % 360, clamp(parseFloat(p[1]) / 100, 0, 1), clamp(parseFloat(p[2]) / 100, 0, 1));
            hex = toHex(r, g, b);
            alpha = alphaOf(p[3]);
        }
    } else if (NAMED[t]) {
        hex = NAMED[t];
    }

    if (!hex || !/^#[0-9a-f]{6}$/.test(hex) || !Number.isFinite(alpha) || alpha <= 0) return null;
    return { hex, alpha };
}
