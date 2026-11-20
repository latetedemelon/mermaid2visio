// Jest global setup: build the extractor bundle the renderer injects, and
// start one Chromium for the whole run. MermaidRenderer attaches to it via
// M2V_BROWSER_WS_ENDPOINT instead of launching a browser per parseMermaid().
import puppeteer from 'puppeteer';
import { buildExtractor } from '../scripts/build-extractor.mjs';

export default async function globalSetup() {
    await buildExtractor();
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    process.env.M2V_BROWSER_WS_ENDPOINT = browser.wsEndpoint();
    globalThis.__M2V_SHARED_BROWSER__ = browser;
}
