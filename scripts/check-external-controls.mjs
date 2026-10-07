#!/usr/bin/env node
// Kiểm các kiểm soát nằm NGOÀI repo: visibility + secret scanning/push protection
// của repo GitHub, ruleset + classic protection của `main` và `production`, Vercel
// production branch, và scope env var.
//
// Vì sao cần script thay vì ảnh chụp màn hình: một control có thể bị TẮT VỀ SAU.
// Ảnh chụp chứng minh "lúc đó đã bật", không chứng minh "bây giờ vẫn bật" — mà
// điều thứ hai mới là thứ giữ cho production an toàn. Script này chạy lại được
// bất cứ lúc nào và ghi bằng chứng dạng máy đọc.
//
//   node scripts/check-external-controls.mjs              # kiểm, in trạng thái
//   node scripts/check-external-controls.mjs --write      # ghi docs/generated/external-controls.json
//   --so-ban-commit --write --output <path>               # so bản chuẩn, ghi artifact riêng
//
// Credential: GH_TOKEN/GITHUB_TOKEN (hoặc `gh auth login`), VERCEL_TOKEN.
// THIẾU credential KHÔNG phải là pass — kết quả sẽ là "unverified", và
// unverified được đối xử như chưa an toàn (§0.4 của plan kiến trúc).
// Repo public (từ 07/10/2026): không có token thì vẫn đọc ẩn danh được visibility
// và ruleset; secret scanning/push protection và bypass_actors chỉ hiện với quyền
// admin, nên GITHUB_TOKEN của Actions chỉ cho "unverified" ở hai chỗ đó.

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
 * Tách nhánh phát hành khỏi `main` là lớp chặn phát hành: push vào `main` chỉ ra
 * preview, muốn ra sản phẩm phải promote riêng. Ruleset GitHub chặn xoá và ghi đè
 * lịch sử, nhưng KHÔNG chặn một lần fast-forward vào `production` — nên nếu ai đó
 * gạt production branch về `main` trong dashboard Vercel thì lớp chặn phát hành
 * biến mất lặng lẽ, và đó chính là biến thể gate này từng bỏ lọt.
 */
const NHANH_PHAT_HANH = 'production';

/**
 * Nhánh phải được chặn xoá + chặn force-push (ruleset hoặc classic protection).
 * Mỗi nhánh là MỘT control riêng: gộp lại thì `production` hỏng vẫn có thể bị
 * `main` còn tốt che mất trong một dòng ✅.
 */
export const NHANH_CAN_BAO_VE = ['main', NHANH_PHAT_HANH];
const TEN_CONTROL_NHANH = { main: 'githubBranchMain', [NHANH_PHAT_HANH]: 'githubBranchProduction' };

/** Known-gap giữ phần "chưa có required status check" — note dẫn về đó. */
const GAP_REQUIRED_CHECKS = 'required-checks-khong-cuong-che-duoc';

export const UNVERIFIED = 'unverified';

function ghToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

/**
 * Lý do thất bại từ mã HTTP. 404 ẨN DANH KHÔNG phải "không có": GitHub trả 404 cho
 * mọi thứ người lạ không được thấy (repo private, endpoint cần quyền). Đọc 404 ẩn
 * danh thành `not-found` là biến "không nhìn được" thành "đã tắt".
 */
export function lyDoTuHttp(status, anDanh) {
  if (status === 404) return anDanh ? 'an-danh-khong-thay' : 'not-found';
  return `http-${status}`;
}

async function ghFetch(path, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/${path.replace(/^\//, '')}`, { headers });
  if (!res.ok) return { ok: false, reason: lyDoTuHttp(res.status, !token) };
  return { ok: true, data: await res.json() };
}

async function ghApi(path) {
  const token = ghToken();
  if (!token) {
    // Thử gh CLI nếu người dùng đã `gh auth login`.
    try {
      const out = execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return { ok: true, data: JSON.parse(out) };
    } catch {
      // Repo public: visibility, ruleset và metadata nhánh đọc được không cần
      // token. Phần cần quyền admin vẫn ra unverified ở bước phán quyết.
      return ghFetch(path, null);
    }
  }
  return ghFetch(path, token);
}

/** Classic branch protection của một nhánh (ruleset đọc riêng ở readBranchControl). */
export async function readBranchProtection(request = ghApi, nhanh = 'main') {
  const detail = await request(`repos/${REPO}/branches/${nhanh}/protection`);
  if (!detail.ok && (detail.reason === 'http-403' || detail.reason === 'http-401')) {
    // GITHUB_TOKEN has contents:read but cannot request Administration:read;
    // anonymous callers get 401. The branch endpoint needs only metadata and can
    // prove ABSENCE of classic protection: protected:false, or protection.enabled
    // false (protected:true alone may come from a ruleset, not classic rules).
    // protected:true cannot prove effective checks; details remain unverified.
    const branch = await request(`repos/${REPO}/branches/${nhanh}`);
    if (branch.ok && branch.data?.name === nhanh && branch.data.protected === false) {
      return {
        status: 'absent',
        note: `GitHub branch metadata xác nhận ${nhanh} protected=false. Token không đọc được chi tiết protection (${detail.reason}); không cần quyền quản trị để xác minh nhánh chưa được bảo vệ.`,
      };
    }
    if (branch.ok && branch.data?.name === nhanh && branch.data.protection?.enabled === false) {
      return {
        status: 'absent',
        note: `Metadata nhánh ${nhanh}: classic protection enabled=false (protected=true nếu có là do ruleset). Token không đọc được chi tiết protection (${detail.reason}).`,
      };
    }
  }
  return interpretProtection(detail);
}

export function interpretProtection(result) {
  if (!result.ok && result.reason === 'no-credential') {
    return { status: UNVERIFIED, note: 'Không có GH_TOKEN/GITHUB_TOKEN và `gh` chưa đăng nhập.' };
  }
  if (!result.ok && result.reason === 'not-found') {
    // 404 có token ở endpoint protection nghĩa là nhánh KHÔNG có classic branch
    // protection. Lớp chặn xoá/ghi đè lịch sử có thể nằm ở ruleset — phần đó
    // readBranchControl đọc và phán riêng.
    return {
      status: 'absent',
      note: 'Nhánh không có classic branch protection (endpoint 404). Chặn xoá/force-push phải đến từ ruleset — xem trường rules.',
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

/**
 * Visibility + secret scanning/push protection từ `GET repos/{repo}`.
 *
 * Repo PUBLIC mà secret scanning hoặc push protection TẮT ⇒ `failed`: mọi commit,
 * log Actions và artifact đều ai cũng đọc, một secret lỡ tay là lộ ngay, và push
 * protection là lớp duy nhất chặn TRƯỚC khi nó lên. Khối `security_and_analysis`
 * chỉ trả cho người có quyền admin; thiếu khối đó là CHƯA XÁC MINH, không phải tắt.
 */
export function danhGiaRepo(result) {
  if (!result.ok) {
    const note = `Không đọc được repo (${result.reason}). Chưa xác minh ≠ đang bật.`;
    return {
      visibility: { status: UNVERIFIED, visibility: null, note },
      secretScanning: { status: UNVERIFIED, visibility: null, secretScanning: null, pushProtection: null, note },
    };
  }
  const d = result.data ?? {};
  const visibility =
    typeof d.visibility === 'string' ? d.visibility : d.private === true ? 'private' : d.private === false ? 'public' : null;
  if (!visibility) {
    const note = 'Phản hồi repo không có visibility/private — không phán được.';
    return {
      visibility: { status: UNVERIFIED, visibility: null, note },
      secretScanning: { status: UNVERIFIED, visibility: null, secretScanning: null, pushProtection: null, note },
    };
  }
  const congKhai = visibility === 'public';
  const visibilityControl = {
    status: 'checked',
    visibility,
    note: congKhai
      ? 'Repo PUBLIC: mã, lịch sử commit, log Actions và artifact ai cũng đọc được. Không đưa secret, số tiền production hay dữ liệu cá nhân vào đó. Ruleset dùng được cho repo public ở gói Free.'
      : `Repo ${visibility}.`,
  };

  const saa = d.security_and_analysis;
  if (!saa || typeof saa !== 'object') {
    return {
      visibility: visibilityControl,
      secretScanning: {
        status: UNVERIFIED,
        visibility,
        secretScanning: null,
        pushProtection: null,
        note: 'Phản hồi không có security_and_analysis — GitHub chỉ trả khối này cho người có quyền admin (GITHUB_TOKEN của Actions không có). Chưa xác minh ≠ đang bật.',
      },
    };
  }
  const doc = (k) => {
    const s = saa[k]?.status;
    return s === 'enabled' || s === 'disabled' ? s : null;
  };
  const secretScanning = doc('secret_scanning');
  const pushProtection = doc('secret_scanning_push_protection');
  const base = { visibility, secretScanning, pushProtection };
  const tat = [
    secretScanning === 'disabled' && 'secret scanning',
    pushProtection === 'disabled' && 'push protection',
  ].filter(Boolean);

  if (congKhai && tat.length > 0) {
    return {
      visibility: visibilityControl,
      secretScanning: {
        status: 'failed',
        ...base,
        note: `Repo PUBLIC nhưng ${tat.join(' + ')} đang TẮT — secret lỡ commit sẽ lên công khai mà không ai chặn.`,
      },
    };
  }
  if (secretScanning === 'enabled' && pushProtection === 'enabled') {
    return {
      visibility: visibilityControl,
      secretScanning: { status: 'present', ...base, note: 'Secret scanning và push protection đều bật.' },
    };
  }
  if (secretScanning === null || pushProtection === null) {
    return {
      visibility: visibilityControl,
      secretScanning: {
        status: UNVERIFIED,
        ...base,
        note: 'security_and_analysis thiếu hoặc có giá trị lạ cho secret scanning/push protection — không phán được.',
      },
    };
  }
  return {
    visibility: visibilityControl,
    secretScanning: {
      status: 'absent',
      ...base,
      note: `Repo ${visibility}: ${tat.join(' + ')} tắt. Chưa công khai nên không tính là control hỏng; đổi sang public thì phải bật trước.`,
    },
  };
}

async function readRepoSecurity(request = ghApi) {
  return danhGiaRepo(await request(`repos/${REPO}`));
}

const docTapChuoi = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x))].sort();

/**
 * Phán quyết cho MỘT nhánh từ ruleset (`GET rules/branches/{nhanh}`, chỉ trả rule
 * đang active) và classic protection.
 *
 * `present` = chặn được CẢ xoá nhánh lẫn force-push, và không actor nào bypass
 * được ngoài đường PR. Required status check KHÔNG nằm trong điều kiện: chưa bật
 * là khoảng trống có hồ sơ riêng (known-gap), và một control đỏ vĩnh viễn vì thứ
 * đã biết sẽ bị ngừng đọc. Nó vẫn được ghi vào `requiredChecks` để so drift.
 *
 * Không đọc được ruleset thì classic `absent` KHÔNG chứng minh được nhánh trống
 * trơn — ruleset là đường bảo vệ chính của repo này.
 */
export function danhGiaNhanh(nhanh, rulesResult, classic, bypassTheoRuleset = {}) {
  const docDuocRules = rulesResult?.ok === true && Array.isArray(rulesResult.data);
  const rules = docDuocRules ? rulesResult.data : [];
  const loai = docTapChuoi(rules.map((r) => r?.type));
  const rulesetIds = [...new Set(rules.map((r) => r?.ruleset_id).filter(Number.isInteger))].sort((a, b) => a - b);
  const requiredChecks = docTapChuoi([
    ...rules
      .filter((r) => r?.type === 'required_status_checks')
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .map((c) => c?.context),
    ...(classic?.requiredChecks ?? []),
  ]);
  const classicStatus = classic?.status ?? UNVERIFIED;
  const classicDuManh = classicStatus === 'present';
  const chanXoa = loai.includes('deletion') || classicDuManh;
  const chanGhiDe = loai.includes('non_fast_forward') || classicDuManh;

  const bypassDocDuoc = rulesetIds.length > 0 && rulesetIds.every((id) => Array.isArray(bypassTheoRuleset[id]));
  const bypassActors = bypassDocDuoc
    ? rulesetIds.flatMap((id) =>
        bypassTheoRuleset[id].map((a) => ({ type: a?.actor_type ?? null, id: a?.actor_id ?? null, mode: a?.bypass_mode ?? null })),
      )
    : undefined;
  // `pull_request` chỉ cho bypass qua merge PR — merge không force-push, không xoá
  // nhánh. Mọi chế độ khác (always, exempt, …) là một actor đi vòng qua rule.
  const vuotRao = (bypassActors ?? []).filter((a) => a.mode !== 'pull_request');

  const base = { branch: nhanh, rules: loai, rulesetIds, requiredChecks, classicProtection: classicStatus };
  if (bypassActors) base.bypassActors = bypassActors;
  const ghiChuBypass = rulesetIds.length > 0 && !bypassDocDuoc
    ? ' bypass_actors không đọc được với token này (cần quyền admin) — chưa xác minh ai được đi vòng.'
    : '';
  const ghiChuChecks = requiredChecks.length > 0
    ? ` Required checks: ${requiredChecks.join(', ')}.`
    : ` Chưa có required status check — khoảng trống ở known-gap ${GAP_REQUIRED_CHECKS}.`;

  if (!docDuocRules) {
    if (classicDuManh) {
      return { status: 'present', ...base, note: `Không đọc được ruleset (${rulesResult?.reason}); classic protection của ${nhanh} đủ chặn xoá + force-push.${ghiChuChecks}` };
    }
    return {
      status: UNVERIFIED,
      ...base,
      note: `Không đọc được ruleset của ${nhanh} (${rulesResult?.reason}); classic protection: ${classicStatus}. Chưa xác minh ≠ không có.`,
    };
  }
  if (loai.length === 0 && classicStatus === 'absent') {
    return {
      status: 'absent',
      ...base,
      note: `${nhanh} không có ruleset active và không có classic protection — xoá nhánh hay force-push đều không bị chặn.`,
    };
  }
  if (loai.length === 0 && classicStatus === UNVERIFIED) {
    return { status: UNVERIFIED, ...base, note: `${nhanh} không có ruleset active; classic protection chưa xác minh được.` };
  }
  if (chanXoa && chanGhiDe && vuotRao.length === 0) {
    return { status: 'present', ...base, note: `${nhanh}: chặn xoá nhánh + force-push.${ghiChuChecks}${ghiChuBypass}` };
  }
  const thieu = [
    !chanXoa && 'không chặn xoá nhánh',
    !chanGhiDe && 'không chặn force-push',
    vuotRao.length > 0 && `${vuotRao.length} bypass actor đi vòng được rule (${vuotRao.map((a) => `${a.type}:${a.mode}`).join(', ')})`,
  ].filter(Boolean);
  return {
    status: 'hollow',
    ...base,
    note: `${nhanh} có bảo vệ nhưng RỖNG RUỘT: ${thieu.join('; ')} — lịch sử nhánh vẫn ghi đè/xoá được.${ghiChuBypass}`,
  };
}

/** Đọc ruleset + classic protection + bypass actors của một nhánh rồi phán. */
export async function readBranchControl(nhanh, request = ghApi) {
  const rules = await request(`repos/${REPO}/rules/branches/${nhanh}`);
  const classic = await readBranchProtection(request, nhanh);
  const bypass = {};
  if (rules.ok && Array.isArray(rules.data)) {
    const ids = [...new Set(rules.data.map((r) => r?.ruleset_id).filter(Number.isInteger))];
    for (const id of ids) {
      const rs = await request(`repos/${REPO}/rulesets/${id}`);
      bypass[id] = rs.ok && Array.isArray(rs.data?.bypass_actors) ? rs.data.bypass_actors : null;
    }
  }
  return danhGiaNhanh(nhanh, rules, classic, bypass);
}

async function vercelProductionBranch() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return {
      status: UNVERIFIED,
      note: 'Không có VERCEL_TOKEN. Production branch trên Vercel là lớp chặn phát hành (push vào main chỉ ra preview), nên chưa xác minh được nghĩa là chưa yên tâm.',
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
  // hành, đúng lớp chặn phát hành mà script này canh. Vì 'checked' được xếp
  // vào ✅ và phần tổng kết chỉ đếm
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
  // `bypassActors` chỉ hiện với token có quyền admin; GITHUB_TOKEN của lượt định
  // kỳ không thấy. Giữ lại thì cùng một cấu hình cho hai bản khác nhau tuỳ ai đo.
  // Hệ quả của nó (actor đi vòng ⇒ `hollow`) đã nằm ở `status`, vốn được so.
  if (c.controls) for (const k of Object.keys(c.controls)) delete c.controls[k].bypassActors;
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
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex === -1 ? OUT : argv[outputIndex + 1];
  if (!output || output.startsWith('--') || (outputIndex !== -1 && !args.has('--write'))) {
    console.error('❌ --output cần đường dẫn và --write.');
    return 3;
  }

  const repoSecurity = await readRepoSecurity();
  const nhanh = {};
  for (const ten of NHANH_CAN_BAO_VE) nhanh[TEN_CONTROL_NHANH[ten]] = await readBranchControl(ten);
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
      githubRepoVisibility: repoSecurity.visibility,
      githubSecretScanning: repoSecurity.secretScanning,
      ...nhanh,
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
    if (c.rules) console.log(`       rules: ${c.rules.join(', ') || '(không có)'}`);
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

  // So với bản đã commit. Chỉ có nghĩa ở lượt chạy ĐỊNH KỲ: không commit nào làm
  // một cài đặt trên dashboard đổi, nên bản đã commit là mốc duy nhất để biết ai
  // đó vừa bấm gì. So TRƯỚC khi --write thay bản gốc; vẫn lưu bằng chứng khi đỏ.
  let comparisonExit = 0;
  if (args.has('--so-ban-commit')) {
    let daCommit;
    try {
      daCommit = JSON.parse(readFileSync(OUT, 'utf8'));
    } catch (error) {
      console.error(`\n❌ KHÔNG SO ĐƯỢC: không đọc được bản đã commit (${error.message}).`);
      comparisonExit = 3;
    }
    if (comparisonExit === 0) {
      const lech = lechSoVoiCommit(report, daCommit);
      if (lech.length > 0) {
        console.error(`\n❌ Kiểm soát ngoài repo đã ĐỔI so với bản đã commit (${lech.length} chỗ):\n`);
        for (const l of lech.slice(0, 20)) console.error(`  - ${l}`);
        if (lech.length > 20) console.error(`  … còn ${lech.length - 20}`);
        console.error('\n  Không commit nào làm những cài đặt này đổi — nghĩa là có người bấm vào dashboard.');
        console.error('  Xem kỹ từng dòng, rồi chạy `--write` và commit nếu đó là thay đổi có chủ đích.');
        comparisonExit = 1;
      } else {
        console.log('\n✅ Cấu hình kiểm soát không đổi so với bản đã commit.');
      }
    }
  }

  if (args.has('--write')) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n✅ Đã ghi ${output.replace(repoRoot, '.')}`);
  }
  if (comparisonExit !== 0) return comparisonExit;

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
