#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Số ca đã đạt được — bộ ca chỉ được lớn hơn mức này, không được teo về. */
export const SAN_SO_CA = 75;

export function validateGolden(golden) {
  const problems = [];
  if (golden?.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (!golden?.provenance?.buildShaRequired || !golden?.provenance?.providerModelRequired) {
    problems.push('build SHA and provider/model provenance must be required');
  }
  if (!Array.isArray(golden?.provenance?.lane) || !golden.provenance.lane.includes('mock') || !golden.provenance.lane.includes('real-model')) {
    problems.push('provenance lane must include mock and real-model');
  }
  const allowedScenarios = new Set([
    'positive',
    'empty',
    'orchestration',
    'error',
    'knowledge',
    'navigation',
    'ui-control',
    'relative-date',
    // G2-B. Mot ca `forbidden` la mot ca ma cau tra loi DUNG la TU CHOI; no
    // khong thuoc ho voi 'error' (loi xac thuc du lieu) hay 'positive'. Thieu
    // ten nay thi ba ca cam moi them phai muon mot ten sai, va bao cao doc len
    // se ke rang he thong da lam dung mot viec no vua tu choi lam.
    'forbidden',
  ]);
  if (golden?.mockOracle?.deterministic !== true || !Array.isArray(golden?.mockOracle?.requiredScenarios)) {
    problems.push('mockOracle must declare deterministic and requiredScenarios');
  } else {
    for (const scenario of golden.mockOracle.requiredScenarios) {
      if (!allowedScenarios.has(scenario)) problems.push(`mockOracle: unknown scenario ${scenario}`);
    }
  }
  const cases = Array.isArray(golden?.cases) ? golden.cases : [];
  // SÀN, KHÔNG PHẢI SỐ CỐ ĐỊNH. Bản trước ghi cứng 30 — con số của bộ ca ngày
  // 13/08/2026 — nên THÊM một ca mới cũng làm gate đỏ, và cách "sửa" rẻ nhất là
  // đừng thêm ca nào. Một cửa chặn phạt việc mở rộng phạm vi đo là cửa chặn
  // đang làm ngược việc của nó. Nay: tập id phải liên tục từ C01 và chỉ được
  // LỚN LÊN (sàn = mức đã đạt: 71 sau G3-TS, 75 sau G5-D/E fix round 1 thêm
  // ba ca C73-C75 cho Mức 3 — kế hoạch có bước cần PIN, hai biến thể PIN-qua-
  // chat), tức xoá ca vẫn bị bắt.
  if (cases.length < SAN_SO_CA) {
    problems.push(`cases must keep at least ${SAN_SO_CA} entries (found ${cases.length})`);
  }
  const expectedIds = Array.from({ length: cases.length }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
  const actualIds = cases.map((item) => item?.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    problems.push(`cases must be exactly C01-${expectedIds.at(-1) ?? 'C01'} in order`);
  }
  for (const item of cases) {
    if (!item?.input || !item?.expectedOutcome) problems.push(`${item?.id ?? '<unknown>'}: missing input/outcome`);
    if (!Array.isArray(item?.toolPath)) problems.push(`${item?.id ?? '<unknown>'}: toolPath must be an array`);
    if (typeof item?.forbidden !== 'boolean') problems.push(`${item?.id ?? '<unknown>'}: forbidden must be boolean`);
    if (item?.forbidden && item?.expectedOutcome !== 'forbidden') problems.push(`${item?.id ?? '<unknown>'}: forbidden case must expect forbidden outcome`);
    if (item?.emptyState !== 'explicit') problems.push(`${item?.id ?? '<unknown>'}: emptyState must be explicit`);
    if (!allowedScenarios.has(item?.oracleScenario)) problems.push(`${item?.id ?? '<unknown>'}: oracleScenario is required`);
  }
  const sla = golden?.latencySlaMs;
  if (sla?.status !== 'pending-owner-approval') {
    for (const field of ['p50', 'p95', 'max']) {
      if (!Number.isFinite(sla?.[field]) || sla[field] <= 0) problems.push(`latency ${field} must be a positive number`);
    }
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const golden = JSON.parse(readFileSync(join(root, 'tooling', 'copilot-golden-eval.json'), 'utf8'));
  const problems = validateGolden(golden);
  if (problems.length) {
    console.error(`Copilot golden eval: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot golden eval: ${golden.cases.length} cases validated; latency SLA ${golden.latencySlaMs.status}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
