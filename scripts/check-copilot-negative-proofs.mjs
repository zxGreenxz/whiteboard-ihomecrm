#!/usr/bin/env node
/**
 * Gate: kiểm báo cáo live negative-proofs (task G4) của
 * `scripts/copilot-live-negative-proofs.mjs`.
 *
 * KIỂM GÌ
 *   - có đúng một file `docs/generated/copilot-negative-proofs/<40-hex>.json`
 *     còn "tươi" (SHA mới nhất theo `ranAt`, không quá `HAN_NGAY` ngày);
 *   - `verdict === 'pass'` VÀ mọi phần tử `cases[]` có `pass === true`;
 *   - đủ mặt bảy proof bắt buộc (`CAC_PROOF_BAT_BUOC`) — thiếu một proof (vd
 *     ai đó lỡ tay xoá một case khỏi script) không được lặng lẽ qua cửa vì
 *     "còn lại toàn pass".
 *
 * KHÔNG chạy live-proofs thay bạn — script đó cần JWT thật + ghi/đọc production
 * DEMO, không hợp với một gate chạy trong mọi lượt push. Gate này kiểm artifact
 * đã sinh ra. Khi artifact chỉ vướng tuổi, gate hỏi CHÍNH helper production xem
 * `copilot.execution_plan` có đang bị tắt trên DEMO không. Chỉ khi helper trả
 * đúng boolean false mới được hoãn yêu cầu làm tươi; thiếu PAT, API lỗi hoặc dữ
 * liệu mơ hồ đều là KHÔNG KIỂM ĐƯỢC, không phải pass.
 *
 * DÙNG
 *   node scripts/check-copilot-negative-proofs.mjs [--dir <thư mục>] [--han-ngay N]
 *
 * Bình thường không cần mạng. Artifact quá hạn cần SUPABASE_PAT để xác nhận cờ
 * production. Thoát 0 (xanh) · 1 (đỏ) · 2 (tham số sai) · 3 (không kiểm được).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const THU_MUC_MAC_DINH = 'docs/generated/copilot-negative-proofs';
export const HAN_NGAY_MAC_DINH = 14;
export const ORG_DEMO = 'dddd0000-0000-4000-8000-000000000001';
export const CONTRACT_KE_HOACH = 'copilot.execution_plan';

/** Bảy proof bắt buộc — khớp đúng tên `name` mà từng hàm `proof*` ghi trong script live. */
export const CAC_PROOF_BAT_BUOC = Object.freeze([
  'wrong_org_preview',
  'wrong_org_execute',
  'flag_revoked_between_preview_execute',
  'nonce_replay',
  'plan_digest_mismatch',
  'concurrent_executes',
  'plan_cancel',
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--dir') out.dir = argv[++i];
    else if (t === '--han-ngay') out.hanNgay = Number(argv[++i]);
    else if (!t.startsWith('--')) out._.push(t);
  }
  return out;
}

/**
 * Tìm file báo cáo mới nhất (theo `ranAt`) trong thư mục, tên khớp `<40 hex>.json`.
 * Trả `{ path, sha, baoCao } | { loi }`.
 */
export function timBaoCaoMoiNhat(thuMuc, doc = (p) => readFileSync(p, 'utf8'), list = (p) => readdirSync(p)) {
  let files;
  try {
    files = list(thuMuc).filter((f) => /^[0-9a-f]{40}\.json$/i.test(f));
  } catch (e) {
    return { loi: `không đọc được thư mục ${thuMuc}: ${e instanceof Error ? e.message : e}` };
  }
  if (files.length === 0) return { loi: `không có file báo cáo nào trong ${thuMuc} (đặt tên <sha 40 hex>.json)` };

  const ungVien = [];
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(doc(join(thuMuc, f)));
    } catch (e) {
      return { loi: `${f} không parse được JSON: ${e instanceof Error ? e.message : e}` };
    }
    ungVien.push({ path: join(thuMuc, f), sha: f.replace(/\.json$/i, ''), baoCao: parsed });
  }
  ungVien.sort((a, b) => {
    const ta = Date.parse(a.baoCao?.ranAt ?? '');
    const tb = Date.parse(b.baoCao?.ranAt ?? '');
    return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
  });
  return ungVien[0];
}

/**
 * Đánh giá thuần một báo cáo đã parse. Trả `{ loi: string[] }` — rỗng nghĩa
 * là đạt.
 */
export function danhGiaBaoCao(baoCao, hanNgay = HAN_NGAY_MAC_DINH, now = Date.now()) {
  const loi = [];
  if (!baoCao || typeof baoCao !== 'object') return { loi: ['báo cáo không phải object'] };

  if (!/^[0-9a-f]{40}$/i.test(String(baoCao.buildSha ?? ''))) {
    loi.push(`buildSha không hợp lệ: ${JSON.stringify(baoCao.buildSha)}`);
  }
  const ranAt = Date.parse(baoCao.ranAt ?? '');
  if (!Number.isFinite(ranAt)) {
    loi.push(`ranAt không parse được: ${JSON.stringify(baoCao.ranAt)}`);
  } else {
    const tuoiNgay = (now - ranAt) / 86_400_000;
    if (tuoiNgay > hanNgay) {
      loi.push(`báo cáo đã ${tuoiNgay.toFixed(1)} ngày tuổi, vượt hạn ${hanNgay} ngày — chạy lại scripts/copilot-live-negative-proofs.mjs`);
    }
    if (tuoiNgay < 0) {
      loi.push(`ranAt nằm ở TƯƠNG LAI (${baoCao.ranAt}) — đồng hồ máy sinh báo cáo sai, không tin được`);
    }
  }

  const cases = Array.isArray(baoCao.cases) ? baoCao.cases : null;
  if (!cases) {
    loi.push('thiếu mảng cases[]');
  } else {
    const tenCoSan = new Set(cases.map((c) => c?.name));
    const thieu = CAC_PROOF_BAT_BUOC.filter((n) => !tenCoSan.has(n));
    if (thieu.length) loi.push(`thiếu proof bắt buộc: ${thieu.join(', ')}`);

    for (const c of cases) {
      if (c?.pass !== true) {
        loi.push(`ca "${c?.name ?? '(không tên)'}" pass=${JSON.stringify(c?.pass)}: ${c?.detail ?? '(không có detail)'}`);
      }
    }
  }

  if (baoCao.verdict !== 'pass') {
    loi.push(`verdict=${JSON.stringify(baoCao.verdict)} (mong đợi "pass")`);
  }

  return { loi };
}

function laLoiQuaHan(loi) {
  return /^báo cáo đã .*vượt hạn \d+ ngày/u.test(loi);
}

/**
 * Chỉ tuổi của một artifact vốn hợp lệ mới được hoãn khi đường thực thi trên
 * DEMO đang tắt. Một case fail, thiếu case, sai SHA/verdict hay thời gian tương
 * lai vẫn đỏ dù kill switch đang tắt.
 */
export function danhGiaVoiTrangThaiRuntime(
  baoCao,
  demoExecutionAllowed,
  hanNgay = HAN_NGAY_MAC_DINH,
  now = Date.now(),
) {
  const { loi } = danhGiaBaoCao(baoCao, hanNgay, now);
  const chiQuaHan = loi.length > 0 && loi.every(laLoiQuaHan);
  if (chiQuaHan && demoExecutionAllowed === false) {
    return { loi: [], boQuaTuoiViDaTat: true };
  }
  return { loi, boQuaTuoiViDaTat: false };
}

/** Đọc đúng helper được các RPC create/approve/execute dùng trên production. */
export async function docTrangThaiExecutionPlanDemo({ token, projectRef, fetchImpl = fetch }) {
  if (!token || !projectRef) throw new Error('thiếu SUPABASE_PAT hoặc project ref');
  const res = await fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `select app_private.copilot_action_flag_allows_v1('${CONTRACT_KE_HOACH}', '${ORG_DEMO}'::uuid) as demo_enabled`,
    }),
  });
  if (!res.ok) {
    const detail = typeof res.text === 'function' ? await res.text() : '';
    throw new Error(`Management API ${res.status ?? 'không rõ'} ${String(detail).slice(0, 160)}`.trim());
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.demo_enabled !== 'boolean') {
    throw new Error('trạng thái copilot.execution_plan trên DEMO không xác định');
  }
  return rows[0].demo_enabled;
}

function docPat() {
  if (process.env.SUPABASE_PAT?.trim()) return process.env.SUPABASE_PAT.trim();
  try {
    return readFileSync(join(repoRoot, 'CLAUDE.local.md'), 'utf8').match(/\bsbp_[A-Za-z0-9_-]+\b/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function docProjectRef() {
  try {
    return readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8')
      .match(/project_id\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const thuMuc = join(repoRoot, args.dir || THU_MUC_MAC_DINH);
  const hanNgay = Number.isFinite(args.hanNgay) ? args.hanNgay : HAN_NGAY_MAC_DINH;

  const tim = timBaoCaoMoiNhat(thuMuc);
  if (tim.loi) {
    console.error(`Copilot negative-proofs: ${tim.loi}`);
    process.exitCode = 1;
    return;
  }

  const lanDau = danhGiaBaoCao(tim.baoCao, hanNgay);
  let ket = { ...lanDau, boQuaTuoiViDaTat: false };
  if (lanDau.loi.length > 0 && lanDau.loi.every(laLoiQuaHan)) {
    try {
      const demoEnabled = await docTrangThaiExecutionPlanDemo({
        token: docPat(),
        projectRef: docProjectRef(),
      });
      ket = danhGiaVoiTrangThaiRuntime(tim.baoCao, demoEnabled, hanNgay);
    } catch (error) {
      console.error(`Copilot negative-proofs: KHÔNG KIỂM ĐƯỢC trạng thái runtime — ${error.message}`);
      process.exitCode = 3;
      return;
    }
  }
  if (ket.loi.length) {
    console.error(`Copilot negative-proofs (${tim.sha}) ĐỎ:`);
    for (const l of ket.loi) console.error(`  - ${l}`);
    process.exitCode = 1;
    return;
  }

  const soPass = tim.baoCao.cases.filter((c) => c.pass).length;
  if (ket.boQuaTuoiViDaTat) {
    console.log(
      `Copilot negative-proofs: ${tim.sha} — artifact ${soPass}/${tim.baoCao.cases.length} pass đã quá hạn, ` +
      `nhưng helper production xác nhận ${CONTRACT_KE_HOACH} đang tắt trên DEMO; yêu cầu làm tươi sẽ bật lại ngay khi đường thực thi được mở.`,
    );
  } else {
    console.log(`Copilot negative-proofs: ${tim.sha} — ${soPass}/${tim.baoCao.cases.length} pass, ranAt=${tim.baoCao.ranAt}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Copilot negative-proofs: KHÔNG KIỂM ĐƯỢC — ${error.message}`);
    process.exitCode = 3;
  });
}
