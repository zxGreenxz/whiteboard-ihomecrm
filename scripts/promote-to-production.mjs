#!/usr/bin/env node
// Promote `main` → `production`, và CHỈ khi mọi gate thật sự xanh.
//
// VÌ SAO CẦN
//   Vercel theo dõi nhánh `production`, nên push vào đó = phát hành thẳng cho
//   người dùng thật. Cửa chặn hiện có (`check-production-promotion.mjs`) chỉ hỏi
//   "commit này đã có trên main chưa" — nó KHÔNG hỏi "gate của commit đó có xanh
//   không". Một commit đỏ trên main vẫn promote được mà không gì kêu.
//
// CÁI BẪY CHÍNH: `continue-on-error` LÀM JOB BÁO XANH
//   GitHub đặt `conclusion: failure` cho BƯỚC, nhưng JOB vẫn `success`. Nghĩa là
//   mọi công cụ đọc kết luận ở mức job — kể cả trang Checks — sẽ thấy màu xanh
//   trong khi một bước đã fail. Repo này CÓ dùng continue-on-error (đăng ký ở
//   tooling/known-gaps.yaml), nên đây không phải rủi ro lý thuyết.
//
//   Script đọc kết luận ở mức BƯỚC. Một bước fail vẫn là fail, dù ai nuốt nó.
//
//   node scripts/promote-to-production.mjs                 # dry-run (mặc định)
//   node scripts/promote-to-production.mjs --sha <sha>
//   node scripts/promote-to-production.mjs --apply         # thật sự fast-forward
//
// Thoát 0 đủ điều kiện · 1 có gate đỏ (kể cả bị nuốt) · 3 KHÔNG KIỂM ĐƯỢC.
// Exit 3 là mặc định khi thiếu GH_TOKEN — "không hỏi được CI" KHÁC "CI xanh".

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Đánh giá một tập job (đã kèm `steps`) của MỘT commit.
 *
 * Trả ba nhóm, và ba nhóm đó cố ý KHÔNG gộp:
 *   do      bước fail và job cũng fail — ai cũng thấy
 *   nuot    bước fail nhưng job vẫn success — đây là thứ trang Checks giấu đi
 *   dangChay bước chưa xong — chưa kết luận được, không phải "xanh"
 */
/**
 * Chỉ đánh giá run của các nhánh TRƯỚC khi promote — loại run trên `production`.
 *
 * Vì sao phải lọc: API `/actions/runs?head_sha=` trả MỌI run của commit, không
 * phân biệt nhánh. Mà chính cú push `production` lại kích hoạt một lượt CI mới
 * trên nhánh đó — trong lượt ấy có job production-promotion đang chạy ĐÚNG script
 * này. Không lọc thì script chấm điểm cả run chứa chính nó, và run đó không bao
 * giờ "completed" khi nó còn đang chấm ⇒ job này về cấu trúc KHÔNG THỂ xanh trên
 * nhánh production. Đo thật 13/08/2026 (run 31722280140): cùng SHA ca110413 xanh
 * trọn trên main lúc 16:54, nhưng job này đỏ lúc 16:45 vì đếm 51 bước "chưa
 * xong" — toàn bộ thuộc các run tiếng-vọng vừa sinh trên production.
 *
 * Lọc theo nhánh chứ không theo run id: cú push production sinh CẢ các workflow
 * khác (Migration Restore Drill…) trên nhánh đó — loại mỗi run hiện tại là chưa
 * đủ. Phán quyết phải đến từ các run đã chạy trên main trước khi promote; luật
 * "commit phát hành phải qua main" đã có check-production-promotion đứng gác.
 */
export function locRunsDanhGia(workflowRuns) {
  return (workflowRuns ?? []).filter((r) => r.head_branch !== 'production');
}

export function danhGiaJobs(jobs) {
  const doGate = [];
  const nuot = [];
  const dangChay = [];

  for (const job of jobs ?? []) {
    const jobXanh = job.conclusion === 'success';
    for (const s of job.steps ?? []) {
      if (s.status !== 'completed') {
        dangChay.push(`${job.name} › ${s.name}`);
        continue;
      }
      if (s.conclusion === 'failure' || s.conclusion === 'timed_out') {
        (jobXanh ? nuot : doGate).push(`${job.name} › ${s.name}`);
      }
    }
    // Job hỏng mà KHÔNG bước nào fail (huỷ, hết giờ, runner chết) vẫn là không xanh —
    // duyệt riêng vì nếu chỉ đọc bước thì ca đó lọt hoàn toàn.
    //
    // Nhưng chỉ xét khi job ĐÃ XONG. Job đang chạy có `conclusion: null`, và xếp nó
    // vào "đỏ" là sai loại: nó thuộc `dangChay`. Cả hai đều chặn promote, nhưng một
    // báo cáo gộp "đang chạy" vào "đỏ" sẽ khiến người đọc đi tìm lỗi không tồn tại.
    const jobXong = job.status === undefined || job.status === 'completed';
    if (
      jobXong &&
      !jobXanh &&
      job.conclusion !== 'skipped' &&
      !(job.steps ?? []).some((s) => s.conclusion === 'failure')
    ) {
      doGate.push(`${job.name} (job ${job.conclusion ?? 'chưa kết luận'})`);
    }
  }

  return { doGate, nuot, dangChay, datDieuKien: doGate.length === 0 && nuot.length === 0 && dangChay.length === 0 };
}

async function goiGitHub(duong, token) {
  const res = await fetch(`https://api.github.com${duong}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

async function main(argv) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const iS = argv.indexOf('--sha');
  const sha = iS >= 0 ? argv[iS + 1] : git(['rev-parse', 'origin/main']);
  const thatSu = argv.includes('--apply');

  console.log(`Promote → production, commit ${sha.slice(0, 12)} (${thatSu ? 'THẬT SỰ' : 'dry-run'})`);

  if (!token) {
    console.error('\n❌ KHÔNG KIỂM ĐƯỢC: thiếu GH_TOKEN/GITHUB_TOKEN.');
    console.error('   Không hỏi được kết luận CI thì KHÔNG được promote — "không biết" khác "xanh".');
    console.error('   Đặt GH_TOKEN rồi chạy lại.');
    process.exit(3);
  }

  let repo;
  try {
    const url = git(['config', '--get', 'remote.origin.url']);
    repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
  } catch {
    repo = null;
  }
  if (!repo) {
    console.error('❌ KHÔNG KIỂM ĐƯỢC: không đọc được remote origin.');
    process.exit(3);
  }

  let runs;
  try {
    runs = await goiGitHub(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, token);
  } catch (error) {
    console.error(`❌ KHÔNG KIỂM ĐƯỢC: ${error.message}`);
    process.exit(3);
  }

  const runsDanhGia = locRunsDanhGia(runs.workflow_runs);
  if (!runsDanhGia.length) {
    console.error(`❌ KHÔNG KIỂM ĐƯỢC: không có workflow run nào (ngoài nhánh production) cho ${sha.slice(0, 12)}.`);
    console.error('   Có thể CI chưa chạy xong, hoặc commit này chưa từng được push lên main.');
    process.exit(3);
  }

  const jobs = [];
  for (const run of runsDanhGia) {
    try {
      const r = await goiGitHub(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, token);
      jobs.push(...(r.jobs ?? []).map((j) => ({ ...j, name: `${run.name} / ${j.name}` })));
    } catch (error) {
      console.error(`❌ KHÔNG KIỂM ĐƯỢC job của run ${run.id}: ${error.message}`);
      process.exit(3);
    }
  }

  const kq = danhGiaJobs(jobs);
  console.log(`  ${jobs.length} job, ${jobs.reduce((n, j) => n + (j.steps?.length ?? 0), 0)} bước`);

  if (kq.nuot.length > 0) {
    console.error(`\n❌ ${kq.nuot.length} bước FAIL nhưng job vẫn báo xanh (continue-on-error):`);
    for (const b of kq.nuot) console.error(`  - ${b}`);
    console.error('  Trang Checks của GitHub hiển thị những job này là XANH. Chúng không xanh.');
  }
  if (kq.doGate.length > 0) {
    console.error(`\n❌ ${kq.doGate.length} bước/job đỏ:`);
    for (const b of kq.doGate) console.error(`  - ${b}`);
  }
  if (kq.dangChay.length > 0) {
    console.error(`\n❌ ${kq.dangChay.length} bước CHƯA XONG — chưa kết luận được, không phải xanh:`);
    for (const b of kq.dangChay.slice(0, 10)) console.error(`  - ${b}`);
  }

  if (!kq.datDieuKien) {
    console.error('\nKHÔNG promote. Sửa cho xanh thật rồi chạy lại.');
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Mọi bước đều xanh, kể cả những bước bị continue-on-error che.');

  if (!thatSu) {
    console.log('   (dry-run — chạy lại với --apply để fast-forward `production`)');
    return;
  }

  // Fast-forward ONLY. `--ff-only` là cửa chặn cuối: nếu production đã đi trước
  // main thì lệnh này fail thay vì tạo merge commit hay ép ghi đè.
  const r = spawnSync('git', ['push', 'origin', `${sha}:refs/heads/production`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`❌ Push thất bại: ${r.stderr?.trim()}`);
    console.error('   Nếu do non-fast-forward: production đã đi trước main — điều tra trước khi ép.');
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Đã promote ${sha.slice(0, 12)} lên production.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
