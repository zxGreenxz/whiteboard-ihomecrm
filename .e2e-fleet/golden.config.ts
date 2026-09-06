import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig(base, {
  testMatch: /copilot-golden-readonly\.spec\.ts/,
  fullyParallel: false, workers: 1, retries: 0,
  timeout: 180_000, // Test ceiling, never a product SLA.
  reporter: [['./goldenReporter.ts']],
  outputDir: join(tmpdir(), `copilot-golden-browser-${process.pid}`),
  use: { ...base.use, headless: true, trace: 'off', screenshot: 'off', video: 'off' },
});
