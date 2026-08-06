#!/usr/bin/env node
// Kiểm các kiểm soát nằm NGOÀI repo: Vercel production branch, branch protection
// GitHub, và scope env var.
//
// Vì sao cần script thay vì ảnh chụp màn hình: một control có thể bị TẮT VỀ SAU.
// Ảnh chụp chứng minh "lúc đó đã bật", không chứng minh "bây giờ vẫn bật" — mà
// điều thứ hai mới là thứ giữ cho production an toàn. Script này chạy lại được
// bất cứ lúc nào và ghi bằng chứng dạng máy đọc.
//
//   node scripts/check-external-controls.mjs              # kiểm, in trạng thái
//   node scripts/check-external-controls.mjs --write      # ghi docs/generated/external-controls.json
//
// Credential: GH_TOKEN/GITHUB_TOKEN (hoặc `gh auth login`), VERCEL_TOKEN.
// THIẾU credential KHÔNG phải là pass — kết quả sẽ là "unverified", và
// unverified được đối xử như chưa an toàn (§0.4 của plan kiến trúc).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(repoRoot, 'docs', 'generated', 'external-controls.json');

const REPO = 'zxGreenxz/whiteboard-ihomecrm';

/**
 * Nhánh mà Vercel ĐƯỢC PHÉP deploy production.
 *
 * Ở tier GitHub Free repo private không dùng được branch protection, nên việc
 * tách nhánh phát hành khỏi `main` là lớp chặn cứng duy nhất còn lại: push vào
 * `main` chỉ ra preview, muốn ra sản phẩm phải promote riêng. Nếu ai đó gạt
 * production branch về `main` trong dashboard Vercel thì lớp chặn đó biến mất
 * lặng lẽ — và đó chính là biến thể gate này từng bỏ lọt.
 */
const NHANH_PHAT_HANH = 'production';

export const UNVERIFIED = 'unverified';

function ghToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

async function ghApi(path) {
  const token = ghToken();
  if (!token) {
    // Thử gh CLI nếu người dùng đã `gh auth login`.
    try {
      const out = execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return { ok: true, data: JSON.parse(out) };
    } catch {
      return { ok: false, reason: 'no-credential' };
    }
  }
  const res = await fetch(`https://api.github.com/${path.replace(/^\//, '')}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return { ok: false, reason: 'not-found' };
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  return { ok: true, data: await res.json() };
}

export function interpretProtection(result) {
  if (!result.ok && result.reason === 'no-credential') {
    return { status: UNVERIFIED, note: 'Không có GH_TOKEN/GITHUB_TOKEN và `gh` chưa đăng nhập.' };
  }
  if (!result.ok && result.reason === 'not-found') {
    // 404 ở endpoint protection nghĩa là KHÔNG có protection — hoặc repo private
    // trên gói Free (nơi tính năng này không khả dụng). Cả hai đều là "không có".
    return {
      status: 'absent',
      note: 'Nhánh không có branch protection. Repo private trên GitHub Free không dùng được tính năng này — lớp chặn phải nằm ở Vercel (xem kiểm soát vercel-production-branch).',
    };
  }
  if (!result.ok) return { status: UNVERIFIED, note: `Gọi API thất bại: ${result.reason}` };

  const p = result.data;
  const requiredChecks = p.required_status_checks?.contexts ?? [];
  const requiredApprovals = p.required_pull_request_reviews?.required_approving_review_count ?? 0;
  const enforceAdmins = Boolean(p.enforce_admins?.enabled);
  const choPhepForcePush = Boolean(p.allow_force_pushes?.enabled);
  const choPhepXoaNhanh = Boolean(p.allow_deletions?.enabled);

  // HTTP 200 chỉ nói "có một object protection", KHÔNG nói nó chặn được gì.
  // Bản đầu chấm 'present' cho mọi phản hồi 200, dù required_status_checks rỗng,
  // required_approvals = 0, enforce_admins = false, và cho phép cả force-push
  // lẫn xoá nhánh. Ba con số đó ĐƯỢC TÍNH RỒI GHI VÀO JSON nhưng không bao giờ
  // tham gia phán quyết — tức gate BÁO CÁO giá trị chứ không SO giá trị với kỳ
  // vọng. Một protection rỗng ruột bảo vệ đúng bằng không có protection.
  const rong = requiredChecks.length === 0 && requiredApprovals === 0 && !enforceAdmins;
  return {
    status: rong || choPhepForcePush || choPhepXoaNhanh ? 'hollow' : 'present',
    requiredChecks,
    requiredApprovals,
    enforceAdmins,
    choPhepForcePush,
    choPhepXoaNhanh,
    note: rong
      ? 'Có object protection nhưng RỖNG RUỘT: không required check, không cần duyệt, không áp cho admin — bảo vệ đúng bằng không có gì.'
      : choPhepForcePush || choPhepXoaNhanh
        ? 'Protection có nội dung nhưng vẫn cho force-push hoặc xoá nhánh — lịch sử main có thể bị ghi đè.'
        : undefined,
  };
}

async function vercelProductionBranch() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return {
      status: UNVERIFIED,
      note: 'Không có VERCEL_TOKEN. Đây là kiểm soát cứng DUY NHẤT khả thi ở tier GitHub Free, nên chưa xác minh được nghĩa là chưa yên tâm.',
    };
  }
  const res = await fetch('https://api.vercel.com/v9/projects', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { status: UNVERIFIED, note: `Vercel API ${res.status}` };
  const body = await res.json();
  const projects = (body.projects ?? []).map((p) => ({
    name: p.name,
    productionBranch: p.link?.productionBranch ?? null,
  }));

  return danhGiaVercel(projects);
}

/**
 * Phán quyết trên danh sách project Vercel.
 *
 * Tách riêng để test được: bản đầu chôn phán quyết trong hàm gọi mạng nên không
 * cách nào kiểm bằng test, và nó sai suốt mà không ai thấy.
 */
export function danhGiaVercel(projects) {
  // Danh sách RỖNG không phải là "đã kiểm". Token sai team trả 200 kèm 0 project,
  // và bản đầu vẫn chấm 'checked' ✅ — soi đúng con số 0 rồi kết luận yên tâm.
  if (projects.length === 0) {
    return { status: UNVERIFIED, note: 'Vercel trả 0 project — token có thể sai team/scope. Không có project nào để đối chiếu thì không kiểm được gì.', projects };
  }

  // ĐÂY mới là phép kiểm. Bản đầu chấm 'checked' cho mọi phản hồi 200 rồi tự tay
  // in ra "ihomecrm → production branch: main" như thể bình thường — trong khi
  // đó chính là kịch bản control BỊ TẮT: mọi push vào main lại là một lần phát
  // hành, đúng thứ script tự gọi là "kiểm soát cứng DUY NHẤT khả thi ở tier
  // GitHub Free". Vì 'checked' được xếp vào ✅ và phần tổng kết chỉ đếm
  // 'unverified'/'absent', thế giới nơi control bị tắt cho ra báo cáo SẠCH HƠN
  // thế giới hiện tại.
  const sai = projects.filter((p) => (p.productionBranch ?? 'main') !== NHANH_PHAT_HANH);
  if (sai.length > 0) {
    return {
      status: 'failed',
      projects,
      note:
        `${sai.length} project deploy production từ nhánh KHÔNG PHẢI "${NHANH_PHAT_HANH}": ` +
        `${sai.map((p) => `${p.name}→${p.productionBranch ?? 'main (mặc định)'}`).join(', ')}. ` +
        'Mọi push vào nhánh đó là một lần phát hành thẳng ra sản phẩm.',
    };
  }
  return { status: 'checked', projects };
}

function localRepoState() {
  const read = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  return {
    head: read('git', ['rev-parse', 'HEAD']),
    branch: read('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    // HỎI REMOTE, không đọc ref local. `rev-parse --verify origin/production`
    // chỉ xem clone này có ref đó không — một ref cũ chưa `fetch --prune` vẫn
    // cho ✅ "nhánh tồn tại" dù remote đã xoá nhánh. Đúng cái lỗi "ảnh chụp
    // chứng minh lúc đó đã bật, không chứng minh bây giờ vẫn bật" mà chính
    // header script này chê.
    hasProductionBranch:
      (read('git', ['ls-remote', '--heads', 'origin', NHANH_PHAT_HANH]) || '').trim() !== '',
  };
}

async function main(argv) {
  const args = new Set(argv.slice(2));

  const protection = interpretProtection(await ghApi(`repos/${REPO}/branches/main/protection`));
  const vercel = await vercelProductionBranch();
  const local = localRepoState();

  const report = {
    $comment:
      'SINH BỞI scripts/check-external-controls.mjs. "unverified" KHÔNG phải pass — control có thể bị tắt về sau, nên bằng chứng phải chạy lại được, không phải ảnh chụp một lần.',
    checkedAt: new Date().toISOString(),
    repo: REPO,
    controls: {
      githubBranchProtection: protection,
      vercelProductionBranch: vercel,
      productionBranchExists: {
        status: local.hasProductionBranch ? 'present' : 'absent',
        note: local.hasProductionBranch
          ? 'Nhánh origin/production tồn tại.'
          : 'CHƯA có nhánh origin/production — nghĩa là Vercel vẫn đang deploy từ main, và mọi push vào main là một lần phát hành.',
      },
    },
    localHead: local,
  };

  console.log(`Kiểm soát ngoài repo — ${REPO}`);
  for (const [name, c] of Object.entries(report.controls)) {
    const mark = c.status === 'present' || c.status === 'checked' ? '✅' : c.status === UNVERIFIED ? '❓' : c.status === 'failed' || c.status === 'hollow' ? '❌' : '⚠';
    console.log(`  ${mark} ${name}: ${c.status}`);
    if (c.note) console.log(`       ${c.note}`);
    if (c.projects) {
      for (const p of c.projects) console.log(`       ${p.name} → production branch: ${p.productionBranch ?? '(mặc định: main)'}`);
    }
    if (c.requiredChecks) console.log(`       required checks: ${c.requiredChecks.join(', ') || '(không có)'}`);
  }

  const unverified = Object.entries(report.controls).filter(([, c]) => c.status === UNVERIFIED);
  const absent = Object.entries(report.controls).filter(([, c]) => c.status === 'absent');
  // 'failed'/'hollow' = control GỌI ĐƯỢC và câu trả lời cho thấy nó ĐANG TẮT.
  // Bản đầu chỉ đếm 'unverified' và 'absent', nên đây là diện nguy hiểm nhất mà
  // không diện nào đếm: thế giới có control bị tắt cho ra báo cáo TOÀN ✅ và
  // dòng cảnh báo biến mất — sạch hơn cả thế giới hiện tại.
  const tat = Object.entries(report.controls).filter(
    ([, c]) => c.status === 'failed' || c.status === 'hollow',
  );

  if (args.has('--write')) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n✅ Đã ghi ${OUT.replace(repoRoot, '.')}`);
  }

  // Control ĐANG TẮT thì exit 1, khác hẳn "chưa xác minh được".
  //
  // Ghi chú ở dưới giải thích vì sao thiếu token KHÔNG nên làm đỏ — đúng, vì
  // biến nó thành gate đỏ khi thiếu token sẽ khiến người ta tắt script đi. Nhưng
  // lý lẽ đó chỉ áp cho 'unverified'. Khi API TRẢ LỜI và câu trả lời nói control
  // đã tắt thì im lặng là tệ nhất trong ba lựa chọn.
  if (tat.length > 0) {
    console.error(`\n❌ ${tat.length} kiểm soát ĐANG TẮT (gọi được API, câu trả lời cho thấy đã tắt):`);
    for (const [ten, c] of tat) console.error(`  - ${ten}: ${c.status} — ${c.note ?? ''}`);
    console.error('  Bật lại trước khi phát hành. Đây không phải "chưa xác minh" — đây là đã xác minh và KHÔNG ĐẠT.');
    return 1;
  }

  if (unverified.length > 0 || absent.length > 0) {
    console.log(
      `\n⚠ ${unverified.length} chưa xác minh, ${absent.length} chưa bật. ` +
      'Không được coi phần release governance là hoàn tất khi còn dòng nào không phải "present".',
    );
    // Cố ý KHÔNG exit 1: script này báo cáo trạng thái thế giới bên ngoài, không
    // phải gate chặn merge. Biến nó thành gate đỏ khi thiếu token sẽ khiến người
    // ta tắt nó đi, và khi ấy mất luôn khả năng nhìn thấy.
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    });
}
