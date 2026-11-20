#!/usr/bin/env node
// Bundles src/extract/page.ts into dist/extractor.iife.js: a self-contained
// script the Node renderer injects into its headless page (and the GUI serves
// to its preview). Run by `npm run build` and by Jest's global setup.

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildExtractor() {
    const outfile = path.join(root, 'dist', 'extractor.iife.js');
    await build({
        entryPoints: [path.join(root, 'src', 'extract', 'page.ts')],
        bundle: true,
        format: 'iife',
        target: 'es2020',
        outfile,
        logLevel: 'warning',
    });
    return outfile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const outfile = await buildExtractor();
    console.log(`built ${path.relative(root, outfile)}`);
}
