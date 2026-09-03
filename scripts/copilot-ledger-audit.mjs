#!/usr/bin/env node
// Task G5-E (deliverable 5) — đối chiếu sổ hành động Copilot
// (`app_private.copilot_action_ledger`) trên MỘT tổ chức, N ngày gần nhất.
//
// BA CON SỐ, VÀ VÌ SAO CHỌN ĐÚNG BA CON SỐ ĐÓ
//   1. `unintendedWrite` — một dòng `step_done` mà `action_id` thuộc nhóm 8
//      hành động `direct_l5_v1` (G5-C) nhưng `consent_kind` KHÔNG phải
//      `step_up`/`standing_grant` (thiếu hẳn, hoặc mang `click` — kiểu đồng ý
//      của một hành động L3/L4). Đây đúng nghĩa "một ghi L5 không đi qua đúng
//      cơ chế đồng ý L5" — chính bất biến mà PIN/uỷ quyền đứng dựng ra để giữ.
//      Kèm theo: nếu dòng có `plan_id`, đọc lại kế hoạch qua
//      `copilot_plan_get_v1` và so `organization_id` — một kế hoạch mang tổ
//      chức khác dòng sổ là dấu hiệu tổ chức bị đánh tráo giữa lúc duyệt và
//      lúc ghi (registry KHÔNG lộ `user_id` chủ kế hoạch qua RPC này, xem mục
//      "Khoảng trống đọc được" bên dưới — đây là giới hạn thật, không phải bỏ
//      sót).
//   2. `duplicate` — trùng `idempotency_key` trong `public.ai_write_audit`
//      của tổ chức, trong cùng cửa sổ ngày. Cột này có ràng buộc UNIQUE ở tầng
//      bảng (`20260711050000_ai_write_audit.sql`), nên con số này ĐÚNG RA
//      luôn phải là 0 — nếu khác 0, đó không phải một phát hiện nghiệp vụ nhỏ
//      mà là bằng chứng ràng buộc UNIQUE đã bị gỡ hoặc bị vượt qua.
//   3. `wrongOrg` — hai chiều: (a) dòng sổ có `plan_id` mà tổ chức của kế
//      hoạch (đọc qua `copilot_plan_get_v1`) khác tổ chức của dòng sổ; (b)
//      dòng sổ có `entity_table`/`entity_id` mà tổ chức thật của chính thực
//      thể đó (đọc thẳng bảng qua PostgREST) khác tổ chức của dòng sổ.
//
// NGUỒN ĐỌC: JWT super admin qua GoTrue + PostgREST — HAI RPC chính
// (`copilot_action_ledger_list_v1`, `copilot_plan_get_v1`) cộng một số lần
// đọc bảng TRỰC TIẾP (`ai_write_audit`, và bảng đích của `entity_table`) theo
// đúng khuôn `docBang`/`phieu()` mà `.e2e-fleet/specs/copilot-plan-batch-
// consent.spec.ts` và `scripts/copilot-live-negative-proofs.mjs` đã dùng —
// hai RPC không đủ để đo trùng-idempotency-key (đó là cột trên bảng khác) hay
// đối chiếu tổ chức của chính thực thể (RPC ledger không đọc bảng nghiệp vụ
// gốc). KHÔNG dùng service key.
//
// KHOẢNG TRỐNG ĐỌC ĐƯỢC (nói thẳng, không giấu)
//   - `copilot_action_ledger_list_v1` chặn ở LIMIT 200, không có tham số
//     offset/before — nếu tổ chức có hơn 200 dòng sổ mới hơn `--days`, các
//     dòng cũ hơn trong cửa sổ đó KHÔNG được đo. Script tự phát hiện tình
//     huống này (dòng cũ nhất trả về vẫn còn nằm trong cửa sổ) và in cảnh báo
//     rõ ràng thay vì báo "sạch" một cách im lặng.
//   - `copilot_plan_summary_v1` (nguồn của `copilot_plan_get_v1`) không lộ
//     `user_id` chủ kế hoạch, nên "user mismatch" ở mục 1 KHÔNG đo được qua
//     RPC này — chỉ "org mismatch" đo được. Ghi rõ trong `notes` của report,
//     không âm thầm bỏ qua một nửa lời hứa của brief.
//   - Danh sách 8 action `direct_l5_v1` NEO TAY ở đây (không có RPC liệt kê
//     registry cho non-super-admin đọc công khai) — khớp
//     `src/copilot/plan/actionCatalog.ts` tại thời điểm viết (G5-C, đợt 1).
//     Thêm action L5 mới (đợt 2+) mà quên cập nhật DANH_SACH_L5 ở đây sẽ làm
//     script "sạch" sai — đây là một khoảng trống đã biết, không phải một bất
//     biến do chính gate này bảo vệ.
//
// DÙNG
//   node scripts/copilot-ledger-audit.mjs --org <uuid> --days 14 \
//     --sysadmin-email <email> --sysadmin-password <mk> [--out <file.json>]
//
// Credential mặc định đọc từ env COPILOT_LEDGER_AUDIT_SYSADMIN_EMAIL/PASSWORD
// — KHÔNG hardcode, KHÔNG in ra log. Exit code 0 = cả ba con số đều 0. Exit
// code 2 = ít nhất một con số > 0 (một phát hiện cần người đọc, không phải
// một lỗi script). Exit code 1 = script tự lỗi (thiếu credential, mạng...).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tám hành động `direct_l5_v1` (G5-C, đợt 1) — neo tay, xem chú thích ở đầu
 * file về lý do và giới hạn.
 */
export const DANH_SACH_L5 = Object.freeze([
  'income_expense.duyet',
  'income_expense.duyet_vao_so',
  'income_expense.vao_so',
  'invoice.duyet',
  'invoice.xoa_mem',
  'meter_reading.duyet',
  'contract.duyet_thanh_ly',
  'customer.xoa_mem',
]);

/** Kiểu đồng ý HỢP LỆ cho một hành động L5 chạy trong kế hoạch. */
export const CONSENT_KIND_L5_HOP_LE = Object.freeze(['step_up', 'standing_grant']);

/** Tên bảng hợp lệ cho `entity_table` — khớp regex mà chính RPC gốc dùng khi
 *  nội suy `%I` (an toàn ở phía server); kiểm lại ở phía script cho chắc. */
const TEN_BANG_HOP_LE = /^[a-z_][a-z0-9_]*$/;

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
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
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

/** Đọc tối đa 200 dòng sổ mới nhất của một tổ chức. */
async function docSo(client, jwtSys, org) {
  const kq = await client.rpc(jwtSys, 'copilot_action_ledger_list_v1', {
    p_organization_id: org,
    p_limit: 200,
  });
  if (kq.status !== 200) throw new Error(`Đọc sổ hành động (${org}) thất bại: ${loi(kq)}`);
  if (!Array.isArray(kq.body)) throw new Error(`Sổ hành động trả về không phải mảng: ${JSON.stringify(kq.body).slice(0, 200)}`);
  return kq.body;
}

const cacheKeHoach = new Map();
async function docKeHoach(client, jwtSys, planId) {
  if (cacheKeHoach.has(planId)) return cacheKeHoach.get(planId);
  const kq = await client.rpc(jwtSys, 'copilot_plan_get_v1', { p_plan_id: planId });
  const ke = kq.status === 200 ? kq.body : null;
  cacheKeHoach.set(planId, ke);
  return ke;
}

const cacheThucThe = new Map();
async function docToChucThucThe(client, jwtSys, table, id) {
  const khoa = `${table}:${id}`;
  if (cacheThucThe.has(khoa)) return cacheThucThe.get(khoa);
  if (!TEN_BANG_HOP_LE.test(table)) {
    cacheThucThe.set(khoa, undefined);
    return undefined;
  }
  try {
    const rows = await client.table(jwtSys, `${table}?id=eq.${id}&select=organization_id`);
    const org = rows[0]?.organization_id ?? null;
    cacheThucThe.set(khoa, org);
    return org;
  } catch {
    // Bảng không tồn tại/không đọc được qua PostgREST (vd bảng app_private) —
    // không tính là wrong-org, chỉ là "không đối chiếu được".
    cacheThucThe.set(khoa, undefined);
    return undefined;
  }
}

/**
 * Đối chiếu chính — TRẢ VỀ dữ liệu thuần, không in gì. `main()` in và quyết
 * định exit code; tách ra để test đơn vị gọi được không cần mạng thật.
 */
export async function doiChieuSo(client, jwtSys, { org, days }) {
  const since = new Date(Date.now() - days * 86_400_000);
  const tatCa = await docSo(client, jwtSys, org);
  const trongCuaSo = tatCa.filter((d) => new Date(d.created_at) >= since);

  const canhBaoThieuDong =
    tatCa.length >= 200 && new Date(tatCa[tatCa.length - 1]?.created_at ?? 0) >= since;

  const unintendedWrite = [];
  const wrongOrg = [];

  for (const dong of trongCuaSo) {
    if (dong.event === 'step_done' && DANH_SACH_L5.includes(dong.action_id)) {
      if (!CONSENT_KIND_L5_HOP_LE.includes(dong.consent_kind)) {
        unintendedWrite.push({
          id: dong.id,
          plan_id: dong.plan_id,
          action_id: dong.action_id,
          consent_kind: dong.consent_kind ?? null,
          created_at: dong.created_at,
          ly_do: `hanh dong L5 nhung consent_kind="${dong.consent_kind ?? '(khong co)'}", phai la step_up/standing_grant`,
        });
      }
      if (dong.plan_id) {
        const ke = await docKeHoach(client, jwtSys, dong.plan_id);
        if (ke && ke.organization_id && ke.organization_id !== dong.organization_id) {
          wrongOrg.push({
            id: dong.id,
            plan_id: dong.plan_id,
            nguon: 'plan',
            to_chuc_dong_so: dong.organization_id,
            to_chuc_ke_hoach: ke.organization_id,
            created_at: dong.created_at,
          });
        }
      }
    }
    if (
      (dong.event === 'step_done' || dong.event === 'action_executed') &&
      dong.entity_table &&
      dong.entity_id
    ) {
      const toChucThucThe = await docToChucThucThe(client, jwtSys, dong.entity_table, dong.entity_id);
      if (toChucThucThe !== undefined && toChucThucThe !== null && toChucThucThe !== dong.organization_id) {
        wrongOrg.push({
          id: dong.id,
          entity_table: dong.entity_table,
          entity_id: dong.entity_id,
          nguon: 'entity',
          to_chuc_dong_so: dong.organization_id,
          to_chuc_thuc_the: toChucThucThe,
          created_at: dong.created_at,
        });
      }
    }
  }

  // TRÙNG idempotency_key — đọc thẳng ai_write_audit (UNIQUE ở tầng bảng, nên
  // con số đúng ra LUÔN bằng 0).
  const sinceIso = since.toISOString();
  const auditRows = await client.table(
    jwtSys,
    `ai_write_audit?organization_id=eq.${org}&created_at=gte.${encodeURIComponent(sinceIso)}` +
      '&select=id,idempotency_key,entity_table,entity_id,created_at,user_id&order=created_at.desc',
  );
  const theoKhoa = new Map();
  for (const row of auditRows) {
    const ds = theoKhoa.get(row.idempotency_key) ?? [];
    ds.push(row);
    theoKhoa.set(row.idempotency_key, ds);
  }
  const duplicate = [...theoKhoa.entries()]
    .filter(([, ds]) => ds.length > 1)
    .map(([idempotency_key, ds]) => ({ idempotency_key, rows: ds }));

  return {
    organizationId: org,
    days,
    windowSince: since.toISOString(),
    ledgerRowsFetched: tatCa.length,
    ledgerRowsInWindow: trongCuaSo.length,
    auditRowsInWindow: auditRows.length,
    truncationWarning: canhBaoThieuDong
      ? `copilot_action_ledger_list_v1 tra ve dung 200 dong (tran LIMIT) va dong cu nhat van con trong cua so ${days} ngay — co the con dong CU HON chua duoc do. Khong co tham so offset o RPC v1 de doc tiep.`
      : null,
    counts: {
      unintendedWrite: unintendedWrite.length,
      duplicate: duplicate.length,
      wrongOrg: wrongOrg.length,
    },
    unintendedWrite,
    duplicate,
    wrongOrg,
    notes: [
      '"user mismatch" cua unintended-write KHONG do duoc: copilot_plan_summary_v1 (nguon cua ' +
        'copilot_plan_get_v1) khong lo user_id chu ke hoach qua RPC nay. Chi "org mismatch" duoc do.',
      'Danh sach L5 neo tay trong DANH_SACH_L5 (khop actionCatalog.ts dot G5-C 1) — them action L5 ' +
        'moi ma quen cap nhat o day se lam script bo sot, khong bao loi.',
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const org = args.org;
  const days = Number(args.days ?? 14);
  const sysEmail = args['sysadmin-email'] || process.env.COPILOT_LEDGER_AUDIT_SYSADMIN_EMAIL;
  const sysPass = args['sysadmin-password'] || process.env.COPILOT_LEDGER_AUDIT_SYSADMIN_PASSWORD;
  const out = args.out;

  if (!org || !/^[0-9a-f-]{36}$/i.test(String(org))) {
    console.error('Thiếu/sai --org <uuid>.');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    console.error('Thiếu/sai --days N (1..365).');
    process.exitCode = 1;
    return;
  }
  if (!sysEmail || !sysPass) {
    console.error(
      'Thiếu credential (--sysadmin-email/-password hoặc COPILOT_LEDGER_AUDIT_SYSADMIN_EMAIL/PASSWORD).',
    );
    process.exitCode = 1;
    return;
  }

  const { url, apikey } = readEnvFile();
  if (!url || !apikey) throw new Error('Không đọc được VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY từ .env.');
  const client = new Client(url, apikey);

  console.error(`Đăng nhập sysadmin… (org=${org}, days=${days})`);
  const jwtSys = await client.login(sysEmail, sysPass);

  const report = await doiChieuSo(client, jwtSys, { org, days });
  const tongVanDe = report.counts.unintendedWrite + report.counts.duplicate + report.counts.wrongOrg;

  console.log(JSON.stringify(report, null, 2));
  console.error(
    `\ncopilot-ledger-audit: org=${org} days=${days} — unintendedWrite=${report.counts.unintendedWrite} ` +
      `duplicate=${report.counts.duplicate} wrongOrg=${report.counts.wrongOrg} ` +
      `(${report.ledgerRowsInWindow} dòng sổ, ${report.auditRowsInWindow} dòng audit trong cửa sổ).`,
  );
  if (report.truncationWarning) console.error(`⚠ ${report.truncationWarning}`);

  if (out) {
    mkdirSync(dirname(join(repoRoot, out)), { recursive: true });
    writeFileSync(join(repoRoot, out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(`Đã ghi ${out}.`);
  }

  if (tongVanDe > 0) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`Lỗi: ${e?.stack ?? e}`);
    process.exitCode = 1;
  });
}
