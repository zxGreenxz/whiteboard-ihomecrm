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
    // `id` cần cho việc đọc env/deployment ở bước sau. Không phải secret — nó là
    // định danh công khai của project, không cấp quyền gì nếu không có token.
    id: p.id,
    // Cần repo để khoanh phạm vi: một tài khoản Vercel phục vụ nhiều repo, và
    // repo này chỉ chịu trách nhiệm cho project deploy từ chính nó.
    repo: p.link?.org && p.link?.repo ? `${p.link.org}/${p.link.repo}` : null,
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
/**
 * Đọc env var và deployment production của project ihomecrm.
 *
 * CHỈ LẤY TÊN VÀ TARGET, KHÔNG BAO GIỜ LẤY GIÁ TRỊ. Vercel có endpoint trả giá trị
 * (`?decrypt=true`); cố ý không gọi. File bằng chứng này được commit — một lần lỡ
 * tay là secret nằm vĩnh viễn trong lịch sử git, và rotate xong vẫn còn đó.
 */
async function vercelChiTiet(token, projects) {
  const app = projects.find((p) => p.name === "ihomecrm");
  if (!app?.id) return { status: UNVERIFIED, note: 'Không thấy project "ihomecrm" để đọc env/deployment.' };
  const H = { Authorization: `Bearer ${token}` };

  const ev = await fetch(`https://api.vercel.com/v9/projects/${app.id}/env`, { headers: H });
  const envs = ev.ok
    ? (((await ev.json()).envs ?? []).map((e) => ({ key: e.key, target: (e.target ?? []).join("+"), type: e.type })))
    : null;

  const dp = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${app.id}&target=production&limit=1`,
    { headers: H },
  );
  const d = dp.ok ? ((await dp.json()).deployments ?? [])[0] : null;
  const sha = d?.meta?.githubCommitSha ?? null;
  const ref = d?.meta?.githubCommitRef ?? null;
  const state = d?.state ?? d?.readyState ?? null;

  // PHÉP KIỂM THẬT: mã đang chạy production phải nằm trên main.
  //
  // Nếu không, production đang chạy thứ CHƯA từng qua CI của main — đúng kịch bản
  // mà Contract §3 gọi là "phát hành mã chưa từng qua CI". Không kiểm được (SHA
  // chưa fetch về) KHÔNG phải là đạt.
  let treanMain = null;
  let ghiChuSha = "";
  if (sha) {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd: repoRoot, stdio: "ignore" });
        treanMain = true;
      } catch {
        treanMain = false;
      }
    } catch {
      ghiChuSha = " SHA chưa có trong clone này (chạy `git fetch --all`) — KHÔNG kiểm được nó có trên main hay không.";
    }
  }

  const status = treanMain === false ? "failed" : treanMain === true ? "checked" : UNVERIFIED;
  return {
    status,
    envVarNames: envs,
    productionDeployment: sha ? { sha, ref, state, ancestorOfMain: treanMain } : null,
    note:
      (envs ? `${envs.length} env var (CHỈ tên + target, không lấy giá trị). ` : "Không đọc được env var. ") +
      (sha
        ? `Production đang chạy ${sha.slice(0, 12)} từ nhánh "${ref}", state ${state}. ` +
          (treanMain === true
            ? "SHA đó NẰM TRÊN origin/main — đúng hợp đồng."
            : treanMain === false
              ? "SHA đó KHÔNG nằm trên origin/main: production đang chạy mã chưa từng qua CI của main (Contract §3)."
              : "")
        : "Không đọc được deployment production. ") +
      ghiChuSha,
  };
}

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
  // CHỈ phán trên project deploy TỪ REPO NÀY.
  //
  // Bản đầu phán trên MỌI project của tài khoản Vercel, và đo thật 08/08/2026 cho
  // ra 'failed' vì `ihome-market` (repo zxGreenxz/ihome-market) và `n2store`
  // (repo github-html-starter) deploy từ `main`. Hai project đó KHÔNG thuộc hợp
  // đồng của repo này — repo này không quyết định được cấu hình của chúng, và
  // không sửa được bằng bất kỳ commit nào ở đây.
  //
  // Một gate đỏ vì thứ nằm ngoài tầm với sẽ bị bỏ qua, rồi lần nó đỏ vì lý do
  // THẬT cũng không ai nhìn. Nên: project của repo này ⇒ phán; project khác ⇒ ghi
  // nhận để người đọc thấy toàn cảnh, không tính vào kết luận.
  const cuaRepoNay = projects.filter((p) => p.repo === REPO);
  const ngoaiPhamVi = projects.filter((p) => p.repo !== REPO);

  if (cuaRepoNay.length === 0) {
    return {
      status: UNVERIFIED,
      projects,
      note: `Không project Vercel nào liên kết với ${REPO}. Token có thể sai team/scope — không có gì để đối chiếu thì không kiểm được.`,
    };
  }

  const sai = cuaRepoNay.filter((p) => (p.productionBranch ?? 'main') !== NHANH_PHAT_HANH);
  const ghiChuNgoai = ngoaiPhamVi.length
    ? ` NGOÀI PHẠM VI (repo khác, không tính vào kết luận): ${ngoaiPhamVi.map((p) => `${p.name}[${p.repo}]→${p.productionBranch ?? 'main'}`).join(', ')}.`
    : '';

  if (sai.length > 0) {
    return {
      status: 'failed',
      projects,
      note:
        `${sai.length}/${cuaRepoNay.length} project của ${REPO} deploy production từ nhánh KHÔNG PHẢI "${NHANH_PHAT_HANH}": ` +
        `${sai.map((p) => `${p.name}→${p.productionBranch ?? 'main (mặc định)'}`).join(', ')}. ` +
        'Mọi push vào nhánh đó là một lần phát hành thẳng ra sản phẩm.' +
        ghiChuNgoai,
    };
  }
  return {
    status: 'checked',
    projects,
    note: `${cuaRepoNay.length} project của ${REPO} đều deploy production từ "${NHANH_PHAT_HANH}".` + ghiChuNgoai,
  };
}

/**
 * Ba trạng thái của nhánh phát hành, từ kết quả hỏi remote.
 *
 * Tách ra thành hàm thuần để test được ĐÚNG chỗ đã hỏng: `null` (hỏi không được)
 * phải ra `unverified`, KHÔNG được gộp vào `absent`. Gộp là biến một trục trặc
 * mạng thoáng qua thành lời khẳng định rằng kiểm soát an toàn phát hành không tồn
 * tại — và người đọc thấy một dòng sai như thế thì thôi tin cả bảng.
 */
export function trangThaiNhanhPhatHanh(coNhanh) {
  if (coNhanh === null || coNhanh === undefined) {
    return {
      status: UNVERIFIED,
      note: 'KHÔNG hỏi được remote (`git ls-remote` lỗi — mạng hoặc quyền). Chưa kiểm được KHÁC với không tồn tại; đừng đọc dòng này thành "nhánh đã bị xoá".',
    };
  }
  return coNhanh
    ? { status: 'present', note: 'Nhánh origin/production tồn tại.' }
    : {
        status: 'absent',
        note: 'CHƯA có nhánh origin/production — nghĩa là Vercel vẫn đang deploy từ main, và mọi push vào main là một lần phát hành.',
      };
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
    //
    // BA TRẠNG THÁI, KHÔNG PHẢI HAI. `read()` trả `null` khi lệnh HỎNG — mất
    // mạng, remote từ chối, git không chạy được. Bản đầu viết
    // `(read(...) || '').trim() !== ''`, tức gộp "hỏi không được" vào cùng ô với
    // "hỏi rồi, không có nhánh nào" và báo `absent`.
    //
    // Đã xảy ra thật 12/08/2026: lượt chạy đầu báo `absent`, lượt ngay sau báo
    // `present`, nhánh vẫn nằm nguyên trên remote. Một trục trặc mạng thoáng qua
    // trở thành lời khẳng định chắc nịch rằng kiểm soát an toàn phát hành không
    // tồn tại — đúng cái chống-chỉ-định mà đầu file này cảnh báo, và tệ hơn cả
    // im lặng: nó làm người đọc mất tin vào mọi dòng còn lại.
    //
    // `null` = chưa kiểm được. Phần báo cáo xếp nó thành `unverified`.
    hasProductionBranch: (() => {
      const ra = read('git', ['ls-remote', '--heads', 'origin', NHANH_PHAT_HANH]);
      if (ra === null) return null;
      return ra.trim() !== '';
    })(),
  };
}

/**
 * Bỏ những trường đổi theo LƯỢT CHẠY hoặc theo LẦN PHÁT HÀNH, giữ lại phần mô tả
 * CẤU HÌNH KIỂM SOÁT.
 *
 * `checkedAt` đổi mỗi lượt; SHA/state của deployment đổi mỗi lần deploy. Tính cả
 * hai vào phép so thì job định kỳ đỏ thường trực — và một job đỏ thường trực là
 * job người ta ngừng đọc, lúc đó control có bị tắt thật cũng không ai thấy.
 *
 * Thứ CÒN LẠI mới là điều đáng canh: nhánh production của từng project, tên/target
 * env var, trạng thái branch protection. Không commit nào làm chúng đổi, nên chúng
 * đổi nghĩa là có người bấm vào dashboard.
 */
export function locPhanOnDinh(report) {
  const c = JSON.parse(JSON.stringify(report ?? {}));
  delete c.checkedAt;
  const dep = c.controls?.vercelEnvAndDeployment?.productionDeployment;
  if (dep) {
    delete dep.sha;
    delete dep.state;
    delete dep.ancestorOfMain;
  }
  // `note` là văn xuôi sinh kèm số liệu deployment nên nó cũng trôi; phần kết luận
  // đã nằm ở `status`, vốn được giữ lại.
  if (c.controls) for (const k of Object.keys(c.controls)) delete c.controls[k].note;
  // `localHead` là NGỮ CẢNH phép đo (commit mà runner đang checkout), không phải
  // control ngoài repo — nó đổi theo TỪNG commit trên main, giữ lại thì
  // --so-ban-commit đỏ lại ngay ở push kế tiếp dù không ai bấm gì (đã dính:
  // snapshot ghim head 7a9f6e50 cũ, góp mặt trong 56 dòng lệch 01/09). Sự tồn
  // tại của nhánh production đã có control `productionBranchExists` riêng lo.
  delete c.localHead;
  return c;
}

/** So bản vừa đo với bản đã commit. Trả danh sách khoá lệch (rỗng = không đổi). */
export function lechSoVoiCommit(vuaDo, daCommit) {
  const a = JSON.stringify(locPhanOnDinh(vuaDo), null, 1);
  const b = JSON.stringify(locPhanOnDinh(daCommit), null, 1);
  if (a === b) return [];
  const da = a.split('\n');
  const db = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(da.length, db.length); i++) {
    if (da[i] !== db[i]) out.push(`dòng ${i + 1}: đã commit ${JSON.stringify(db[i] ?? '')} → vừa đo ${JSON.stringify(da[i] ?? '')}`);
  }
  return out;
}

async function main(argv) {
  const args = new Set(argv.slice(2));

  const protection = interpretProtection(await ghApi(`repos/${REPO}/branches/main/protection`));
  const vercel = await vercelProductionBranch();
  const chiTiet = process.env.VERCEL_TOKEN
    ? await vercelChiTiet(process.env.VERCEL_TOKEN, vercel.projects ?? [])
    : { status: UNVERIFIED, note: "Không có VERCEL_TOKEN — không đọc được env var và deployment production." };
  const local = localRepoState();

  const report = {
    $comment:
      'SINH BỞI scripts/check-external-controls.mjs. "unverified" KHÔNG phải pass — control có thể bị tắt về sau, nên bằng chứng phải chạy lại được, không phải ảnh chụp một lần.',
    checkedAt: new Date().toISOString(),
    repo: REPO,
    controls: {
      githubBranchProtection: protection,
      vercelProductionBranch: vercel,
      vercelEnvAndDeployment: chiTiet,
      productionBranchExists: trangThaiNhanhPhatHanh(local.hasProductionBranch),
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

  // So với bản đã commit. Chỉ có nghĩa ở lượt chạy ĐỊNH KỲ: không commit nào làm
  // một cài đặt trên dashboard đổi, nên bản đã commit là mốc duy nhất để biết ai
  // đó vừa bấm gì.
  if (args.has('--so-ban-commit')) {
    let daCommit;
    try {
      daCommit = JSON.parse(readFileSync(OUT, 'utf8'));
    } catch (error) {
      console.error(`\n❌ KHÔNG SO ĐƯỢC: không đọc được bản đã commit (${error.message}).`);
      return 3;
    }
    const lech = lechSoVoiCommit(report, daCommit);
    if (lech.length > 0) {
      console.error(`\n❌ Kiểm soát ngoài repo đã ĐỔI so với bản đã commit (${lech.length} chỗ):\n`);
      for (const l of lech.slice(0, 20)) console.error(`  - ${l}`);
      if (lech.length > 20) console.error(`  … còn ${lech.length - 20}`);
      console.error('\n  Không commit nào làm những cài đặt này đổi — nghĩa là có người bấm vào dashboard.');
      console.error('  Xem kỹ từng dòng, rồi chạy `--write` và commit nếu đó là thay đổi có chủ đích.');
      return 1;
    }
    console.log('\n✅ Cấu hình kiểm soát không đổi so với bản đã commit.');
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
