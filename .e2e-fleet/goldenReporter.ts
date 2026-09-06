import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
// Playwright call logs may contain fill values and private assertion payloads.
// Persist only the allowlisted checkpoint; never print error messages/attachments.
export default class GoldenReporter implements Reporter {
  private output: string[] = [];
  onBegin(config: FullConfig) { this.output = config.projects.map(p => p.outputDir); }
  onTestEnd(_test: TestCase, result: TestResult) { console.log(`golden browser: ${result.status}`); }
  onEnd() {
    for (const path of this.output) {
      const absolute = resolve(path);
      if (dirname(absolute) !== resolve(tmpdir()) || !/^copilot-golden-browser-\d+$/.test(basename(absolute))) throw new Error('Unsafe golden artifact directory');
      rmSync(absolute, { recursive: true, force: true });
    }
  }
}
