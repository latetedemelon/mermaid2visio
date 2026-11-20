# Testing Guide

This project uses **Jest** (with `ts-jest`) for automated testing.

## Prerequisites
- Node.js v22.12 or later
- npm

## Running Tests

To run the full test suite:
```bash
npm test
```

This will:
1. Build the injected extractor bundle and start one shared headless Chromium (Jest global setup).
1. Compile TypeScript on the fly (via `ts-jest`).
2. Run unit tests defined in `tests/`.
3. Verify that Mermaid parsing and VSDX generation work correctly.

## Test Structure

- **`tests/`**: Contains all test files (`*.test.ts`).
- **`tests/fixtures/`**: Contains sample `.mmd` files used for manual or integration testing.
- **`src/parser.ts`**: The core parsing logic being tested.
- **`src/vsdx.ts`**: The VSDX generation logic being tested.

## Adding New Tests

1. Create a new file in `tests/` (e.g., `tests/styling.test.ts`).
2. Import the necessary modules:
   ```typescript
   import { parseMermaid } from '../src/parser';
   import { VsdxGenerator } from '../src/vsdx';
   ```
3. Write your test case using `describe` and `it`.
4. Run `npm test` to verify.

## Manual Testing

For quick manual verification, you can run the CLI against the fixture files:

```bash
node dist/index.js tests/fixtures/test.mmd
```

This will generate `tests/fixtures/test.vsdx`, which you can open in Visio to visually inspect.
