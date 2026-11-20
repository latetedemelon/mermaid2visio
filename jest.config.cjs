module.exports = {
  preset: 'ts-jest/presets/default-esm', // Use ESM preset
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // Builds the injected extractor bundle and starts one shared Chromium that
  // every parseMermaid() call in the suite attaches to.
  globalSetup: '<rootDir>/tests/global-setup.mjs',
  globalTeardown: '<rootDir>/tests/global-teardown.mjs',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  // v8 provider: collect coverage via Node's native V8 coverage API instead of
  // source-level Istanbul instrumentation. Istanbul rewrites parser.ts to add
  // counters like `cov_xxx`, but that source then gets serialized and run
  // inside Puppeteer's page.evaluate, where those globals do not exist.
  coverageProvider: 'v8',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/public/**',
    // Runs inside the browser page, where Node's coverage can't see it.
    '!src/extract/**',
    '!src/browser/**',
  ],
  coverageReporters: ['text-summary', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 70,
      functions: 75,
      lines: 70,
    },
  },
};
