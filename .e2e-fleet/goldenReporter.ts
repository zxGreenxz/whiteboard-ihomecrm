import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { isContractOracleFailureCode } from './specs/copilotContractOracle';
// Playwright call logs may contain fill values and private assertion payloads.
// Persist only the allowlisted checkpoint; never print error messages/attachments.
export default class GoldenReporter implements Reporter {
  private output: string[] = [];
  onBegin(config: FullConfig) { this.output = config.projects.map(p => p.outputDir); }
  onTestEnd(_test: TestCase, result: TestResult) {
    // Worker console output is otherwise swallowed by this custom reporter.
    // Rebuild only the two allowlisted static diagnostic fields; never forward
    // raw stdout, assertion messages, attachments, or arbitrary JSON properties.
    for (const line of result.stdout.map(chunk => chunk.toString()).join('').split(/\r?\n/)) {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 2 || !('caseId' in value) || !('code' in value)
          || typeof value.caseId !== 'string' || !['C31','C32','C33'].includes(value.caseId) || !isContractOracleFailureCode(value.code)) continue;
        console.log(JSON.stringify({ caseId: value.caseId, code: value.code }));
      } catch { /* Non-diagnostic worker output stays private. */ }
    }
    console.log(`golden browser: ${result.status}`);
  }
  onEnd() {
    for (const path of this.output) {
      const absolute = resolve(path);
      if (dirname(absolute) !== resolve(tmpdir()) || !/^copilot-golden-browser-\d+$/.test(basename(absolute))) throw new Error('Unsafe golden artifact directory');
      rmSync(absolute, { recursive: true, force: true });
    }
  }
}
