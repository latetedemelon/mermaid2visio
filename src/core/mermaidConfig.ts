// The single place that decides what gets passed to mermaid.initialize().
// Used by the Node renderer, the GUI preview and the browser bundle so all
// three render a given diagram identically. Pure: no DOM, no Node modules.

import type { MermaidConfig } from './types.js';

export const DEFAULT_THEME_VARIABLES: Record<string, string> = {
    primaryColor: '#e1f5fe',
    primaryTextColor: '#000',
    primaryBorderColor: '#01579b',
    lineColor: '#01579b',
    secondBkgColor: '#f0f0f0',
    tertiaryColor: '#ffffff',
    fontSize: '14px',
    fontFamily: 'Segoe UI, sans-serif',
};

export const DEFAULT_THEME = 'neutral';
export const DEFAULT_LAYOUT = 'dagre';

const CURVES = new Set(['basis', 'linear', 'cardinal', 'monotoneX']);

export type LayoutSource = 'config' | 'frontmatter' | 'default';

export interface ResolvedMermaidConfig {
    // Object handed verbatim to mermaid.initialize().
    init: Record<string, unknown>;
    layout: string;
    layoutSource: LayoutSource;
}

// `layout:` requested in the diagram's own YAML frontmatter, if any.
export function frontmatterLayout(definition: string): string | undefined {
    const frontmatter = /^---[\s\S]*?---/.exec(definition)?.[0] ?? '';
    return /\blayout:\s*([\w.-]+)/.exec(frontmatter)?.[1];
}

function spacing(value: unknown, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

function stringMap(input: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input || typeof input !== 'object') return out;
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
    }
    return out;
}

// Every value that reaches Mermaid is coerced to the type it should have, so
// a caller-supplied config (the GUI accepts one over HTTP) can only ever
// choose between valid settings.
export function buildMermaidConfig(config: MermaidConfig | undefined, definition: string): ResolvedMermaidConfig {
    let layout: string = DEFAULT_LAYOUT;
    let layoutSource: LayoutSource = 'default';
    if (typeof config?.layout === 'string' && config.layout) {
        layout = config.layout;
        layoutSource = 'config';
    } else {
        // Mermaid applies frontmatter config at render time, on top of
        // initialize(). Mirror it here so callers know which engine runs.
        const fm = frontmatterLayout(definition);
        if (fm) {
            layout = fm;
            layoutSource = 'frontmatter';
        }
    }

    const theme = typeof config?.theme === 'string' && config.theme ? config.theme : DEFAULT_THEME;
    const curve = typeof config?.flowchart?.curve === 'string' && CURVES.has(config.flowchart.curve)
        ? config.flowchart.curve
        : 'basis';

    return {
        layout,
        layoutSource,
        init: {
            startOnLoad: false,
            theme,
            layout,
            themeVariables: { ...DEFAULT_THEME_VARIABLES, ...stringMap(config?.themeVariables) },
            flowchart: {
                nodeSpacing: spacing(config?.flowchart?.nodeSpacing, 50),
                rankSpacing: spacing(config?.flowchart?.rankSpacing, 50),
                curve,
                useMaxWidth: config?.flowchart?.useMaxWidth !== false,
            },
            securityLevel: 'loose',
        },
    };
}
