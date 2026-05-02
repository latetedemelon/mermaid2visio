import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseMermaid } from '../src/parser';
import { VsdxGenerator } from '../src/vsdx';

// End-to-end smoke test: round-trip our generated VSDX through LibreOffice's
// libvisio importer and assert it produces a non-trivial PDF. LibreOffice's
// VSDX import isn't a perfect Visio oracle, but it's strict about the same
// things Visio is strict about (relationship chain, content types, schema
// order, formula attributes), so a successful conversion is a strong signal.
//
// Skipped when `soffice` isn't on PATH so local `npm test` stays fast and
// portable. CI installs libreoffice-draw before running.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = ['all_features.mmd', 'rob_test.mmd'];

function findSoffice(): string | null {
    const candidates = ['soffice', 'libreoffice'];
    for (const cmd of candidates) {
        const r = spawnSync('which', [cmd], { encoding: 'utf-8' });
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
}

// Probe whether soffice can actually convert a VSDX file (requires
// libreoffice-draw / libvisio, which may not be installed even when the
// soffice binary is present). We use the reference fixture as the probe.
function canConvertVsdx(bin: string): boolean {
    try {
        const fixtureVsdx = path.resolve(here, 'fixtures', 'diagram (5).vsdx');
        if (!fs.existsSync(fixtureVsdx)) return false;
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsdx-probe-'));
        const profileDir = path.join(tmpDir, 'profile');
        const outDir = path.join(tmpDir, 'out');
        fs.mkdirSync(outDir);
        const r = spawnSync(bin, [
            '--headless',
            `-env:UserInstallation=file://${profileDir}`,
            '--convert-to', 'pdf',
            '--outdir', outDir,
            fixtureVsdx,
        ], { timeout: 30_000, encoding: 'utf-8' });
        const hasOutput = fs.readdirSync(outDir).some(f => f.endsWith('.pdf'));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return hasOutput && r.status === 0;
    } catch {
        return false;
    }
}

const sofficePath = findSoffice();
const sofficeCanVsdx = sofficePath ? canConvertVsdx(sofficePath) : false;
const describeIfSoffice = sofficeCanVsdx ? describe : describe.skip;

describeIfSoffice('VSDX round-trips through LibreOffice', () => {
    it.each(fixtures)('opens %s in LibreOffice and exports to a non-empty PDF', async (fixture) => {
        const src = fs.readFileSync(path.resolve(here, 'fixtures', fixture), 'utf-8');
        const graph = await parseMermaid(src);
        const buf = await new VsdxGenerator().generate(graph);

        const base = fixture.replace(/\.mmd$/, '');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsdx-render-'));
        const vsdxPath = path.join(tmpDir, `${base}.vsdx`);
        const outDir = path.join(tmpDir, 'out');
        fs.writeFileSync(vsdxPath, buf);
        fs.mkdirSync(outDir);

        // --headless avoids the GUI; --convert-to pdf triggers draw_pdf_Export;
        // -env:UserInstallation isolates per-test profile so parallel jobs
        // don't trip over the LibreOffice singleton lock.
        const profileDir = path.join(tmpDir, 'lo-profile');
        try {
            execFileSync(sofficePath!, [
                '--headless',
                `-env:UserInstallation=file://${profileDir}`,
                '--convert-to', 'pdf',
                '--outdir', outDir,
                vsdxPath,
            ], { stdio: 'pipe', timeout: 90_000 });
        } catch (err: any) {
            const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
            throw new Error(`soffice conversion failed for ${fixture}: ${err.message}\n${out}`);
        }

        const pdfPath = path.join(outDir, `${base}.pdf`);
        expect(fs.existsSync(pdfPath)).toBe(true);

        const pdf = fs.readFileSync(pdfPath);
        // 2 KB is a reasonable floor; an empty/blank conversion is ~1 KB.
        expect(pdf.length).toBeGreaterThan(2_000);
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

        fs.rmSync(tmpDir, { recursive: true, force: true });
    }, 180_000);
});
