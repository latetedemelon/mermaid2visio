// Browser entry point. Runs entirely client-side — no server, no Puppeteer.
// Shares the geometry extractor, normalizer, generator, and validator with
// the Node path via src/core/* + src/vsdx + src/validate (all browser-safe).

import mermaid from 'mermaid';
import { renderAndExtract, RENDER_ERROR_TAG } from '../extract/index.js';
import { buildMermaidConfig } from '../core/mermaidConfig.js';
import { detectDiagramType, formatMermaidError } from '../core/detect.js';
import { VsdxGenerator } from '../vsdx.js';
import { validateVsdx } from '../validate.js';

const srcEl = document.getElementById('src') as HTMLTextAreaElement;
const convertBtn = document.getElementById('convert') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const hostEl = document.getElementById('mermaid-host') as HTMLDivElement;
const themeEl = document.getElementById('theme') as HTMLSelectElement;

function setStatus(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
}

async function convert(): Promise<void> {
    const src = srcEl.value;
    if (!src.trim()) { setStatus('Empty diagram.', 'err'); return; }

    convertBtn.disabled = true;
    setStatus('Rendering...');
    try {
        // Same config builder and in-page pipeline as the Node renderer, so
        // both paths produce the same geometry for the same source.
        const { init } = buildMermaidConfig({ theme: (themeEl?.value as any) || undefined }, src);
        const dtype = detectDiagramType(src);
        let raw, bounds;
        try {
            ({ graph: raw, bounds } = await renderAndExtract(mermaid, src, init, dtype, hostEl));
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            const at = msg.indexOf(RENDER_ERROR_TAG);
            if (at < 0) throw err;
            throw new Error(formatMermaidError(msg.slice(at + RENDER_ERROR_TAG.length), src));
        }
        const totalShapes = raw.nodes.length + raw.edges.length + raw.clusters.length + raw.labels.length;

        setStatus(
            `Extracted ${raw.nodes.length} nodes, ${raw.edges.length} edges, ` +
            `${raw.clusters.length} clusters, ${raw.labels.length} labels ` +
            `(bounds ${bounds.minX.toFixed(0)},${bounds.minY.toFixed(0)} → ` +
            `${bounds.maxX.toFixed(0)},${bounds.maxY.toFixed(0)}). Generating VSDX...`,
        );

        const bytes = await new VsdxGenerator().generate(raw, src);
        const validation = await validateVsdx(bytes);

        // Trigger client-side download — nothing leaves the user's machine.
        const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.ms-visio.drawing' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagram.vsdx';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        const sizeKB = (bytes.byteLength / 1024).toFixed(1);
        if (validation.ok && totalShapes > 0) {
            setStatus(`Done — diagram.vsdx (${sizeKB} KB) downloaded, structural validation PASSED.`, 'ok');
        } else if (validation.ok && totalShapes === 0) {
            setStatus(
                `Generated diagram.vsdx (${sizeKB} KB) but no shapes were extracted (diagram type "${dtype}"). ` +
                `The file will open but be blank.`, 'err');
        } else {
            setStatus(`Generated but validator flagged: ${validation.errors.slice(0, 3).join('; ')}`, 'err');
        }
    } catch (e: any) {
        setStatus(e?.message ?? String(e), 'err');
    } finally {
        convertBtn.disabled = false;
    }
}

convertBtn.addEventListener('click', () => { void convert(); });
// Ctrl+Enter / Cmd+Enter from the textarea triggers conversion.
srcEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void convert(); }
});
