import { describe, it, expect } from '@jest/globals';
import { explainLaunchFailure, launchBrowser } from '../src/parser';

// Pure-function tests for the Puppeteer error translator. No browser required.
describe('explainLaunchFailure', () => {
    it('flags exit code 127 as a missing-binary / missing-libs problem', () => {
        const msg = explainLaunchFailure(new Error('Failed to launch the browser process: Code 127'));
        expect(msg).toMatch(/missing/i);
        expect(msg).toMatch(/npx puppeteer browsers install chrome/);
        expect(msg).toMatch(/PUPPETEER_EXECUTABLE_PATH/);
    });

    it('flags exit code 126 as a permissions problem', () => {
        const msg = explainLaunchFailure(new Error('Failed to launch the browser process: Code 126'));
        expect(msg).toMatch(/not executable/i);
    });

    it('passes through the original error text so users can still see it', () => {
        const msg = explainLaunchFailure(new Error('ENOENT: /nope/chrome'));
        expect(msg).toContain('ENOENT: /nope/chrome');
    });

    it('calls out sandbox-as-root misconfiguration specifically', () => {
        const msg = explainLaunchFailure(new Error('Running as root without --no-sandbox is not supported'));
        expect(msg).toMatch(/refuses to run as root/i);
    });

    it('gives generic remediation for unknown launch failures', () => {
        const msg = explainLaunchFailure(new Error('something else went wrong'));
        expect(msg).toMatch(/could not launch/i);
        expect(msg).toMatch(/install chrome|PUPPETEER_EXECUTABLE_PATH/);
    });
});

describe('launchBrowser sandbox policy', () => {
    const fakeBrowser = {} as any;
    const hasNoSandbox = (args: string[]) => args.includes('--no-sandbox');

    it('keeps the Chromium sandbox on when the environment allows it', async () => {
        const calls: string[][] = [];
        const browser = await launchBrowser({ sandboxDisabled: false, launch: async (o) => { calls.push(o.args); return fakeBrowser; } });
        expect(browser).toBe(fakeBrowser);
        expect(calls.length).toBe(1);
        expect(hasNoSandbox(calls[0])).toBe(false);
    });

    it('skips the sandbox when running as root or told to', async () => {
        const calls: string[][] = [];
        await launchBrowser({ sandboxDisabled: true, launch: async (o) => { calls.push(o.args); return fakeBrowser; } });
        expect(calls.length).toBe(1);
        expect(hasNoSandbox(calls[0])).toBe(true);
    });

    it('falls back, with a warning, when the sandbox cannot start', async () => {
        const calls: string[][] = [];
        const warnings: string[] = [];
        const browser = await launchBrowser({
            sandboxDisabled: false,
            warn: (m) => warnings.push(m),
            launch: async (o) => {
                calls.push(o.args);
                if (!hasNoSandbox(o.args)) throw new Error('Failed to launch the browser process: No usable sandbox!');
                return fakeBrowser;
            },
        });
        expect(browser).toBe(fakeBrowser);
        expect(calls.map(hasNoSandbox)).toEqual([false, true]);
        expect(warnings.join(' ')).toMatch(/sandbox is unavailable/);
    });

    it('does not mask launch failures that are not about the sandbox', async () => {
        await expect(launchBrowser({
            sandboxDisabled: false,
            launch: async () => { throw new Error('spawn ENOENT'); },
        })).rejects.toThrow('ENOENT');
    });
});
