// Browser entry point. Runs entirely client-side — no server, no Puppeteer.
// Shares the geometry extractor, normalizer, generator, and validator with
// the Node path via src/core/* + src/vsdx + src/validate (all browser-safe).

import mermaid from 'mermaid';
import { extractGraphFromDom } from '../core/extract.js';
import { normalizeContentBounds } from '../core/normalize.js';
import { detectDiagramType, formatMermaidError } from '../core/detect.js';
import { VsdxGenerator } from '../vsdx.js';
import { validateVsdx } from '../validate.js';

const srcEl = document.getElementById('src') as HTMLTextAreaElement;
const convertBtn = document.getElementById('convert') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const hostEl = document.getElementById('mermaid-host') as HTMLDivElement;
const themeEl = document.getElementById('theme') as HTMLSelectElement;

mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

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
        // Re-init so theme changes take effect on subsequent renders.
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: (themeEl?.value as any) || 'neutral',
        });

        // Render into the visible host so getBBox/getCTM see laid-out geometry.
        let svg: string;
        try {
            ({ svg } = await mermaid.render('graphDiv', src));
        } catch (renderErr: any) {
            throw new Error(formatMermaidError(renderErr?.message ?? String(renderErr), src));
        }
        hostEl.innerHTML = svg;

        const dtype = detectDiagramType(src);
        const raw = extractGraphFromDom(dtype);
        const bounds = normalizeContentBounds(raw);
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
