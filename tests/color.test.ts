import { describe, it, expect } from '@jest/globals';
import { parseColor } from '../src/core/color';
import { VsdxGenerator, resolveFont } from '../src/vsdx';

describe('parseColor', () => {
    it.each([
        ['#fff', '#ffffff', 1],
        ['#E1F5FE', '#e1f5fe', 1],
        ['#ff000080', '#ff0000', 128 / 255],
        ['#f008', '#ff0000', 0x88 / 255],
        ['rgb(1, 87, 155)', '#01579b', 1],
        ['rgba(255, 0, 0, 0.5)', '#ff0000', 0.5],
        ['rgb(255 0 0 / 25%)', '#ff0000', 0.25],
        ['rgb(100%, 0%, 0%)', '#ff0000', 1],
        ['hsl(120, 100%, 50%)', '#00ff00', 1],
        ['hsla(240, 100%, 50%, 0.5)', '#0000ff', 0.5],
        ['red', '#ff0000', 1],
        ['  LightGrey ', '#d3d3d3', 1],
    ])('%s', (input, hex, alpha) => {
        const paint = parseColor(input)!;
        expect(paint.hex).toBe(hex);
        expect(paint.alpha).toBeCloseTo(alpha, 6);
    });

    // Nothing to paint. "transparent" and zero alpha used to come out black.
    it.each(['none', 'transparent', 'rgba(0, 0, 0, 0)', '#00000000', '', undefined, null, 'url("#gradient")', 'not-a-colour', 'rgb(1,2)'])(
        'treats %p as no paint',
        (input) => { expect(parseColor(input as any)).toBeNull(); },
    );

    it('backs VsdxGenerator.normalizeColor', () => {
        expect(VsdxGenerator.normalizeColor('rgb(255, 221, 221)')).toBe('#ffdddd');
        expect(VsdxGenerator.normalizeColor('transparent')).toBeUndefined();
    });
});

describe('resolveFont', () => {
    it('picks the first family Visio can be told about', () => {
        expect(resolveFont('"Segoe UI", sans-serif')).toBe('Segoe UI');
        expect(resolveFont("'trebuchet ms', verdana, arial, sans-serif")).toBe('Trebuchet MS');
        expect(resolveFont('Helvetica, sans-serif')).toBe('Arial');
    });

    it('says nothing for generic or unknown families', () => {
        expect(resolveFont('sans-serif')).toBeUndefined();
        expect(resolveFont('Some Webfont, monospace')).toBeUndefined();
        expect(resolveFont(undefined)).toBeUndefined();
    });
});
