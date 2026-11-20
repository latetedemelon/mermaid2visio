// Reads Mermaid's parsed model for a diagram. The rendered SVG carries
// geometry but not meaning: shape names, edge endpoints, arrow types and line
// patterns live in the diagram's database object. Mermaid marks this API
// (mermaidAPI.getDiagramFromText, db.getData) as internal, so every access is
// guarded and callers must cope with `null`.

// JSON-safe deep copy: drops functions, DOM nodes and cycles, caps depth.
export function plain(value: unknown, depth = 7, seen: Set<object> = new Set()): unknown {
    if (value === null || value === undefined) return value ?? null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value;
    if (t !== 'object') return undefined;
    const obj = value as object;
    if (seen.has(obj) || depth <= 0) return undefined;
    if (typeof Node !== 'undefined' && obj instanceof Node) return undefined;
    seen.add(obj);
    let out: unknown;
    if (obj instanceof Map) {
        const o: Record<string, unknown> = {};
        for (const [k, v] of obj) o[String(k)] = plain(v, depth - 1, seen);
        out = o;
    } else if (obj instanceof Set || Array.isArray(obj)) {
        out = Array.from(obj as Iterable<unknown>).map(v => plain(v, depth - 1, seen) ?? null);
    } else {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            const p = plain(v, depth - 1, seen);
            if (p !== undefined) o[k] = p;
        }
        out = o;
    }
    seen.delete(obj);
    return out;
}

export interface RawModel {
    // Mermaid's own name for the diagram type (e.g. "flowchart-v2").
    type: string;
    // db.getData() for diagrams on the unified renderer; null otherwise.
    data: any;
    db: any;
}

export async function readRawModel(mermaid: any, definition: string): Promise<RawModel | null> {
    try {
        const diagram = await mermaid?.mermaidAPI?.getDiagramFromText?.(definition);
        if (!diagram) return null;
        const db = diagram.db ?? diagram.getDb?.() ?? null;
        let data: any = null;
        if (db && typeof db.getData === 'function') {
            try { data = db.getData(); } catch { data = null; }
        }
        return { type: String(diagram.type ?? ''), data, db };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Unified-renderer model: what db.getData() returns for flowchart, class,
// state, ER, requirement, mindmap, kanban, usecase, swimlane and agentflow.

export interface ModelNode {
    id: string;
    domId?: string;
    shape?: string;
    isGroup: boolean;
    parentId?: string;
    link?: string;
    label?: string;
}

export interface ModelEdge {
    id: string;
    start?: string;
    end?: string;
    arrowTypeStart?: string;
    arrowTypeEnd?: string;
    pattern?: string;
    thickness?: string;
}

export interface UnifiedModel {
    type: string;
    nodes: ModelNode[];
    edges: ModelEdge[];
    nodeById: Map<string, ModelNode>;
    edgeById: Map<string, ModelEdge>;
    // Resolve a DOM element id (already stripped of the svg-id prefix) to
    // the model node it draws.
    resolveNode(domId: string): ModelNode | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

// Block diagrams have no getData(); their database lists blocks and edges
// in the same vocabulary.
function blockData(db: any): any {
    try {
        if (typeof db?.getBlocksFlat !== 'function' || typeof db?.getEdges !== 'function') return null;
        const nodes = (db.getBlocksFlat() as any[])
            .filter(b => b && b.type !== 'space' && b.type !== 'composite' && b.id !== 'root')
            .map(b => ({ id: b.id, label: b.label, shape: b.type, isGroup: false }));
        return { nodes, edges: db.getEdges() };
    } catch {
        return null;
    }
}

export function toUnifiedModel(raw: RawModel | null): UnifiedModel | null {
    const data = raw?.data ?? blockData(raw?.db);
    if (!data || !Array.isArray(data.nodes)) return null;

    const nodes: ModelNode[] = [];
    for (const n of data.nodes) {
        const id = str(n?.id);
        if (!id) continue;
        nodes.push({
            id,
            domId: str(n.domId),
            shape: str(n.shape),
            isGroup: n.isGroup === true,
            parentId: str(n.parentId),
            link: str(n.link),
            label: str(n.label),
        });
    }
    const edges: ModelEdge[] = [];
    for (const e of Array.isArray(data.edges) ? data.edges : []) {
        const id = str(e?.id);
        if (!id) continue;
        edges.push({
            id,
            start: str(e.start),
            end: str(e.end),
            arrowTypeStart: str(e.arrowTypeStart),
            arrowTypeEnd: str(e.arrowTypeEnd),
            pattern: str(e.pattern),
            thickness: str(e.thickness),
        });
    }

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const byDomId = new Map(nodes.filter(n => n.domId).map(n => [n.domId!, n]));
    const edgeById = new Map(edges.map(e => [e.id, e]));

    // DOM ids are the model id wrapped in per-diagram scaffolding:
    // "flowchart-A-0", "classId-Animal-3", "state-Idle-8", "usecase-Customer",
    // or the bare id. Class diagrams number their DOM ids from a counter that
    // a second parse doesn't reproduce, so the model's own domId can't be
    // relied on there; peel the scaffolding instead.
    const resolveNode = (domId: string): ModelNode | undefined => {
        const direct = byDomId.get(domId) ?? nodeById.get(domId);
        if (direct) return direct;
        const noCounter = domId.replace(/-\d+$/, '');
        const noKind = domId.replace(/^[A-Za-z]+-/, '');
        const neither = noCounter.replace(/^[A-Za-z]+-/, '');
        return nodeById.get(neither) ?? nodeById.get(noCounter) ?? nodeById.get(noKind);
    };

    return { type: raw!.type, nodes, edges, nodeById, edgeById, resolveNode };
}
