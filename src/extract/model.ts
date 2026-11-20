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
