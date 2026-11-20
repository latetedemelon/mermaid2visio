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
    // Geometry family the generator draws: rectangle, circle, ellipse,
    // diamond, stadium, parallelogram, trapezoid, inv_trapezoid, hexagon,
    // cylinder, subroutine, "path" (drawn from `paths`) or "group"
    // (drawn by its `parts`).
    type?: string;
    // Where Mermaid placed the text (top-left corner and size, SVG pixels).
    textX?: number;
    textY?: number;
    textWidth?: number;
    textHeight?: number;
    // For type "path": the outline as Mermaid drew it.
    paths?: OutlinePath[];
    // For type "path": what sits at the ends of an open outline.
    lineStart?: string;
    lineEnd?: string;
    // Text boxes that belong to this node (class members, ER attributes...).
    // When present the node is written as a group holding them, so they
    // move with it.
    children?: GraphLabel[];
    // Drawn pieces that belong to this node, each with its own colours (a
    // C4 person's head and body, an architecture service's icon). With type
    // "group" the node has no outline of its own; it is a Visio group of
    // these parts and its children.
    parts?: GraphNode[];
    // Mermaid's own name for the shape (e.g. "lean_right", "hexagon"), from
    // its parsed model. Absent when the model was unavailable.
    shape?: string;
    // Id of the subgraph/group that directly contains this node, if any.
    parentId?: string;
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

// One drawable piece of a free-form outline.
export interface OutlinePath {
    // Polylines (curves already flattened), in SVG pixels relative to the
    // owning node's top-left corner.
    subpaths: Array<Array<[number, number]>>;
    fill: boolean;
    line: boolean;
}

export interface GraphEdge {
    d: string;
    startId?: string;
    endId?: string;
    arrowStart?: boolean;
    arrowEnd?: boolean;
    // What sits at each end, in Mermaid's vocabulary: "arrow_point",
    // "arrow_circle", "arrow_cross", "aggregation", "only_one", ... or "none".
    arrowStartKind?: string;
    arrowEndKind?: string;
    // Line pattern from the model, when known.
    pattern?: 'solid' | 'dashed' | 'dotted';
    text?: string;
    // Where Mermaid placed the label (top-left corner and size, SVG pixels).
    labelX?: number;
    labelY?: number;
    labelWidth?: number;
    labelHeight?: number;
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
    // Id of the enclosing subgraph, for nested subgraphs.
    parentId?: string;
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
    // Clockwise rotation in degrees about the box centre, as on screen.
    angle?: number;
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
    // Layout engine. Mermaid 12 bundles dagre and ELK (including the ELK
    // sub-algorithms such as 'elk.stress'); any other registered layout name
    // is passed through.
    layout?: 'dagre' | 'elk' | (string & {});
    theme?: 'default' | 'forest' | 'dark' | 'neutral' | 'base' | (string & {});
    themeVariables?: Record<string, string>;
    flowchart?: {
        nodeSpacing?: number;
        rankSpacing?: number;
        curve?: 'basis' | 'linear' | 'cardinal' | 'monotoneX';
        useMaxWidth?: boolean;
    };
    verbose?: boolean;
}
