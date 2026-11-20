import { describe, it, expect } from '@jest/globals';
import { buildMermaidConfig, frontmatterLayout, DEFAULT_THEME_VARIABLES } from '../src/core/mermaidConfig';

describe('buildMermaidConfig', () => {
    it('applies the tool defaults when no config is given', () => {
        const { init, layout, layoutSource } = buildMermaidConfig(undefined, 'graph TD\n A-->B');
        expect(layout).toBe('dagre');
        expect(layoutSource).toBe('default');
        expect(init.theme).toBe('neutral');
        expect(init.startOnLoad).toBe(false);
        // Mermaid 12's default look ("neo") is not convertible; always classic.
        expect(init.look).toBe('classic');
        expect(init.htmlLabels).toBe(true);
        expect(init.themeVariables).toEqual(DEFAULT_THEME_VARIABLES);
        expect(init.flowchart).toEqual({ nodeSpacing: 50, rankSpacing: 50, curve: 'basis', useMaxWidth: true });
    });

    it('reports the layout Mermaid will actually use: frontmatter, then config, then default', () => {
        const fm = '---\nconfig:\n  layout: elk\n---\ngraph TD\n A-->B';
        expect(frontmatterLayout(fm)).toBe('elk');
        expect(buildMermaidConfig(undefined, fm)).toMatchObject({ layout: 'elk', layoutSource: 'frontmatter' });
        // Mermaid applies frontmatter over initialize(), so it beats the caller's choice.
        expect(buildMermaidConfig({ layout: 'dagre' }, fm)).toMatchObject({ layout: 'elk', layoutSource: 'frontmatter' });
        expect(buildMermaidConfig({ layout: 'elk' }, 'graph TD')).toMatchObject({ layout: 'elk', layoutSource: 'config' });
    });

    it('merges caller theme variables over the defaults', () => {
        const { init } = buildMermaidConfig({ themeVariables: { primaryColor: '#ff0000' } }, 'graph TD');
        expect((init.themeVariables as any).primaryColor).toBe('#ff0000');
        expect((init.themeVariables as any).lineColor).toBe(DEFAULT_THEME_VARIABLES.lineColor);
    });

    // The GUI accepts a config object over HTTP; nothing in it may reach
    // Mermaid as anything other than a plain value of the expected type.
    it('coerces hostile config values to safe defaults', () => {
        const hostile: any = {
            flowchart: { nodeSpacing: '50}); alert(1); ({', rankSpacing: -5, curve: '</script><script>alert(1)</script>' },
            themeVariables: { primaryColor: { toString: () => 'x' }, fontFamily: 'Arial' },
        };
        const { init } = buildMermaidConfig(hostile, 'graph TD');
        expect(init.flowchart).toEqual({ nodeSpacing: 50, rankSpacing: 50, curve: 'basis', useMaxWidth: true });
        expect((init.themeVariables as any).primaryColor).toBe(DEFAULT_THEME_VARIABLES.primaryColor);
        expect((init.themeVariables as any).fontFamily).toBe('Arial');
    });
});
