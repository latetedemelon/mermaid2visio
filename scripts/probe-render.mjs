#!/usr/bin/env node
// Renders every fixture in tests/fixtures/mermaid with the installed Mermaid
// and writes, per diagram: the SVG Mermaid produced and a JSON dump of its
// parsed model. The extractors depend on that output's structure, so this is
// how to see exactly what changed after a Mermaid upgrade:
//
//   npm run build && node scripts/probe-render.mjs            # -> tests/fixtures/svg/<version>/
//   git diff --stat tests/fixtures/svg
//
// Usage: node scripts/probe-render.mjs [outDir] [fixture.mmd ...]

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { mermaidScriptPath, extractorScriptPath, LAUNCH_ARGS } = await import(path.join(root, 'dist/render/renderer.js'));
const { buildMermaidConfig } = await import(path.join(root, 'dist/core/mermaidConfig.js'));

const version = createRequire(import.meta.url)(path.join(path.dirname(mermaidScriptPath()), '..', 'package.json')).version;
const args = process.argv.slice(2);
const outDir = path.resolve(args[0] && !args[0].endsWith('.mmd') ? args.shift() : path.join(root, 'tests/fixtures/svg', version));
const fixtureDir = path.join(root, 'tests/fixtures/mermaid');
const fixtures = args.length ? args.map(a => path.resolve(a)) : fs.readdirSync(fixtureDir).filter(f => f.endsWith('.mmd')).sort().map(f => path.join(fixtureDir, f));

// The resolved Mermaid config is repeated in every model and dwarfs the rest.
const slim = (o) => {
    if (!o || typeof o !== 'object') return o;
    const { config, getConfig, getDiagramConfig, ...rest } = o;
    return rest;
};

fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
console.log(`mermaid ${version} -> ${path.relative(root, outDir)}`);
let failed = 0;
try {
    for (const file of fixtures) {
        const name = path.basename(file, '.mmd');
        const definition = fs.readFileSync(file, 'utf8');
        const page = await browser.newPage();
        try {
            await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="m2v-host"></div></body></html>');
            await page.addScriptTag({ path: mermaidScriptPath() });
            await page.addScriptTag({ path: extractorScriptPath() });
            const { init } = buildMermaidConfig(undefined, definition);
            const r = await page.evaluate(
                (def, initConfig) => window.__m2v.probe(window.mermaid, def, initConfig, document.getElementById('m2v-host')),
                definition, init,
            );
            // One element per line keeps diffs between Mermaid versions readable.
            fs.writeFileSync(path.join(outDir, `${name}.svg`), r.svg.replace(/></g, '>\n<') + '\n');
            fs.writeFileSync(path.join(outDir, `${name}.model.json`), JSON.stringify({ mermaidType: r.mermaidType, counts: r.counts, data: slim(r.data), getters: slim(r.getters) }, null, 1) + '\n');
            const c = r.counts;
            console.log(`${name.padEnd(14)} ${String(r.mermaidType).padEnd(18)} node=${c.node} edge=${c.edgePath} cluster=${c.cluster} rect=${c.rect} path=${c.path} line=${c.line} text=${c.text} fo=${c.foreignObject} model=${r.data ? 'getData' : Object.keys(r.getters).length ? 'getters' : 'none'}`);
        } catch (e) {
            failed++;
            console.log(`${name.padEnd(14)} FAILED: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`);
        } finally {
            await page.close();
        }
    }
} finally {
    await browser.close();
}
process.exitCode = failed ? 1 : 0;
