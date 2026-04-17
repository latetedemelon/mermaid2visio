#!/usr/bin/env node
// Diagnoses common mermaid2visio environment issues.
//   - Bundled Chromium present and executable?
//   - Launching it actually works?
//   - Required optional packages (ELK) resolvable?
// Exits 0 on all-clear, 1 otherwise. Intended for `npm run doctor`.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;
const yellow = (s) => `\u001b[33m${s}\u001b[0m`;
let problems = 0;
const ok = (m) => console.log(`${green('\u2713')} ${m}`);
const warn = (m) => { console.log(`${yellow('!')} ${m}`); problems++; };
const fail = (m) => { console.log(`${red('\u2717')} ${m}`); problems++; };

// 1. Puppeteer bundled Chromium
let puppeteer;
try {
    puppeteer = (await import('puppeteer')).default;
    ok('puppeteer package resolves');
} catch (e) {
    fail(`puppeteer not installed: ${e.message}`);
    process.exit(1);
}

const override = process.env.PUPPETEER_EXECUTABLE_PATH;
let execPath;
try {
    execPath = override || puppeteer.executablePath();
} catch (e) {
    fail(`puppeteer.executablePath() threw: ${e.message}`);
}
if (execPath) {
    console.log(`  chromium path: ${execPath}`);
    if (!fs.existsSync(execPath)) {
        fail('chromium binary does not exist at that path');
        console.log(`  fix: npx puppeteer browsers install chrome`);
    } else {
        try {
            fs.accessSync(execPath, fs.constants.X_OK);
            ok('chromium binary is executable');
        } catch {
            fail('chromium binary is not executable (chmod +x required)');
        }
    }
}

// 2. Try a real launch
try {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    await browser.close();
    ok('chromium launches successfully');
} catch (e) {
    fail(`chromium launch failed: ${e.message.split('\n')[0]}`);
    if (/code:\s*127/i.test(e.message)) {
        console.log(`  hint: missing shared libraries. On Debian/Ubuntu run:`);
        console.log(`    sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 \\`);
        console.log(`      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \\`);
        console.log(`      libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2`);
    }
}

// 3. Optional ELK loader
const elkPath = path.resolve(__dirname, '..', 'node_modules/@mermaid-js/layout-elk/dist/mermaid-layout-elk.esm.min.mjs');
if (fs.existsSync(elkPath)) {
    ok('@mermaid-js/layout-elk is installed');
} else {
    warn('@mermaid-js/layout-elk not installed (ELK layout will fall back to dagre)');
    console.log('  fix: npm install @mermaid-js/layout-elk');
}

console.log('');
if (problems === 0) {
    console.log(green('All checks passed.'));
    process.exit(0);
} else {
    console.log(red(`${problems} problem${problems === 1 ? '' : 's'} found.`));
    process.exit(1);
}
