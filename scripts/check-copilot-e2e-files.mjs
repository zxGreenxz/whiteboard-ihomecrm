#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_COPILOT_SPECS = [
  '.e2e-fleet/specs/copilot-confirmation.spec.ts',
  '.e2e-fleet/specs/copilot-draft-matrix.spec.ts',
  '.e2e-fleet/specs/copilot-readonly-smoke.spec.ts',
  '.e2e-fleet/specs/copilot-golden-readonly.spec.ts',
  '.e2e-fleet/specs/copilot-pageagent-safety.spec.ts',
  // G2-F: ma trận hàng rào SERVER của đường ghi (nonce, phát lại, song song,
  // phạm vi quyền, kill switch). Bốn spec trên đo phía trình duyệt; spec này đo
  // thứ còn lại khi ai đó bỏ qua trình duyệt hoàn toàn.
  '.e2e-fleet/specs/copilot-action-matrix.spec.ts',
  // G3-E2E: đồng ý theo LÔ — một phiếu đồng ý cho nhiều bước. Ma trận trên đo
  // hàng rào của MỘT thao tác ghi; spec này đo thứ chỉ tầng kế hoạch mới hỏng
  // được: nonce cấp kế hoạch, `plan_digest`, thứ tự tuyến tính, hạn thực thi,
  // và cầu dao kéo GIỮA một kế hoạch đã duyệt.
  '.e2e-fleet/specs/copilot-plan-batch-consent.spec.ts',
];

export function validateCopilotE2eFiles(root, required = REQUIRED_COPILOT_SPECS) {
  const problems = [];
  for (const file of required) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file}: required E2E spec is missing`);
      continue;
    }
    const source = readFileSync(path, 'utf8');
    if (!source.includes("from '@playwright/test'")) problems.push(`${file}: must use Playwright`);
    if (!/\btest\s*\(/.test(source)) problems.push(`${file}: must declare at least one test`);
    if (!/xacMinhBanBuild\s*\(/.test(source)) problems.push(`${file}: must call build attestation`);
    if (!/trackConsoleErrors\s*\(/.test(source)) problems.push(`${file}: must call console tracking`);
  }
  return problems;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = validateCopilotE2eFiles(root);
  if (problems.length) {
    console.error(`Copilot E2E file gate: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot E2E file gate: ${REQUIRED_COPILOT_SPECS.length} required specs present.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
