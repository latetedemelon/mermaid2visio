// Intermediate representation shared between the parser (Mermaid SVG -> IR)
// and the generator (IR -> VSDX). Lives here so the browser build can import
// it without pulling in the Node-only parts of src/parser.ts (Puppeteer,
// fs, http). Re-exported from src/parser.ts for back-compat.

export interface GraphNode {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    type?: string;
    rounding?: number;
    url?: string;
    style?: {
        fill?: string;
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
        color?: string;
        fontSize?: string;
        fontFamily?: string;
        fontWeight?: string;
        fontStyle?: string;
        textAlign?: string;
    };
}

export interface GraphEdge {
    d: string;
    startId?: string;
    endId?: string;
    arrowStart?: boolean;
    arrowEnd?: boolean;
    text?: string;
    style?: {
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
    };
    // Styling for the edge's label, forwarded to the connector's embedded
    // text so the caption matches the Mermaid theme rather than inheriting
    // Visio's default font.
    labelStyle?: {
        color?: string;
        fontSize?: string;
        fontWeight?: string;
        fontStyle?: string;
    };
}

export interface GraphCluster {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    style?: {
        fill?: string;
        stroke?: string;
        strokeWidth?: string;
        strokeDasharray?: string;
        color?: string;
        fontSize?: string;
    };
}

export interface GraphLabel {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    style?: {
        color?: string;
        fill?: string;
        fontSize?: string;
        fontFamily?: string;
        fontWeight?: string;
        fontStyle?: string;
    };
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
    clusters: GraphCluster[];
    labels: GraphLabel[];
    width: number;
    height: number;
}

export interface MermaidConfig {
    layout?: 'elk' | 'dagre' | 'flexbox' | 'linear';
    theme?: 'default' | 'forest' | 'dark' | 'neutral';
    themeVariables?: Record<string, string>;
    flowchart?: {
        nodeSpacing?: number;
        rankSpacing?: number;
        curve?: 'basis' | 'linear' | 'cardinal' | 'monotoneX';
        useMaxWidth?: boolean;
    };
    verbose?: boolean;
}
