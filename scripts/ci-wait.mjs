#!/usr/bin/env node
// Chờ CI của MỘT commit xong rồi in kết luận — CHỈ ĐỌC.
//
// VÌ SAO CẦN
//   Agent hay "chờ CI" bằng cách dispatch/rerun, mà trên main một run mới có thể
//   huỷ run phiên khác đang chạy. Lệnh này không bao giờ ghi gì lên GitHub: chỉ GET
//   danh sách run của đúng SHA, chờ có giới hạn, rồi in job/bước đỏ.
//
//   npm run ci:wait -- --sha <sha> [--wait-seconds 1200]
//
// Run có thẩm quyền = push/workflow_dispatch trên main (cùng luật với promote);
// run pull_request/schedule chỉ được liệt kê, không quyết định.
// Thoát 0 mọi run có thẩm quyền xanh · 1 có run đỏ · 3 chưa xong/hết giờ/không đọc được.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { goiGitHub, locRunsDanhGia } from './promote-to-production.mjs';
import { resolveCommitSha } from './release-verify.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_WAIT_SECONDS = 3600;

const xanh = (run) => ['success', 'skipped'].includes(run.conclusion);

/** Phân loại toàn bộ run của SHA; run không thẩm quyền chỉ để in. */
export function phanLoaiRuns(workflowRuns) {
  const thamQuyen = locRunsDanhGia(workflowRuns);
  const ids = new Set(thamQuyen.map((run) => run.id));
  return {
    thamQuyen,
    khac: (workflowRuns ?? []).filter((run) => !ids.has(run.id)),
    chuaXong: thamQuyen.filter((run) => run.status !== 'completed'),
    do: thamQuyen.filter((run) => run.status === 'completed' && !xanh(run)),
  };
}

export function dongRun(run, coThamQuyen) {
  const dau = run.status !== 'completed' ? '⏳' : xanh(run) ? '✅' : '❌';
  const ketLuan = run.status === 'completed' ? run.conclusion : run.status;
  return `${coThamQuyen ? dau : '  '} ${run.name} #${run.run_number ?? run.id} (${run.event}, ${run.head_branch}) ${ketLuan}${coThamQuyen ? '' : ' — không tính'} ${run.html_url ?? ''}`.trimEnd();
}

/** Job/bước đỏ của một run, để người đọc khỏi mở trang Actions. */
export function jobDo(jobs) {
  return (jobs ?? []).filter((job) => job.status === 'completed' && !['success', 'skipped'].includes(job.conclusion)).map((job) => {
    const buoc = (job.steps ?? []).filter((step) => ['failure', 'timed_out', 'cancelled'].includes(step.conclusion)).map((step) => step.name);
    return `${job.name} (${job.conclusion})${buoc.length ? ` › ${buoc.join(', ')}` : ''}`;
  });
}

export async function choCi({ repo, sha, token, request = goiGitHub, waitMs = 1_200_000, pollMs = 30_000, now = Date.now, sleep = delay, log = console.log }) {
  const deadline = now() + waitMs;
  try {
    const dangChayMain = [];
    for (const status of ['in_progress', 'queued']) {
      const page = await request(`/repos/${repo}/actions/runs?branch=main&status=${status}&per_page=50`, token);
      dangChayMain.push(...(page.workflow_runs ?? []).filter((run) => run.head_sha !== sha));
    }
    if (dangChayMain.length) {
      log(`⚠ ${dangChayMain.length} run khác đang chạy/chờ trên main (${[...new Set(dangChayMain.map((run) => run.head_sha.slice(0, 8)))].join(', ')}).`);
      log('  Đừng dispatch/rerun để "đẩy nhanh": run mới có thể chen hoặc huỷ run của phiên khác.');
    }
    for (;;) {
      const runs = await request(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, token);
      if (!Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length) throw new Error('Danh sách run không đầy đủ');
      const kq = phanLoaiRuns(runs.workflow_runs);
      const remaining = deadline - now();
      const xong = kq.thamQuyen.length > 0 && kq.chuaXong.length === 0;
      if (xong || remaining <= 0) {
        for (const run of kq.thamQuyen) log(dongRun(run, true));
        for (const run of kq.khac) log(dongRun(run, false));
        for (const run of kq.do) {
          const { jobs } = await request(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
          for (const dong of jobDo(jobs)) log(`     ❌ ${dong}`);
        }
        if (!kq.thamQuyen.length) return { code: 3, message: 'Hết giờ: chưa có run push/workflow_dispatch trên main cho SHA này.' };
        if (kq.do.length) return { code: 1, message: `${kq.do.length}/${kq.thamQuyen.length} run có thẩm quyền đỏ.` };
        if (kq.chuaXong.length) return { code: 3, message: `Hết giờ: ${kq.chuaXong.length} run chưa xong — chưa kết luận, không phải xanh.` };
        return { code: 0, message: `${kq.thamQuyen.length} run có thẩm quyền đều xanh.` };
      }
      log(`  ${kq.thamQuyen.length - kq.chuaXong.length}/${kq.thamQuyen.length} run có thẩm quyền xong; chờ tiếp tối đa ${Math.ceil(remaining / 1000)} giây.`);
      await sleep(Math.min(pollMs, remaining));
    }
  } catch (error) {
    return { code: 3, message: `KHÔNG KIỂM ĐƯỢC: ${error.message}` };
  }
}

async function main(argv) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  let sha;
  let waitSeconds;
  try {
    const i = argv.indexOf('--sha');
    sha = resolveCommitSha(i >= 0 ? argv[i + 1] : undefined);
    const w = argv.indexOf('--wait-seconds');
    waitSeconds = w < 0 ? 1200 : Number(argv[w + 1]);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) throw new Error(`--wait-seconds phải là số nguyên từ 0 đến ${MAX_WAIT_SECONDS}.`);
    if (!token) throw new Error('Thiếu GH_TOKEN/GITHUB_TOKEN — không đọc được CI.');
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 3;
    return;
  }
  const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
  if (!repo) { console.error('❌ Không đọc được remote origin.'); process.exitCode = 3; return; }
  console.log(`Chờ CI của ${sha.slice(0, 12)} (${repo}), tối đa ${waitSeconds} giây, chỉ đọc.`);
  const result = await choCi({ repo, sha, token, waitMs: waitSeconds * 1000 });
  (result.code === 0 ? console.log : console.error)(`${result.code === 0 ? '✅' : '❌'} ${result.message}`);
  process.exitCode = result.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
