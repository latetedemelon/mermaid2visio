import { describe, it, expect } from '@jest/globals';
import { explainLaunchFailure } from '../src/parser';

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
