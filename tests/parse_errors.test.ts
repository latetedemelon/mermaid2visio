import { describe, it, expect } from '@jest/globals';
import { formatMermaidError, parseMermaid } from '../src/parser';

// Pure unit tests for formatMermaidError. Kept separate from anything that
// touches Puppeteer so the regression bar for "user-facing parse error
// messages stay actionable" is cheap to maintain.
describe('formatMermaidError', () => {
    it('passes through non-lexical errors unchanged', () => {
        const out = formatMermaidError('something else went wrong', 'flowchart TB\nA --> B');
        expect(out).toBe('something else went wrong');
    });

    it('expands a Mermaid lexical error with surrounding diagram lines', () => {
        const definition = ['flowchart TB', '  A[Start]', '  A --> {bad', '  end'].join('\n');
        const raw = 'Lexical error on line 3. Unrecognized text.\n  A --> {bad\n--------^';
        const out = formatMermaidError(raw, definition);

        expect(out).toContain('Mermaid syntax error:');
        expect(out).toMatch(/Diagram \(line 3\):/);
        // The reported line should be marked with '>'.
        expect(out).toMatch(/>\s+3 \|\s+A --> \{bad/);
        // And surrounding lines should appear unmarked.
        expect(out).toMatch(/\s+2 \|\s+A\[Start\]/);
    });

    it('adjusts the line number for diagrams with YAML frontmatter', () => {
        // Mermaid reports errors against the post-frontmatter body, so a
        // "line 2" error should map back to original line 5 here.
        const definition = [
            '---',
            'config:',
            '  layout: elk',
            '---',
            'flowchart TB',
            '  A --> {bad',
        ].join('\n');
        const raw = 'Lexical error on line 2. Unrecognized text.';
        const out = formatMermaidError(raw, definition);
        expect(out).toMatch(/Diagram \(line 6\):/);
        expect(out).toMatch(/>\s+6 \|\s+A --> \{bad/);
    });

    it('appends a hint when the offending line ends with an inline %% comment', () => {
        const definition = [
            'flowchart TB',
            '  classDef x fill:#fff,stroke:#000   %% trailing',
        ].join('\n');
        const raw = 'Lexical error on line 2. Unrecognized text.';
        const out = formatMermaidError(raw, definition);
        expect(out).toMatch(/Hint: This line ends with an inline `%% \.\.\.` comment\./);
        expect(out).toMatch(/Move the comment to its own line/);
    });

    it('does not add the inline-%% hint when the line is just a regular comment', () => {
        const definition = ['flowchart TB', '%% standalone comment', '  ??? broken'].join('\n');
        const raw = 'Lexical error on line 3. Unrecognized text.';
        const out = formatMermaidError(raw, definition);
        expect(out).not.toMatch(/Hint: This line ends with an inline/);
    });
});

// Integration check: feed a real Mermaid render the user's exact failure
// pattern (trailing `%% ...` after a classDef) and assert the formatted
// error makes it back through parseMermaid.
describe('parseMermaid surface error', () => {
    it('wraps Mermaid render failures with diagram context', async () => {
        // Two classDef lines each terminated by an inline `%% ...` comment
        // is the exact pattern from the user's diagram that Mermaid rejects:
        // it lexes the trailing `%% Green  classDef` across the line boundary
        // as a single un-tokenizable run.
        // Match the exact pattern from the user's diagram: trailing inline
        // `%% <emoji> <word>` comments after each classDef.  Mermaid's lexer
        // tolerates a plain ASCII trailing comment but chokes on the emoji,
        // producing "Lexical error on line N. Unrecognized text."
        const definition = [
            'flowchart TB',
            '  classDef one fill:#b7eb8f,stroke:#237804,stroke-width:1px,color:#000   %% \u{1F7E9} Green',
            '  classDef two fill:#fff566,stroke:#ad8b00,stroke-width:1px,color:#000   %% \u{1F7E8} Yellow',
            '  A[Start]:::one',
        ].join('\n');
        await expect(parseMermaid(definition)).rejects.toThrow(/Mermaid syntax error/);
    }, 60000);
});
