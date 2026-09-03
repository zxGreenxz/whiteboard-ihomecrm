#!/usr/bin/env node
// Task G4 — bằng chứng SỐNG (live) rằng các hàng rào của Kế hoạch thực thi
// Copilot (Mức 2, migration 20260903100253_copilot_execution_plan_v1.sql)
// thật sự chặn trên PRODUCTION, không phải chỉ chặn trên giấy.
//
// Bảy ca, chạy tay bằng JWT thật (super admin + chunha, org DEMO
// dddd0000-0000-4000-8000-000000000001) qua GoTrue + PostgREST — KHÔNG dùng
// service key, KHÔNG trình duyệt. Mọi RPC/tham số ĐÚNG khuôn đã đo thật ở
// `.e2e-fleet/specs/copilot-plan-batch-consent.spec.ts` (task G3-E2E, xem
// `docBang`/`goiRpc`/`moVan`/`dongVan`/`datCo`/`khoiPhucCo` ở đó) — script này
// là bản CLI độc lập của cùng khuôn, không sửa/không đụng file .e2e-fleet/**.
//
//   1. wrong_org_preview  — copilot_plan_create_v1 với p_organization_id của
//      một công ty chunha KHÔNG phải thành viên ⇒ phải bị chặn.
//   2. wrong_org_execute  — kế hoạch tạo thật trên DEMO, rồi execute_step với
//      p_organization_id SAI ⇒ phải bị chặn như "không tìm thấy".
//   3. flag_revoked_between_preview_execute — tạo + DUYỆT kế hoạch lúc cờ
//      action:income_expense.create_draft đang enabled, tắt cờ, rồi execute
//      ⇒ phải BLOCKED (copilot_action_disabled), kế hoạch FAILED. Cờ được lật
//      bằng ĐÚNG cờ + ĐÚNG khuôn hoàn nguyên mà G3-E2E đã đo an toàn (KHÔNG
//      đụng copilot.execution_plan — cờ đó canary+hạn, lật rồi bật lại sẽ NỚI
//      nó vĩnh viễn, xem task-G3-E2E-report.md §4).
//   4. nonce_replay — duyệt xong, bấm duyệt LẦN NỮA với đúng nonce cũ ⇒ phải
//      bị chặn confirmation_already_used.
//   5. plan_digest_mismatch — duyệt với plan_digest SAI ⇒ phải bị chặn
//      plan_digest_mismatch, kế hoạch vẫn DRAFT.
//   6. concurrent_executes — hai lệnh execute_step CÙNG version bắn đồng thời
//      ⇒ đúng MỘT ok:true, cái thua khớp plan_busy|plan_version_stale.
//   7. plan_cancel — huỷ một kế hoạch DRAFT ⇒ CANCELLED, bước SKIPPED, không
//      hồ sơ mới nào sinh ra.
//
// Van chính sách (`copilot_action_policy.allowed_roles`) mở RIÊNG cho từng ca
// cần ghi, đóng lại ngay trong `finally` của chính ca đó — khuôn đã trả giá
// thật ở G3-E2E (mở một lần cho cả suite từng để lộ cửa sổ "cả lượt chạy" khi
// tiến trình bị giết giữa chừng).
//
// DÙNG
//   node scripts/copilot-live-negative-proofs.mjs \
//     --sysadmin-email <email> --sysadmin-password <mk> \
//     --chunha-email <email> --chunha-password <mk> \
//     --out docs/generated/copilot-negative-proofs/<sha>.json
//
// Credential mặc định đọc từ env COPILOT_NEG_SYSADMIN_EMAIL/PASSWORD và
// COPILOT_NEG_CHUNHA_EMAIL/PASSWORD — KHÔNG hardcode, KHÔNG in ra log.
//
// Fail-closed: nếu MỘT proof cho thấy hàng rào KHÔNG chặn (server trả 200 khi
// đáng lẽ phải từ chối), script KHÔNG tự vá gì — nó ghi `pass:false` kèm bằng
// chứng, và verdict tổng là 'blocked'. Đó là phát hiện cần báo cáo chủ dự án,
// không phải lỗi để "sửa cho xanh".

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ORG_DEMO = 'dddd0000-0000-4000-8000-000000000001';
// Công ty THẬT khác DEMO, dùng làm tham số p_organization_id SAI trong hai ca
// wrong-org — KHÔNG bao giờ ghi/đọc dữ liệu của org này, chỉ dùng làm id để
// chứng minh hàng rào từ chối trước khi chạm dữ liệu.
export const ORG_KHAC = 'aaaa0000-0000-4000-8000-000000000001';

export const CO_KILL_SWITCH = 'income_expense.create_draft';
export const HANH_DONG_TAO = 'income_expense.create_draft';
export const TOA_NHA = 'DEMO Toà A';
export const HANG_MUC = 'Xử lý Bồn Cầu';

const EVIDENCE_LINK = 'scripts/copilot-live-negative-proofs.mjs';
const LY_DO_MO_CHINH_SACH = {
  p_reason: 'G4 negative-proofs — do duong ghi cua ke hoach thuc thi tren org DEMO; script tu tra ve {superadmin}',
  p_evidence_link: EVIDENCE_LINK,
};
const LY_DO_LAT_CO = {
  p_reason: 'G4 negative-proofs — kiem co bi thu hoi GIUA preview va execute (script tu bat lai)',
  p_evidence_link: EVIDENCE_LINK,
  p_rollback_reference: 'set_copilot_feature_flag_v2 disabled->shadow->enabled ngay trong script',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

function readEnvFile() {
  const env = readFileSync(join(repoRoot, '.env'), 'utf8');
  return {
    url: env.match(/VITE_SUPABASE_URL="([^"]+)"/)?.[1],
    apikey: env.match(/VITE_SUPABASE_PUBLISHABLE_KEY="([^"]+)"/)?.[1],
  };
}

export function khoaYeuCau(prefix) {
  return `g4neg-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function buocTaoNhap(tenPhieu) {
  return {
    hanh_dong: HANH_DONG_TAO,
    du_lieu: { loai: 'CHI', so_tien: 1000, ten_phieu: tenPhieu, toa_nha: TOA_NHA, hang_muc: HANG_MUC },
  };
}

class Client {
  constructor(url, apikey) {
    this.url = url;
    this.apikey = apikey;
  }

  async login(email, password) {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.access_token) {
      throw new Error(`Đăng nhập ${email} thất bại (HTTP ${res.status}).`);
    }
    return body.access_token;
  }

  async rpc(jwt, name, args) {
    const res = await fetch(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: this.apikey,
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'Content-Profile': 'public',
        'Accept-Profile': 'public',
      },
      body: JSON.stringify(args ?? {}),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }

  async table(jwt, path) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: { apikey: this.apikey, Authorization: `Bearer ${jwt}`, 'Accept-Profile': 'public' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Đọc ${path} trả HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}

function loi(kq) {
  const m = kq?.body?.message;
  return typeof m === 'string' ? m : JSON.stringify(kq?.body);
}
function maLoi(kq) {
  const c = kq?.body?.code;
  return typeof c === 'string' ? c : undefined;
}

// ── Van chính sách (allowed_roles) — mở/đóng theo TỪNG ca cần nó ───────────

async function docChinhSach(client, jwtSys) {
  const kq = await client.rpc(jwtSys, 'get_copilot_action_policy_v1', {});
  if (kq.status !== 200) throw new Error(`Đọc chính sách hành động thất bại: ${loi(kq)}`);
  return { revision: kq.body.revision, maxDirectRisk: kq.body.max_direct_risk, allowedRoles: kq.body.allowed_roles };
}

async function datVai(client, jwtSys, vai) {
  let kq = { status: 0, body: null };
  for (let i = 0; i < 2; i += 1) {
    const hienTai = await docChinhSach(client, jwtSys);
    if (hienTai.allowedRoles.length === vai.length && vai.every((v) => hienTai.allowedRoles.includes(v))) {
      return { status: 200, body: { allowed_roles: hienTai.allowedRoles } };
    }
    kq = await client.rpc(jwtSys, 'set_copilot_action_policy_v1', {
      p_expected_revision: hienTai.revision,
      p_max_direct_risk: null,
      p_allowed_roles: vai,
      p_standing_grants_enabled: null,
      ...LY_DO_MO_CHINH_SACH,
    });
    if (kq.status === 200 || !loi(kq).includes('stale_revision')) return kq;
  }
  return kq;
}

/** Mở van cho ĐÚNG một proof; từ chối mở nếu nền không phải {superadmin}+L4. */
async function moVan(client, jwtSys) {
  const nen = await docChinhSach(client, jwtSys);
  if (nen.maxDirectRisk !== 'L4') {
    return { dat: false, lyDo: `trần rủi ro đang "${nen.maxDirectRisk}" chứ không phải "L4" — không hoàn nguyên mù được` };
  }
  if (!(nen.allowedRoles.length === 1 && nen.allowedRoles[0] === 'superadmin')) {
    return { dat: false, lyDo: `allowed_roles đang là [${nen.allowedRoles.join(', ')}] — không đụng vào, có thể là dấu vết một lượt chạy trước bị giết giữa chừng` };
  }
  const mo = await datVai(client, jwtSys, ['superadmin', 'owner']);
  if (mo.status !== 200) return { dat: false, lyDo: `không nới được allowed_roles: ${loi(mo)}` };
  return { dat: true, lyDo: '' };
}

async function dongVan(client, jwtSys) {
  const ve = await datVai(client, jwtSys, ['superadmin']);
  if (ve.status !== 200) {
    throw new Error(`KHÔNG TRẢ LẠI ĐƯỢC allowed_roles=[superadmin]: ${loi(ve)}. Vào /settings/ai-copilot → Chính sách và đặt lại NGAY.`);
  }
}

// ── Cờ rollout hành động — lật/khôi phục (khuôn G3-E2E) ────────────────────

async function trangThaiCo(client, jwtSys) {
  const kq = await client.rpc(jwtSys, 'get_my_copilot_availability_v1', { p_organization_id: ORG_DEMO });
  if (kq.status !== 200) throw new Error(`Đọc availability DEMO thất bại: ${loi(kq)}`);
  return { revision: kq.body.revision, state: kq.body.states[`action:${CO_KILL_SWITCH}`] };
}

async function datCo(client, jwtSys, state) {
  let kq = { status: 0, body: null };
  for (let i = 0; i < 2; i += 1) {
    const hienTai = await trangThaiCo(client, jwtSys);
    kq = await client.rpc(jwtSys, 'set_copilot_feature_flag_v2', {
      p_scope: 'action',
      p_contract_id: CO_KILL_SWITCH,
      p_state: state,
      p_expected_revision: hienTai.revision,
      p_canary_org: null,
      p_expires_at: null,
      ...LY_DO_LAT_CO,
    });
    if (kq.status === 200) return kq;
    if (!loi(kq).includes('stale_revision')) return kq;
  }
  return kq;
}

async function khoiPhucCo(client, jwtSys) {
  for (let i = 0; i < 6; i += 1) {
    const cur = await trangThaiCo(client, jwtSys);
    if (cur.state === 'enabled') return;
    const ke = cur.state === 'disabled' ? 'shadow' : 'enabled';
    const kq = await datCo(client, jwtSys, ke);
    if (kq.status !== 200 && !loi(kq).includes('stale_revision')) {
      throw new Error(`Không bật lại được cờ ${CO_KILL_SWITCH} (${ke}): ${loi(kq)}`);
    }
  }
  const cuoi = await trangThaiCo(client, jwtSys);
  if (cuoi.state !== 'enabled') {
    throw new Error(`CỜ ${CO_KILL_SWITCH} VẪN Ở "${cuoi.state}" SAU KHI THỬ KHÔI PHỤC. Vào /settings/ai-copilot → Rollout và chuyển về enabled NGAY.`);
  }
}

// ── Kế hoạch — helper mỏng quanh 5 RPC ──────────────────────────────────────

async function lapKeHoach(client, jwt, org, khoa, buoc) {
  return client.rpc(jwt, 'copilot_plan_create_v1', { p_organization_id: org, p_client_request_id: khoa, p_steps: buoc });
}
async function duyetKeHoach(client, jwt, planId, nonce, digest, version) {
  return client.rpc(jwt, 'copilot_plan_approve_v1', { p_plan_id: planId, p_consent_nonce: nonce, p_plan_digest: digest, p_expected_plan_version: version });
}
async function chayBuoc(client, jwt, planId, stepNo, version, org) {
  return client.rpc(jwt, 'copilot_plan_execute_step_v1', { p_plan_id: planId, p_step_no: stepNo, p_expected_plan_version: version, p_organization_id: org });
}
async function docKeHoach(client, jwt, planId) {
  const kq = await client.rpc(jwt, 'copilot_plan_get_v1', { p_plan_id: planId });
  if (kq.status !== 200) throw new Error(`Đọc kế hoạch ${planId} thất bại: ${loi(kq)}`);
  return kq.body;
}
async function huyKeHoach(client, jwt, planId, version, reason) {
  return client.rpc(jwt, 'copilot_plan_cancel_v1', { p_plan_id: planId, p_expected_plan_version: version, p_reason: reason });
}
/** Dọn một kế hoạch còn mở (DRAFT/APPROVED) — không ném nếu không dọn được. */
async function donKeHoach(client, jwt, planId) {
  if (!planId) return;
  try {
    const ke = await docKeHoach(client, jwt, planId);
    if (ke.plan_status === 'DRAFT' || ke.plan_status === 'APPROVED') {
      await huyKeHoach(client, jwt, planId, ke.plan_version, 'G4 negative-proofs don dep cuoi ca');
    }
  } catch { /* đã dọn hoặc không đọc được — không phải lỗi của ca */ }
}

// ── Bảy proof ───────────────────────────────────────────────────────────────

async function proofWrongOrgPreview(client, jwtSys, jwtChunha) {
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'wrong_org_preview', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  try {
    const kq = await lapKeHoach(client, jwtChunha, ORG_KHAC, khoaYeuCau('worg-prev'), [buocTaoNhap('G4 khong duoc tao — wrong org preview')]);
    const chan = kq.status !== 200;
    return {
      name: 'wrong_org_preview',
      pass: chan,
      detail: chan
        ? `chunha bị chặn tạo kế hoạch trên org khác DEMO đúng như kỳ vọng (HTTP ${kq.status}, mã ${maLoi(kq) ?? '—'}, "${loi(kq)}")`
        : `SAI: chunha TẠO ĐƯỢC kế hoạch trên org ${ORG_KHAC} — org boundary KHÔNG chặn preview`,
      evidence: { httpStatus: kq.status, code: maLoi(kq), message: loi(kq) },
    };
  } finally {
    await dongVan(client, jwtSys);
  }
}

async function proofWrongOrgExecute(client, jwtSys, jwtChunha) {
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'wrong_org_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  let planId = null;
  try {
    const tao = await lapKeHoach(client, jwtChunha, ORG_DEMO, khoaYeuCau('worg-exec'), [buocTaoNhap('G4 negative-proof wrong-org execute')]);
    if (tao.status !== 200) {
      return { name: 'wrong_org_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tạo được kế hoạch DEMO để thử: ${loi(tao)}` };
    }
    planId = tao.body.plan_id;
    const kq = await chayBuoc(client, jwtChunha, planId, 1, tao.body.plan_version, ORG_KHAC);
    const chan = kq.status !== 200;
    return {
      name: 'wrong_org_execute',
      pass: chan,
      detail: chan
        ? `execute_step với p_organization_id sai bị chặn đúng như kỳ vọng (HTTP ${kq.status}, mã ${maLoi(kq) ?? '—'}, "${loi(kq)}")`
        : `SAI: execute_step CHẠY ĐƯỢC với p_organization_id sai — org boundary KHÔNG chặn execute`,
      evidence: { planId, httpStatus: kq.status, code: maLoi(kq), message: loi(kq) },
    };
  } finally {
    await donKeHoach(client, jwtChunha, planId);
    await dongVan(client, jwtSys);
  }
}

async function proofFlagRevokedBetween(client, jwtSys, jwtChunha) {
  const tienDeCo = await trangThaiCo(client, jwtSys).catch((e) => ({ state: `error: ${e.message}` }));
  if (tienDeCo.state !== 'enabled') {
    return { name: 'flag_revoked_between_preview_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — cờ action:${CO_KILL_SWITCH} đang "${tienDeCo.state}" chứ không phải "enabled", spec không biết trả về đâu` };
  }
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'flag_revoked_between_preview_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  let planId = null;
  let coDaTat = false;
  try {
    const tao = await lapKeHoach(client, jwtChunha, ORG_DEMO, khoaYeuCau('flag-revoke'), [buocTaoNhap('G4 negative-proof flag revoked')]);
    if (tao.status !== 200) return { name: 'flag_revoked_between_preview_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tạo được kế hoạch: ${loi(tao)}` };
    planId = tao.body.plan_id;
    const duyet = await duyetKeHoach(client, jwtChunha, planId, tao.body.consent_nonce, tao.body.plan_digest, tao.body.plan_version);
    if (duyet.status !== 200) return { name: 'flag_revoked_between_preview_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không duyệt được kế hoạch: ${loi(duyet)}` };

    const tat = await datCo(client, jwtSys, 'disabled');
    if (tat.status !== 200) return { name: 'flag_revoked_between_preview_execute', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tắt được cờ: ${loi(tat)}` };
    coDaTat = true;

    const chay = await chayBuoc(client, jwtChunha, planId, 1, duyet.body.plan_version, ORG_DEMO);
    const ke = await docKeHoach(client, jwtChunha, planId);
    // execute_step ghi trạng thái ở giao dịch NGOÀI rồi RETURN 200 với ok:false
    // (không NÉM) — đúng khuôn "ghi-rồi-return" mà G3-E2E ca6 đã đo. Chặn đúng
    // nghĩa là ok:false + error_code copilot_action_disabled + bước BLOCKED,
    // KHÔNG phải HTTP khác 200 — bản đầu của proof này soi nhầm trục và tự báo
    // "hàng rào không chặn" cho một hàng rào ĐANG chặn đúng cách.
    const bodyOk = chay.status === 200 && chay.body?.ok === true;
    const chanDung =
      chay.status === 200 &&
      chay.body?.ok === false &&
      chay.body?.error_code === 'copilot_action_disabled' &&
      chay.body?.step?.status === 'BLOCKED' &&
      ke.plan_status === 'FAILED';
    const chan = !bodyOk && chanDung;
    return {
      name: 'flag_revoked_between_preview_execute',
      pass: chan,
      detail: chan
        ? `cờ bị thu hồi giữa duyệt và chạy ⇒ execute_step trả ok:false/copilot_action_disabled, bước BLOCKED, kế hoạch FAILED đúng như kỳ vọng`
        : bodyOk
          ? `SAI: execute_step vẫn THỰC THI (ok:true) dù cờ đã tắt`
          : `SAI: execute_step bị chặn nhưng KHÔNG đúng chữ ký mong đợi (ok:false/copilot_action_disabled/BLOCKED/FAILED) — thân trả về: ${JSON.stringify(chay.body)}`,
      evidence: { planId, httpStatus: chay.status, body: chay.body, planStatus: ke.plan_status },
    };
  } finally {
    if (coDaTat) await khoiPhucCo(client, jwtSys);
    await donKeHoach(client, jwtChunha, planId);
    await dongVan(client, jwtSys);
  }
}

async function proofNonceReplay(client, jwtSys, jwtChunha) {
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'nonce_replay', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  let planId = null;
  try {
    const tao = await lapKeHoach(client, jwtChunha, ORG_DEMO, khoaYeuCau('nonce-replay'), [buocTaoNhap('G4 negative-proof nonce replay')]);
    if (tao.status !== 200) return { name: 'nonce_replay', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tạo được kế hoạch: ${loi(tao)}` };
    planId = tao.body.plan_id;
    const lan1 = await duyetKeHoach(client, jwtChunha, planId, tao.body.consent_nonce, tao.body.plan_digest, tao.body.plan_version);
    if (lan1.status !== 200) return { name: 'nonce_replay', pass: false, detail: `KHÔNG ĐO ĐƯỢC — lần duyệt đầu đã thất bại: ${loi(lan1)}` };
    const lan2 = await duyetKeHoach(client, jwtChunha, planId, tao.body.consent_nonce, tao.body.plan_digest, lan1.body.plan_version);
    const chan = lan2.status !== 200 && maLoi(lan2) === '42501' && /confirmation_already_used/.test(loi(lan2));
    return {
      name: 'nonce_replay',
      pass: chan,
      detail: chan
        ? `dùng lại đúng nonce cũ bị chặn "confirmation_already_used" đúng như kỳ vọng`
        : `SAI: dùng lại nonce KHÔNG bị chặn đúng cách (HTTP ${lan2.status}, mã ${maLoi(lan2) ?? '—'}, "${loi(lan2)}")`,
      evidence: { planId, httpStatus: lan2.status, code: maLoi(lan2), message: loi(lan2) },
    };
  } finally {
    await donKeHoach(client, jwtChunha, planId);
    await dongVan(client, jwtSys);
  }
}

async function proofPlanDigestMismatch(client, jwtSys, jwtChunha) {
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'plan_digest_mismatch', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  let planId = null;
  try {
    const tao = await lapKeHoach(client, jwtChunha, ORG_DEMO, khoaYeuCau('digest-mismatch'), [buocTaoNhap('G4 negative-proof digest mismatch')]);
    if (tao.status !== 200) return { name: 'plan_digest_mismatch', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tạo được kế hoạch: ${loi(tao)}` };
    planId = tao.body.plan_id;
    const digestSai = tao.body.plan_digest.slice(0, -2) + (tao.body.plan_digest.endsWith('00') ? 'ff' : '00');
    const duyet = await duyetKeHoach(client, jwtChunha, planId, tao.body.consent_nonce, digestSai, tao.body.plan_version);
    const ke = await docKeHoach(client, jwtChunha, planId);
    const chan = duyet.status !== 200 && /plan_digest_mismatch/.test(loi(duyet)) && ke.plan_status === 'DRAFT';
    return {
      name: 'plan_digest_mismatch',
      pass: chan,
      detail: chan
        ? `plan_digest sai bị chặn "plan_digest_mismatch", kế hoạch vẫn DRAFT đúng như kỳ vọng`
        : `SAI: digest sai KHÔNG bị chặn đúng cách (HTTP ${duyet.status}, "${loi(duyet)}") hoặc kế hoạch đã đổi trạng thái (${ke.plan_status})`,
      evidence: { planId, httpStatus: duyet.status, code: maLoi(duyet), message: loi(duyet), planStatus: ke.plan_status },
    };
  } finally {
    await donKeHoach(client, jwtChunha, planId);
    await dongVan(client, jwtSys);
  }
}

async function proofConcurrentExecutes(client, jwtSys, jwtChunha) {
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'concurrent_executes', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  let planId = null;
  try {
    const tao = await lapKeHoach(client, jwtChunha, ORG_DEMO, khoaYeuCau('concurrent'), [buocTaoNhap('G4 negative-proof 2 execute dong thoi')]);
    if (tao.status !== 200) return { name: 'concurrent_executes', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tạo được kế hoạch: ${loi(tao)}` };
    planId = tao.body.plan_id;
    const duyet = await duyetKeHoach(client, jwtChunha, planId, tao.body.consent_nonce, tao.body.plan_digest, tao.body.plan_version);
    if (duyet.status !== 200) return { name: 'concurrent_executes', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không duyệt được kế hoạch: ${loi(duyet)}` };

    const [a, b] = await Promise.all([
      chayBuoc(client, jwtChunha, planId, 1, duyet.body.plan_version, ORG_DEMO),
      chayBuoc(client, jwtChunha, planId, 1, duyet.body.plan_version, ORG_DEMO),
    ]);
    const oks = [a, b].filter((r) => r.status === 200 && r.body?.ok === true);
    const thuas = [a, b].filter((r) => r !== oks[0] && (r.status !== 200 || r.body?.ok !== true));
    const thuaKhopMa = thuas.every((r) => /plan_busy|plan_version_stale/.test(loi(r)) || /plan_busy|plan_version_stale/.test(JSON.stringify(r.body)));
    const chan = oks.length === 1 && thuaKhopMa;
    return {
      name: 'concurrent_executes',
      pass: chan,
      detail: chan
        ? `2 execute đồng thời ⇒ đúng 1 ok:true, lượt thua khớp plan_busy|plan_version_stale đúng như kỳ vọng`
        : `SAI: ${oks.length} lượt ok:true (mong đợi đúng 1) — a=${JSON.stringify(a.body ?? a)} b=${JSON.stringify(b.body ?? b)}`,
      evidence: { planId, a: { status: a.status, body: a.body }, b: { status: b.status, body: b.body } },
    };
  } finally {
    await donKeHoach(client, jwtChunha, planId);
    await dongVan(client, jwtSys);
  }
}

async function proofPlanCancel(client, jwtSys, jwtChunha) {
  const van = await moVan(client, jwtSys);
  if (!van.dat) return { name: 'plan_cancel', pass: false, detail: `KHÔNG ĐO ĐƯỢC — van không mở: ${van.lyDo}` };
  let planId = null;
  try {
    const tao = await lapKeHoach(client, jwtChunha, ORG_DEMO, khoaYeuCau('cancel'), [buocTaoNhap('G4 negative-proof plan cancel')]);
    if (tao.status !== 200) return { name: 'plan_cancel', pass: false, detail: `KHÔNG ĐO ĐƯỢC — không tạo được kế hoạch: ${loi(tao)}` };
    planId = tao.body.plan_id;
    const huy = await huyKeHoach(client, jwtChunha, planId, tao.body.plan_version, 'G4 negative-proofs — plan cancel');
    const ke = await docKeHoach(client, jwtChunha, planId);
    const chan = huy.status === 200 && ke.plan_status === 'CANCELLED' && (ke.steps ?? []).every((s) => s.status === 'SKIPPED' || s.status === 'CANCELLED');
    planId = null; // đã huỷ — donKeHoach() không cần dọn lại
    return {
      name: 'plan_cancel',
      pass: chan,
      detail: chan
        ? `huỷ kế hoạch DRAFT ⇒ CANCELLED, mọi bước SKIPPED/CANCELLED đúng như kỳ vọng`
        : `SAI: huỷ không thành công hoặc trạng thái sau huỷ không đúng (HTTP ${huy.status}, plan_status=${ke?.plan_status})`,
      evidence: { planId: tao.body.plan_id, httpStatus: huy.status, planStatus: ke?.plan_status, steps: ke?.steps },
    };
  } finally {
    await donKeHoach(client, jwtChunha, planId);
    await dongVan(client, jwtSys);
  }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const sysEmail = args['sysadmin-email'] || process.env.COPILOT_NEG_SYSADMIN_EMAIL;
  const sysPass = args['sysadmin-password'] || process.env.COPILOT_NEG_SYSADMIN_PASSWORD;
  const chunhaEmail = args['chunha-email'] || process.env.COPILOT_NEG_CHUNHA_EMAIL;
  const chunhaPass = args['chunha-password'] || process.env.COPILOT_NEG_CHUNHA_PASSWORD;
  const buildSha = args['build-sha'] || process.env.EXPECTED_SOURCE_SHA;
  const out = args.out;

  if (!sysEmail || !sysPass || !chunhaEmail || !chunhaPass) {
    console.error('Thiếu credential (--sysadmin-email/-password, --chunha-email/-password hoặc env tương ứng).');
    process.exitCode = 2;
    return;
  }
  if (!out) {
    console.error('Thiếu --out <file.json>.');
    process.exitCode = 2;
    return;
  }
  if (!/^[0-9a-f]{40}$/i.test(String(buildSha ?? ''))) {
    console.error('Thiếu/sai --build-sha (cần 40 hex — SHA của build đang đo).');
    process.exitCode = 2;
    return;
  }

  const { url, apikey } = readEnvFile();
  if (!url || !apikey) throw new Error('Không đọc được VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY từ .env.');
  const client = new Client(url, apikey);

  console.error('Đăng nhập sysadmin + chunha…');
  const jwtSys = await client.login(sysEmail, sysPass);
  const jwtChunha = await client.login(chunhaEmail, chunhaPass);

  const proofs = [
    proofWrongOrgPreview,
    proofWrongOrgExecute,
    proofFlagRevokedBetween,
    proofNonceReplay,
    proofPlanDigestMismatch,
    proofConcurrentExecutes,
    proofPlanCancel,
  ];

  const cases = [];
  for (const proof of proofs) {
    process.stderr.write(`${proof.name}… `);
    let result;
    try {
      result = await proof(client, jwtSys, jwtChunha);
    } catch (e) {
      result = { name: proof.name, pass: false, detail: `NÉM NGOẠI LỆ: ${e?.stack ?? e}` };
    }
    console.error(result.pass ? 'PASS' : `FAIL — ${result.detail}`);
    cases.push(result);
  }

  const verdict = cases.every((c) => c.pass) ? 'pass' : 'blocked';
  const report = {
    schemaVersion: 1,
    buildSha,
    ranAt: new Date().toISOString(),
    organizationId: ORG_DEMO,
    actors: { sysadmin: sysEmail, chunha: chunhaEmail },
    cases,
    verdict,
  };
  mkdirSync(dirname(join(repoRoot, out)), { recursive: true });
  writeFileSync(join(repoRoot, out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(`\nGhi ${out} — verdict: ${verdict} (${cases.filter((c) => c.pass).length}/${cases.length} pass).`);
  if (verdict !== 'pass') process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`Lỗi: ${e?.stack ?? e}`);
    process.exitCode = 1;
  });
}
