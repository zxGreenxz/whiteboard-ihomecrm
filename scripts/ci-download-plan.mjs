#!/usr/bin/env node
// Tải plan của ĐÚNG lượt chạy (GITHUB_RUN_ATTEMPT) cho job CI Gates.
//
// "Re-run failed jobs" không chạy lại preflight (preflight đã xanh), nên lượt N>1
// không có artifact gate-plan-attempt-N. Lấy plan lượt cũ cũng không cứu được:
// plan gắn runId của lượt cũ, còn receipt của các job không chạy lại nằm ở lượt cũ
// nên aggregate lượt mới không ghép đủ. Dừng sớm và nói đúng cách chạy lại.
// Chỉ dùng module có sẵn của Node: job gate-aggregate không cài node_modules.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function loiThieuPlan(attempt) {
  return Number(attempt) > 1
    ? `Lượt chạy ${attempt} không có plan của chính nó: "Re-run failed jobs" không chạy lại preflight, còn receipt của job không chạy lại thuộc lượt trước. Dùng "Re-run all jobs".`
    : 'Không tải được plan của preflight trong lượt này; xem log job preflight.';
}

export function taiPlan({ runId, attempt, download }) {
  if (!/^\d+$/.test(String(runId ?? '')) || !/^\d+$/.test(String(attempt ?? ''))) {
    return { code: 1, message: 'Thiếu GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT hợp lệ.' };
  }
  const status = download(['run', 'download', String(runId), '--name', `gate-plan-attempt-${attempt}`, '--dir', '.gate-evidence']);
  return status === 0 ? { code: 0, message: `Đã tải gate-plan-attempt-${attempt}.` } : { code: 1, message: loiThieuPlan(attempt) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = taiPlan({
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    download: (args) => spawnSync('gh', args, { stdio: 'inherit' }).status,
  });
  console.log(result.code === 0 ? result.message : `::error title=Thiếu plan của lượt chạy::${result.message}`);
  process.exitCode = result.code;
}
