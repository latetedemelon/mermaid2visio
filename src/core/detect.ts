// Pure helpers for inspecting Mermaid source. No DOM, no Node-only modules,
// so safe for both the Puppeteer/Node parser and a future browser build.

// Detect the Mermaid diagram type from its source: strip YAML frontmatter and
// full-line %% comments, then read the first token.
export function detectDiagramType(definition: string): string {
    const body = definition.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const firstMeaningful = body
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0 && !l.startsWith('%%'));
    if (!firstMeaningful) return 'unknown';
    return (/^([A-Za-z][\w-]*)/.exec(firstMeaningful)?.[1]) ?? 'unknown';
}

// Diagram types whose SVG structure the extractor understands.
export const FULLY_SUPPORTED = new Set(['flowchart', 'graph']);
export const PARTIALLY_SUPPORTED = new Set([
    'classDiagram', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'sequenceDiagram',
]);

// Re-shape Mermaid's "Lexical error on line N. Unrecognized text..." message
// into something a user can act on: surface the diagram lines around the
// reported line, and call out the most common cause we've seen (inline `%%`
// comments at the end of directive lines, which Mermaid lexes as part of
// the directive instead of as a comment).
export function formatMermaidError(rawMsg: string, definition: string): string {
    const lineMatch = /(?:Lexical|Parse) error on line (\d+)\./.exec(rawMsg);
    if (!lineMatch) return rawMsg;

    const reportedLine = parseInt(lineMatch[1], 10);

    // Mermaid reports errors against the diagram body *after* it strips the
    // YAML frontmatter, so add the frontmatter line count back to map to
    // the user's original line numbering.
    const fmMatch = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(definition);
    const fmLineCount = fmMatch ? (fmMatch[0].match(/\n/g)?.length ?? 0) : 0;
    const actualLine = reportedLine + fmLineCount;

    const lines = definition.split('\n');
    const start = Math.max(0, actualLine - 3);
    const end = Math.min(lines.length, actualLine + 1);
    const ctx = lines.slice(start, end).map((l, i) => {
        const num = start + i + 1;
        const marker = num === actualLine ? '>' : ' ';
        return `${marker} ${num.toString().padStart(4)} | ${l}`;
    }).join('\n');

    // Inline-%% gotcha: a directive followed by `%% something` is a parse
    // error because Mermaid only treats %% as a comment when the line begins
    // with it (after optional whitespace).
    const offending = lines[actualLine - 1] ?? '';
    const inlineComment = /^[^%\n]*\S\s+%%/.test(offending);
    const hint = inlineComment
        ? '\n\nHint: This line ends with an inline `%% ...` comment.\n' +
          '      Mermaid only recognises `%%` as a comment when it starts the line; trailing\n' +
          '      `%%` text is lexed as part of the directive and triggers a syntax error.\n' +
          '      Move the comment to its own line.'
        : '';

    return `Mermaid syntax error:\n  ${rawMsg.trim().replace(/\n/g, '\n  ')}\n\n` +
           `Diagram (line ${actualLine}):\n${ctx}${hint}`;
}
