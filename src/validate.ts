import JSZip from 'jszip';
import { create } from 'xmlbuilder2';

// Structural validator for the VSDX packages this project emits.
//
// Why this exists: there is no Microsoft Visio (and, in CI/sandboxes, often no
// working LibreOffice) to act as an oracle. Visio's failure mode for a
// schema-invalid package is the opaque error 1400015 / 0x10F — it tells you
// nothing about *which* part is wrong. This validator encodes the package-level
// invariants we actually depend on so a regression surfaces as a precise,
// human-readable message at generate-time / test-time instead.
//
// It checks OOXML package integrity (relationship targets resolve, every part
// has a content type) plus the Visio-specific ShapeSheet rules we've each
// burned a debugging session on (formulas belong in F not V, colors are
// #RRGGBB, Character.Size carries no U="PT", Connection rows start at IX>=1,
// and <Connects> reference real shapes). It is intentionally conservative:
// every rule here corresponds to a documented constraint, so a failure means a
// real problem rather than a stylistic preference.

export interface ValidationResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
}

// xmlbuilder2's object format collapses a single child to an object and
// multiple same-named children to an array. Normalize to an array so callers
// can always iterate.
function asArray<T>(v: T | T[] | undefined | null): T[] {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

// Resolve an OOXML relationship Target (relative to the part's own directory)
// to a normalized package path, collapsing "../" segments.
function resolveRelTarget(baseDir: string, target: string): string {
    // Absolute targets (start with "/") are package-root relative.
    if (target.startsWith('/')) return target.slice(1);
    const segments = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
    const out: string[] = [];
    for (const seg of segments) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
    }
    return out.join('/');
}

// The .rels file that governs a part lives at "<dir>/_rels/<name>.rels".
// Targets inside it are relative to "<dir>". Recover "<dir>" from the .rels path.
function baseDirForRels(relsPath: string): string {
    // e.g. "visio/_rels/document.xml.rels" -> "visio"
    //      "_rels/.rels"                   -> ""
    const m = /^(.*?)_rels\/[^/]+$/.exec(relsPath);
    if (!m) return '';
    return m[1].replace(/\/$/, '');
}

export async function validateVsdx(buffer: Uint8Array): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(buffer);
    } catch (e: any) {
        return { ok: false, errors: [`Not a valid ZIP/OPC package: ${e?.message ?? e}`], warnings };
    }

    const parts = new Set<string>();
    zip.forEach((relPath, file) => { if (!file.dir) parts.add(relPath); });

    const readText = async (p: string): Promise<string | null> => {
        const f = zip.file(p);
        return f ? f.async('string') : null;
    };
    const readObj = async (p: string): Promise<any | null> => {
        const txt = await readText(p);
        if (txt === null) return null;
        try {
            return create(txt).end({ format: 'object' });
        } catch (e: any) {
            errors.push(`${p}: XML parse failed: ${e?.message ?? e}`);
            return null;
        }
    };

    // 1. Required parts must be present. These are the minimum set Visio's
    //    loader expects; a missing one is a common 1400015 trigger.
    const required = [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/app.xml',
        'docProps/core.xml',
        'visio/document.xml',
        'visio/_rels/document.xml.rels',
        'visio/windows.xml',
        'visio/pages/pages.xml',
        'visio/pages/_rels/pages.xml.rels',
        'visio/pages/page1.xml',
    ];
    for (const r of required) {
        if (!parts.has(r)) errors.push(`Missing required part: ${r}`);
    }

    // 2. Content-types coverage: every part (except the content-types map
    //    itself) must be typed by a Default (extension) or Override (partname).
    const ctObj = await readObj('[Content_Types].xml');
    const defaults = new Map<string, string>();   // extension(lowercase) -> type
    const overrides = new Map<string, string>();   // "/part/name" -> type
    if (ctObj?.Types) {
        for (const d of asArray<any>(ctObj.Types.Default)) {
            if (d['@Extension']) defaults.set(String(d['@Extension']).toLowerCase(), d['@ContentType']);
        }
        for (const o of asArray<any>(ctObj.Types.Override)) {
            if (o['@PartName']) overrides.set(o['@PartName'], o['@ContentType']);
        }
    } else {
        errors.push('[Content_Types].xml: missing <Types> root');
    }
    for (const p of parts) {
        if (p === '[Content_Types].xml') continue;
        const ext = (p.split('.').pop() || '').toLowerCase();
        const hasDefault = defaults.has(ext);
        const hasOverride = overrides.has('/' + p);
        if (!hasDefault && !hasOverride) {
            errors.push(`Content type not declared for part: ${p} (no Default[.${ext}] and no Override[/${p}])`);
        }
    }

    // 3. Relationship integrity: every Target in every .rels resolves to a part
    //    that actually exists in the package. A dangling rId silently breaks
    //    page/window loading.
    const relsParts = [...parts].filter(p => p.endsWith('.rels'));
    for (const relsPath of relsParts) {
        const obj = await readObj(relsPath);
        if (!obj?.Relationships) { errors.push(`${relsPath}: missing <Relationships> root`); continue; }
        const baseDir = baseDirForRels(relsPath);
        for (const rel of asArray<any>(obj.Relationships.Relationship)) {
            const target = rel['@Target'];
            const mode = rel['@TargetMode'];
            if (mode === 'External') continue; // hyperlinks etc.
            if (!target) { errors.push(`${relsPath}: relationship ${rel['@Id']} has no Target`); continue; }
            const resolved = resolveRelTarget(baseDir, target);
            if (!parts.has(resolved)) {
                errors.push(`${relsPath}: relationship ${rel['@Id']} -> "${target}" resolves to "${resolved}" which does not exist`);
            }
        }
    }

    // Root .rels must declare the Visio document relationship, or Visio won't
    // know where the drawing starts.
    const rootRels = await readObj('_rels/.rels');
    if (rootRels?.Relationships) {
        const hasDoc = asArray<any>(rootRels.Relationships.Relationship)
            .some(r => String(r['@Type']).includes('/relationships/document'));
        if (!hasDoc) errors.push('_rels/.rels: no document relationship');
    }

    // 3b. No NaN / undefined / Infinity anywhere in any XML attribute. These
    //     leak in when a coordinate is computed from a missing value; Visio
    //     silently drops the offending cell (collapsing geometry or transform)
    //     rather than erroring, so they're invisible without a check like this.
    for (const p of [...parts].filter(p => p.endsWith('.xml'))) {
        const txt = await readText(p);
        if (txt === null) continue;
        const bad = txt.match(/="(NaN|undefined|null|Infinity|-Infinity)"/g);
        if (bad) {
            const uniq = [...new Set(bad)].join(', ');
            errors.push(`${p}: contains non-finite/invalid attribute value(s): ${uniq}`);
        }
    }

    // 4. Page-level ShapeSheet checks.
    const pageObj = await readObj('visio/pages/page1.xml');
    const pageText = (await readText('visio/pages/page1.xml')) ?? '';
    if (pageObj) {
        const pc = pageObj.PageContents;
        if (!pc) {
            errors.push('page1.xml: missing <PageContents> root');
        } else {
            const shapes = asArray<any>(pc.Shapes?.Shape);
            const shapeIds = new Set<number>();
            for (const sh of shapes) {
                const id = Number(sh['@ID']);
                if (!Number.isFinite(id)) { errors.push(`page1.xml: a Shape has a non-numeric ID "${sh['@ID']}"`); continue; }
                if (shapeIds.has(id)) errors.push(`page1.xml: duplicate Shape ID ${id}`);
                shapeIds.add(id);

                // Cell-value rules (computed from the parsed model).
                for (const cell of asArray<any>(sh.Cell)) {
                    const n = cell['@N'];
                    const v = cell['@V'];
                    const u = cell['@U'];
                    // Colors must be #RRGGBB.
                    if ((n === 'FillForegnd' || n === 'LineColor' || n === 'Color') && v !== undefined) {
                        if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) {
                            errors.push(`page1.xml: Shape ${id} cell ${n} V="${v}" is not #RRGGBB`);
                        }
                    }
                    // A bare formula token in V (no F attr) is dropped by Visio.
                    if (v !== undefined && cell['@F'] === undefined && /\b(?:Width|Height|PageWidth|PageHeight)\b/.test(String(v))) {
                        errors.push(`page1.xml: Shape ${id} cell ${n} has a formula in V="${v}" (should be in F=)`);
                    }
                    // Character.Size must be a plain inch number with no U="PT".
                    if (n === 'Size') {
                        if (u === 'PT') errors.push(`page1.xml: Shape ${id} Size cell has U="PT" (Visio reads Size in inches; renders V inches tall)`);
                        if (!/^\d+(?:\.\d+)?$/.test(String(v))) errors.push(`page1.xml: Shape ${id} Size cell V="${v}" is not a plain number`);
                    }
                }

                // Connection rows must start at IX>=1 (IX=0 is silently skipped).
                for (const sec of asArray<any>(sh.Section)) {
                    if (sec['@N'] === 'Connection') {
                        for (const row of asArray<any>(sec.Row)) {
                            if (Number(row['@IX']) === 0) {
                                errors.push(`page1.xml: Shape ${id} Connection section has a Row IX="0" (Visio ignores it)`);
                            }
                        }
                    }
                }
            }

            // 5. Connects referential integrity: every FromSheet/ToSheet must
            //    reference a real Shape ID. A dangling Connect makes Visio drop
            //    the glue, leaving the connector floating.
            for (const c of asArray<any>(pc.Connects?.Connect)) {
                const from = Number(c['@FromSheet']);
                const to = Number(c['@ToSheet']);
                if (!shapeIds.has(from)) errors.push(`page1.xml: Connect FromSheet=${c['@FromSheet']} references a missing Shape`);
                if (!shapeIds.has(to)) errors.push(`page1.xml: Connect ToSheet=${c['@ToSheet']} references a missing Shape`);
            }

            // <Connects> must be a sibling of <Shapes> under <PageContents>,
            // not nested inside <Shapes>. The object model can't see element
            // order, so confirm via the raw text that </Shapes> precedes
            // <Connects> when both are present.
            if (pc.Connects) {
                const shapesClose = pageText.indexOf('</Shapes>');
                const connectsOpen = pageText.indexOf('<Connects');
                if (shapesClose !== -1 && connectsOpen !== -1 && connectsOpen < shapesClose) {
                    errors.push('page1.xml: <Connects> appears inside <Shapes>; it must be a sibling under <PageContents>');
                }
            }
        }

        // Shape child order: Cells -> Sections -> Text. Verified on raw text
        // because element interleave order is invisible in the object model.
        const shapeBlocks = pageText.match(/<Shape\b[^>]*>[\s\S]*?<\/Shape>/g) || [];
        for (const block of shapeBlocks) {
            const idMatch = /ID="(\d+)"/.exec(block);
            const id = idMatch ? idMatch[1] : '?';
            const textIdx = block.indexOf('<Text>');
            const lastSection = block.lastIndexOf('</Section>');
            if (textIdx !== -1 && lastSection !== -1 && textIdx < lastSection) {
                errors.push(`page1.xml: Shape ${id} emits <Text> before a </Section> (schema order is Cells->Sections->Text)`);
            }
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}
