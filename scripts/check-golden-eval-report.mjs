#!/usr/bin/env node
/**
 * Gate: kiểm báo cáo golden eval (lane mock) sinh bởi run-copilot-golden-eval.mjs.
 *
 * VÌ SAO TÁCH RA SCRIPT
 *   Bản trước là một khối `node -e '…'` nhúng trong ci-gates.yml, và số ca mong
 *   đợi bị ghi CỨNG (30). G1-C1 thêm C31-C36, G1-C2 thêm tiếp — mỗi lần thêm ca
 *   vào tooling/copilot-golden-eval.json là CI đỏ vì "khong du 30 ca: 36", và
 *   cách "sửa" rẻ nhất là đừng thêm ca. Một cửa chặn phạt việc mở rộng phạm vi
 *   đo là cửa chặn đang làm ngược việc của nó — cùng bệnh check-copilot-golden-eval
 *   đã chữa cho chính corpus (xem SAN_SO_CA ở đó). Ở đây số ca mong đợi LUÔN suy
 *   từ `cases.length` của chính file JSON, không ghi cứng ở đâu cả.
 *
 * LUẬT THA (giữ nguyên ngữ nghĩa của khối YAML cũ):
 *   verdict "blocked" chỉ được chấp nhận khi lý do DUY NHẤT là `sla.reason`
 *   đúng chuỗi "latency SLA is pending owner approval" (sinh từ
 *   evaluateLatencySla() trong run-copilot-golden-eval.mjs khi
 *   latencySlaMs.status === "pending-owner-approval"). fail/partial/blocked
 *   counts phải bằng 0, và aggregate.total phải bằng đúng số ca trong file
 *   eval. Thiếu báo cáo hoặc không parse được → fail-closed (exit 2), không im
 *   lặng coi như đạt.
 *
 * DÙNG
 *   node scripts/check-golden-eval-report.mjs <bao-cao.json> [--eval <file>]
 *
 * Không cần mạng, không cần credential.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Chuỗi tha duy nhất được chấp nhận cho verdict "blocked". */
export const LY_DO_THA_SLA = 'latency SLA is pending owner approval';

/**
 * Đánh giá thuần một báo cáo golden eval theo số ca mong đợi.
 *
 * @param {unknown} baoCao báo cáo đã parse (JSON.parse của run-copilot-golden-eval.mjs --out)
 * @param {number} soCaMongDoi cases.length của tooling/copilot-golden-eval.json
 * @returns {{ loi: string[], pass: number|undefined, total: number|undefined, reason: string|undefined }}
 */
export function danhGiaBaoCao(baoCao, soCaMongDoi) {
  const loi = [];
  const total = baoCao?.aggregate?.total;
  const counts = baoCao?.aggregate?.counts ?? {};
  const reason = baoCao?.sla?.reason;

  if (total !== soCaMongDoi) {
    loi.push(`khong du ${soCaMongDoi} ca: ${total}`);
  }
  for (const k of ['fail', 'partial', 'blocked']) {
    if (counts[k] > 0) loi.push(`${k}=${counts[k]}`);
  }
  if (baoCao?.verdict !== 'pass' && reason !== LY_DO_THA_SLA) {
    loi.push(`verdict=${baoCao?.verdict} (${reason})`);
  }

  return { loi, pass: counts.pass, total, reason };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--eval') {
      out.eval = argv[++i];
    } else if (!token.startsWith('--')) {
      out._.push(token);
    }
  }
  return out;
}

function docJsonHoacNull(duong, nhan) {
  try {
    return { du_lieu: JSON.parse(readFileSync(duong, 'utf8')) };
  } catch (loi) {
    return { loi: `khong doc/parse duoc ${nhan} (${duong}): ${loi.message}` };
  }
}

function main() {
  const args = parseArgs(process.argv);
  const duongBaoCao = args._[0];
  if (!duongBaoCao) {
    console.error('Copilot golden eval: thieu tham so <bao-cao.json>.');
    process.exitCode = 2;
    return;
  }
  const duongEval = args.eval || join(repoRoot, 'tooling', 'copilot-golden-eval.json');

  const eval_ = docJsonHoacNull(duongEval, 'file eval');
  if (eval_.loi) {
    console.error(`Copilot golden eval: ${eval_.loi}`);
    process.exitCode = 2;
    return;
  }
  const soCaMongDoi = Array.isArray(eval_.du_lieu?.cases) ? eval_.du_lieu.cases.length : 0;

  const baoCao = docJsonHoacNull(duongBaoCao, 'bao cao');
  if (baoCao.loi) {
    console.error(`Copilot golden eval: ${baoCao.loi}`);
    process.exitCode = 2;
    return;
  }

  const { loi, pass, total, reason } = danhGiaBaoCao(baoCao.du_lieu, soCaMongDoi);
  if (loi.length) {
    console.error(`Copilot golden eval (lane mock) DO: ${loi.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Copilot golden eval (lane mock): ${pass}/${total} pass; SLA: ${reason}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
