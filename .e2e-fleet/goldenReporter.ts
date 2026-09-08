import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { safeGoldenCallDiagnostics, safeGoldenRequestFailures } from './specs/copilotGoldenDiagnostics';
import { isContractOracleFailureCode } from './specs/copilotContractOracle';
import { isIncomeApprovalOracleFailureCode } from './specs/copilotIncomeApprovalOracle';
import { isCustomerOracleFailureCode } from './specs/copilotCustomerOracle';
import { isFinancialReadFailureCode } from './specs/copilotFinancialReadOracle';
import { FINANCIAL_READ_CASES } from '../scripts/copilot-financial-read-fixtures.mjs';
// Playwright call logs may contain fill values and private assertion payloads.
// Persist only the allowlisted checkpoint; never print error messages/attachments.
export default class GoldenReporter implements Reporter {
  private output: string[] = [];
  onBegin(config: FullConfig) { this.output = config.projects.map(p => p.outputDir); }
  onTestEnd(_test: TestCase, result: TestResult) {
    // Worker console output is otherwise swallowed by this custom reporter.
    // Rebuild only validated static diagnostic fields and bounded call metadata; never forward
    // raw stdout, assertion messages, attachments, or arbitrary JSON properties.
    for (const line of result.stdout.map(chunk => chunk.toString()).join('').split(/\r?\n/)) {
      try {
        const value: unknown = JSON.parse(line);
        const failed = safeGoldenRequestFailures(value);
        if (failed) { console.log(JSON.stringify(failed)); continue; }
        const calls = safeGoldenCallDiagnostics(value);
        if (calls) { console.log(JSON.stringify(calls)); continue; }
        if (value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value && value.kind === 'golden-case-failure') {
          const fields = ['kind','caseId','phase','modelRequests','readResponses','modelHttpStatuses','businessWrites','networkErrors','consoleErrors'];
          const data = value as Record<string, unknown>;
          if (Object.keys(data).length !== fields.length || !Object.keys(data).every(key => fields.includes(key))
            || typeof data.caseId !== 'string' || !/^C(?:0[1-9]|[1-6]\d|7[0-5])$/.test(data.caseId)
            || typeof data.phase !== 'string' || !['idle','input','send','response','stream','completion','rounds','panel','mounted','oracle'].includes(data.phase)
            || !['modelRequests','readResponses','businessWrites','networkErrors','consoleErrors'].every(key => typeof data[key] === 'number' && Number.isInteger(data[key]) && Number(data[key]) >= 0 && Number(data[key]) <= 1000)
            || !Array.isArray(data.modelHttpStatuses) || data.modelHttpStatuses.length > 20 || !data.modelHttpStatuses.every(status => Number.isInteger(status) && status >= 100 && status <= 599)) continue;
          console.log(JSON.stringify({ kind: 'golden-case-failure', caseId: data.caseId, phase: data.phase,
            modelRequests: data.modelRequests, readResponses: data.readResponses, modelHttpStatuses: data.modelHttpStatuses,
            businessWrites: data.businessWrites, networkErrors: data.networkErrors, consoleErrors: data.consoleErrors }));
          continue;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 2 || !('caseId' in value) || !('code' in value)
          || typeof value.caseId !== 'string') continue;
        const contractCode = ['C31','C32','C33'].includes(value.caseId) && isContractOracleFailureCode(value.code);
        const financialCode = ['C34','C35','C36'].includes(value.caseId) && isIncomeApprovalOracleFailureCode(value.code);
        const customerCode = ['C02','C14'].includes(value.caseId) && isCustomerOracleFailureCode(value.code);
        const financialReadCode = Object.prototype.hasOwnProperty.call(FINANCIAL_READ_CASES,value.caseId) && isFinancialReadFailureCode(value.code);
        if (!contractCode && !financialCode && !customerCode && !financialReadCode) continue;
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
