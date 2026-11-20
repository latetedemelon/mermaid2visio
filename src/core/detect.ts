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

export type SupportLevel = 'full' | 'partial' | 'none';

export interface DiagramKind {
    // Stable name used throughout this project.
    kind: string;
    // Matches the first token of the diagram source (what detectDiagramType
    // returns). Mirrors Mermaid 12.3's own detectors.
    match: RegExp;
    // How much of the diagram comes across as editable Visio shapes today.
    support: SupportLevel;
}

// Every diagram type Mermaid 12.3 can render, with how well this tool
// converts it. Order matters: the first match wins.
export const DIAGRAM_KINDS: DiagramKind[] = [
    { kind: 'flowchart', match: /^(flowchart(-elk)?|graph)$/, support: 'full' },
    { kind: 'sequence', match: /^sequenceDiagram$/, support: 'partial' },
    { kind: 'class', match: /^classDiagram(-v2)?$/, support: 'partial' },
    { kind: 'state', match: /^stateDiagram(-v2)?$/, support: 'partial' },
    { kind: 'er', match: /^erDiagram$/, support: 'partial' },
    { kind: 'requirement', match: /^requirement(Diagram)?$/, support: 'none' },
    { kind: 'mindmap', match: /^mindmap$/, support: 'none' },
    { kind: 'kanban', match: /^kanban$/, support: 'none' },
    { kind: 'c4', match: /^C4(Context|Container|Component|Dynamic|Deployment)$/, support: 'none' },
    { kind: 'block', match: /^block(-beta)?$/, support: 'none' },
    { kind: 'architecture', match: /^architecture(-beta)?$/, support: 'none' },
    { kind: 'usecase', match: /^usecase(-beta)?$/i, support: 'none' },
    { kind: 'swimlane', match: /^swimlane(-beta)?$/, support: 'none' },
    { kind: 'agentflow', match: /^agentflow(-beta)?$/, support: 'none' },
    { kind: 'eventmodeling', match: /^eventmodeling$/, support: 'none' },
    { kind: 'pie', match: /^pie$/, support: 'none' },
    { kind: 'gantt', match: /^gantt$/, support: 'none' },
    { kind: 'journey', match: /^journey$/, support: 'none' },
    { kind: 'gitGraph', match: /^gitGraph$/, support: 'none' },
    { kind: 'timeline', match: /^timeline$/, support: 'none' },
    { kind: 'quadrant', match: /^quadrantChart$/, support: 'none' },
    { kind: 'xychart', match: /^xychart(-beta)?$/, support: 'none' },
    { kind: 'sankey', match: /^sankey(-beta)?$/, support: 'none' },
    { kind: 'packet', match: /^packet(-beta)?$/, support: 'none' },
    { kind: 'radar', match: /^radar(-beta)?$/, support: 'none' },
    { kind: 'treemap', match: /^treemap(-beta)?$/, support: 'none' },
    { kind: 'treeView', match: /^treeView(-beta)?$/, support: 'none' },
    { kind: 'venn', match: /^venn(-beta)?$/, support: 'none' },
    { kind: 'ishikawa', match: /^ishikawa(-beta)?$/i, support: 'none' },
    { kind: 'wardley', match: /^wardley(-beta)?$/i, support: 'none' },
    { kind: 'cynefin', match: /^cynefin(-beta)?$/i, support: 'none' },
    { kind: 'railroad', match: /^railroad(-(ebnf|abnf|peg))?(-beta)?$/i, support: 'none' },
];

// Resolve a detectDiagramType() token to its registry entry, if known.
export function diagramKind(type: string): DiagramKind | undefined {
    return DIAGRAM_KINDS.find(k => k.match.test(type));
}

export function supportLevel(type: string): SupportLevel {
    return diagramKind(type)?.support ?? 'none';
}

const tokensWithSupport = (level: SupportLevel) => new Set([
    'flowchart', 'flowchart-elk', 'graph', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2',
    'stateDiagram', 'stateDiagram-v2', 'erDiagram',
].filter(t => supportLevel(t) === level));

// Kept for existing callers; prefer supportLevel().
export const FULLY_SUPPORTED = tokensWithSupport('full');
export const PARTIALLY_SUPPORTED = tokensWithSupport('partial');

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
