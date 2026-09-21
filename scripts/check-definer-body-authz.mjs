#!/usr/bin/env node
// Gate: hàm SECURITY DEFINER đụng bảng TIỀN / PII mà `authenticated` gọi được
// thì THÂN HÀM phải tự kiểm phạm vi. Không kiểm = ai cũng đọc/ghi được sổ của
// người khác chỉ bằng một UUID đoán ra.
//
// VÌ SAO CÓ GATE NÀY — nó ra đời từ lỗ I1, đo ngày 15/09/2026.
//   `v5_month_money(p_user, p_month)` và `v5_n_chuan` là SECURITY DEFINER,
//   GRANT cho `authenticated`, và trong thân hàm KHÔNG có một phép kiểm quyền
//   nào. `p_user` là tham số. Nghĩa là bất kỳ ai đăng nhập cũng đọc được bảng
//   lương của bất kỳ ai, kể cả người của công ty khác — RLS không cứu được vì
//   DEFINER chạy bằng quyền chủ hàm, đúng như thiết kế của nó.
//
//   Đây KHÔNG phải lớp lỗi mà `check-definer-acl.mjs` bắt: hàm này không
//   anon-executable, nó "chỉ" mở cho người đăng nhập — trông hoàn toàn bình
//   thường trong mọi bảng kê ACL.
//
// LUẬT
//   definer  ∧  grant authenticated  ∧  chạm bảng trong DANH_SACH_NHAY_CAM
//   ∧  thân hàm KHÔNG có primitive phạm vi nào  ⇒  ĐỎ.
//
//   Primitive phạm vi: xem `PRIMITIVE_PHAM_VI` dưới đây — lõi `authorized_scope_v3`,
//   các bọc quanh nó, phạm vi theo toà, ranh giới công ty, và `auth.uid()`.
//   `auth.uid()` nằm trong danh sách vì hàm "chỉ đọc của chính tôi" là mô hình
//   hợp lệ — nhưng nó phải NÓI RA điều đó trong thân hàm.
//
//   Danh sách CỐ Ý hẹp và viết tay. Không dùng bao đóng bắc cầu ("gọi hàm nào
//   đó có auth.uid() bên trong") vì rất nhiều hàm đọc auth.uid() chỉ để GHI
//   NGƯỜI THỰC HIỆN vào sổ — đó là nhật ký, không phải hàng rào. Mỗi tên thêm
//   vào đây phải được đọc thân hàm và xác nhận bằng tay.
//
// ĐỌC TỪ ĐÂU — và vì sao KHÔNG hỏi database
//   Nguồn là `supabase/migrations/*.sql`, đọc theo thứ tự tên file, bản định
//   nghĩa SAU ĐÈ bản trước (đúng cách Postgres nhận `create or replace`).
//   Hai lý do:
//     1. Gate chạy được trong CI không credential, và chạy trên PR — tức là
//        NÓ ĐỎ TRƯỚC KHI hàm kịp lên production. Gate hỏi catalog live chỉ kêu
//        sau khi lỗ đã mở.
//     2. `check-definer-acl.mjs` đã canh phía live. Hai gate soi hai thời điểm
//        khác nhau là cố ý, không phải trùng lặp.
//   KHOẢNG MÙ phải nói thẳng: phép quét khớp theo TÊN hàm, không phân biệt
//   overload; và hàm tạo bằng đường khác migration (sửa tay trên production)
//   thì gate này không thấy — đó là việc của `check-definer-acl` và
//   `capture-production-catalog`.
//
//   node scripts/check-definer-body-authz.mjs
//   node scripts/check-definer-body-authz.mjs --list   # in từng chỗ
//
// Không cần credential. Thoát 0 đạt · 1 vi phạm · 3 KHÔNG ĐO ĐƯỢC.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichSql } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const THU_MUC_MIGRATION = join(repoRoot, 'supabase', 'migrations');
const DUONG_DAN_ALLOWLIST = join(repoRoot, 'tooling', 'definer-body-authz-allowlist.json');

/**
 * Bảng mà rò một dòng là rò TIỀN hoặc THÔNG TIN CÁ NHÂN.
 *
 * Cố ý viết tay, không sinh từ database: gate phải chạy được khi không có
 * credential. Thêm bảng vào đây khi có bảng tiền/PII mới.
 */
export const DANH_SACH_NHAY_CAM = [
  // — tiền —
  'income_expenses',
  'income_expense_items',
  'income_expense_postings',
  'income_expense_posting_lines',
  'invoices',
  'invoice_items',
  'invoice_payment_allocations',
  'invoice_payment_collections',
  'invoice_payment_tenders',
  'payments',
  'accounts',
  'cash_handovers',
  'cash_handover_items',
  'cashbook_reconciliations',
  'contracts',
  'contract_terminations',
  'deposits',
  'expenses',
  'salary_monthly',
  'salary_adjustments',
  'salary_settlement_bundles',
  'salary_settlement_tranches',
  'salary_earning_consumptions',
  'salary_work_ledger_snapshot',
  'manager_salary_config',
  'salary_bonus_rules',
  // — thông tin cá nhân —
  'customers',
  'profiles',
  'tenants',
  'contract_tenants',
  'contract_customers',
  'leads',
];

/** Primitive nói rằng thân hàm CÓ tự hỏi "người này được đụng cái gì". */
export const PRIMITIVE_PHAM_VI = [
  // Lõi phân giải phạm vi, và hai bọc quanh nó mà writer thật sự gọi. Bỏ hai
  // cái bọc ra thì gate báo thừa 30 hàm vốn ĐANG gác đúng — một gate kêu 36
  // lần cho 6 lỗ thật là một gate không ai đọc nữa.
  'authorized_scope_v3',
  'authorize_tenant_action_v3',
  'has_any_scope_v3',
  'require_perm_v1',
  // Phạm vi theo toà nhà.
  'can_access_building',
  'can_do_on_building',
  'accessible_building_ids',
  // Ranh giới công ty lấy từ JWT của NGƯỜI GỌI.
  'my_org_ids',
  // "Chỉ của chính tôi" / "chỉ quản trị nền tảng" — mô hình hợp lệ, nhưng thân
  // hàm phải NÓI RA.
  'auth.uid()',
  'current_uid_v1', //                      bọc quanh auth.uid(), fail-closed
  'is_super_admin',
  // Bộ phân giải phạm vi THEO MIỀN. Mỗi cái dưới đây đã được MỞ RA ĐỌC ngày
  // 15/09/2026 và xác nhận thân hàm của CHÍNH NÓ hỏi danh tính người gọi —
  // không phải nhận vào danh sách chỉ vì cái tên nghe có vẻ là guard:
  'ie_compat_actor_v2', //                 → auth.uid()
  'business_performance_exact_scope_v1', // → auth.uid() + require
  'network_center_require_view_v1', //      → auth.uid() + can_do_on_building
  'copilot_org_scope_buildings_v1', //      → lọc theo toà người gọi được phép
  'is_admin', //                            → is_super_admin
  'resolve_finance_actor_v2', //            → current_uid_v1 + membership ACTIVE, RAISE 42501
  // Hai helper tài chính dưới đây được audit khi dựng Hợp đồng & quyết toán:
  // - review: resolve actor, scope tòa nhà, quyền theo hành động, source owner;
  // - snapshot: auth.uid, membership ACTIVE trong đúng org, scoped permission.
  // Cả hai bị thu hồi khỏi authenticated và được pin definition/ACL ở migration
  // 20260921015956; public wrappers chỉ gọi chúng, không tự cấp thêm phạm vi.
  'authorize_income_expense_review_v1',
  'income_expense_action_scope_v1',
];

/**
 * Sàn chống rỗng-vô-nghĩa. Repo có hơn tám trăm migration và hàng trăm hàm
 * DEFINER; con số nhỏ nghĩa là bộ dò hỏng, KHÔNG phải "không có vi phạm".
 */
export const SAN_SO_HAM_DEFINER = 200;

const RE_TAO_HAM =
  /create\s+(?:or\s+replace\s+)?function\s+((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)\s*\(/gi;

/**
 * Cắt thân hàm dollar-quoted bắt đầu từ vị trí `tu`.
 * Trả `{ header, body, ketThuc }`, hoặc null nếu không tìm thấy thân hàm.
 */
export function catThanHam(sql, tu) {
  const moThan = /\$([a-z0-9_]*)\$/i.exec(sql.slice(tu));
  if (!moThan) return null;
  const iMo = tu + moThan.index;
  const dau = moThan[0];
  const iDong = sql.indexOf(dau, iMo + dau.length);
  if (iDong < 0) return null;
  return {
    header: sql.slice(tu, iMo),
    body: sql.slice(iMo + dau.length, iDong),
    ketThuc: iDong + dau.length,
  };
}

/**
 * Thân hàm CÓ chạm bảng này không — khớp theo ranh giới từ để `accounts` không
 * nuốt `bank_accounts`. Tách ra thành hàm export được vì đây đúng là chỗ gate
 * từng hỏng âm thầm (xem chú thích tại điểm gọi).
 */
export function chamBang(body, bang) {
  return new RegExp(String.raw`\b${bang}\b`).test(body);
}

const chuanHoaTen = (ten) => (ten.includes('.') ? ten : `public.${ten}`).toLowerCase();

/**
 * Đọc MỘT file migration ra danh sách sự kiện theo thứ tự xuất hiện.
 * Sự kiện: `{ loai: 'dinh-nghia'|'cap'|'thu-hoi', ham, ... }`.
 *
 * Tách riêng để test được từng luật mà không cần đụng đĩa.
 */
export function docSuKien(sqlThoc) {
  const sql = boChuThichSql(sqlThoc);
  const suKien = [];

  RE_TAO_HAM.lastIndex = 0;
  let m;
  while ((m = RE_TAO_HAM.exec(sql)) !== null) {
    const than = catThanHam(sql, m.index);
    if (!than) continue;
    // `security definer` nằm giữa danh sách tham số và thân hàm.
    suKien.push({
      loai: 'dinh-nghia',
      ham: chuanHoaTen(m[1]),
      viTri: m.index,
      definer: /security\s+definer/i.test(than.header),
      body: than.body,
    });
    RE_TAO_HAM.lastIndex = than.ketThuc;
  }

  const reGrant =
    /\b(grant|revoke)\s+(?:all|execute)[\s\S]{0,40}?\bon\s+function\s+((?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)\s*\([^)]*\)\s*(?:from|to)\s+([^;]+);/gi;
  let g;
  while ((g = reGrant.exec(sql)) !== null) {
    const vaiTro = g[3].toLowerCase();
    if (!/\bauthenticated\b/.test(vaiTro) && !/\bpublic\b/.test(vaiTro)) continue;
    suKien.push({
      loai: g[1].toLowerCase() === 'grant' ? 'cap' : 'thu-hoi',
      ham: chuanHoaTen(g[2]),
      viTri: g.index,
      // `revoke ... from public` KHÔNG cắt `authenticated` trên Supabase (án lệ
      // đã ghi trong repo). Chỉ dòng nêu đích danh `authenticated` mới tính là
      // thu hồi; còn `grant ... to public` thì authenticated ĐƯỢC hưởng.
      chamAuthenticated: /\bauthenticated\b/.test(vaiTro),
      chamPublic: /\bpublic\b/.test(vaiTro),
    });
  }

  return suKien.sort((a, b) => a.viTri - b.viTri);
}

/**
 * Gộp sự kiện của MỌI migration (đã theo thứ tự tên file) thành trạng thái
 * hiệu lực cuối cùng của từng hàm, rồi chấm điểm.
 */
export function phanTichThanHam({ suKien = [], allowlist = [], chuaVa = [] } = {}) {
  const trangThai = new Map();
  const lay = (ham) => {
    if (!trangThai.has(ham)) {
      trangThai.set(ham, { ham, definer: false, body: '', capAuthenticated: false, nguon: null });
    }
    return trangThai.get(ham);
  };

  for (const sk of suKien) {
    const t = lay(sk.ham);
    if (sk.loai === 'dinh-nghia') {
      t.definer = sk.definer;
      t.body = sk.body;
      t.nguon = sk.file ?? t.nguon;
      // `create or replace` KHÔNG reset ACL, nên không đụng capAuthenticated.
    } else if (sk.loai === 'cap') {
      if (sk.chamAuthenticated || sk.chamPublic) t.capAuthenticated = true;
    } else if (sk.loai === 'thu-hoi') {
      if (sk.chamAuthenticated) t.capAuthenticated = false;
    }
  }

  const khoa = (d) => String(d.function ?? '').toLowerCase();
  const choPhep = new Map(allowlist.map((d) => [khoa(d), d]));
  const noCu = new Map(chuaVa.map((d) => [khoa(d), d]));

  /** Hàm này có đang vi phạm luật không (không xét hai danh sách). */
  const dangViPham = (t) => {
    if (!t || !t.definer || !t.capAuthenticated) return null;
    const body = t.body.toLowerCase();
    // Ranh giới từ phải viết HAI dấu gạch ngược trong template literal: một dấu
    // là ký tự backspace (U+0008) chứ không phải ranh giới từ của regex — và
    // một gate như thế không khớp gì cả rồi in dấu tick. Đã dính đúng lỗi này
    // lúc dựng file, 15/09/2026; bài test `bắt được chuỗi trong thân hàm thật`
    // là thứ canh nó.
    const bang = DANH_SACH_NHAY_CAM.filter((b) => chamBang(body, b));
    if (bang.length === 0) return null;
    if (PRIMITIVE_PHAM_VI.some((x) => body.includes(x.toLowerCase()))) return null;
    return bang;
  };

  const viPham = [];
  const thieuLyDo = [];
  const daSiet = [];
  const trungHaiDanhSach = [];
  let soDefiner = 0;

  for (const ten of choPhep.keys()) if (noCu.has(ten)) trungHaiDanhSach.push(ten);

  for (const t of trangThai.values()) {
    if (t.definer) soDefiner++;
    const bang = dangViPham(t);
    if (!bang) continue;

    const tha = choPhep.get(t.ham) ?? noCu.get(t.ham);
    if (tha) {
      // Tha bổng không lý do là ratchet ban phước cho chính cái lỗ nó sinh ra
      // để canh — án lệ 07/08/2026 ở đầu check-definer-acl.mjs.
      if (!String(tha.reason ?? '').trim()) thieuLyDo.push(t.ham);
      continue;
    }
    viPham.push({ ham: t.ham, bang, nguon: t.nguon });
  }

  // Mục đã được vá thì phải GỠ khỏi danh sách, nếu không lần sau nó lại che một
  // lỗ mới trùng tên.
  for (const ten of [...choPhep.keys(), ...noCu.keys()]) {
    if (!dangViPham(trangThai.get(ten))) daSiet.push(ten);
  }

  return {
    viPham: viPham.sort((a, b) => a.ham.localeCompare(b.ham)),
    thieuLyDo: [...new Set(thieuLyDo)].sort(),
    trungHaiDanhSach: trungHaiDanhSach.sort(),
    daSiet: [...new Set(daSiet)].sort(),
    soDefiner,
    soHam: trangThai.size,
    soChuaVa: noCu.size,
    dat:
      viPham.length === 0 && thieuLyDo.length === 0 && trungHaiDanhSach.length === 0,
  };
}

function docMoiMigration() {
  const ten = readdirSync(THU_MUC_MIGRATION)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const suKien = [];
  for (const f of ten) {
    const sql = readFileSync(join(THU_MUC_MIGRATION, f), 'utf8');
    for (const sk of docSuKien(sql)) suKien.push({ ...sk, file: f });
  }
  return { soFile: ten.length, suKien };
}

function main(argv) {
  if (!existsSync(THU_MUC_MIGRATION)) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: không thấy supabase/migrations');
    return 3;
  }

  const doc = existsSync(DUONG_DAN_ALLOWLIST)
    ? JSON.parse(readFileSync(DUONG_DAN_ALLOWLIST, 'utf8'))
    : {};
  const allowlist = doc.allow ?? [];
  const chuaVa = doc.chuaVa ?? [];

  const { soFile, suKien } = docMoiMigration();
  const kq = phanTichThanHam({ suKien, allowlist, chuaVa });

  if (kq.soDefiner < SAN_SO_HAM_DEFINER) {
    console.error(
      `❌ KHÔNG ĐO ĐƯỢC: chỉ dò thấy ${kq.soDefiner} hàm SECURITY DEFINER trong ${soFile} migration ` +
        `(sàn ${SAN_SO_HAM_DEFINER}). Bộ dò hỏng — đừng đọc đây là "không có vi phạm".`,
    );
    return 3;
  }

  if (argv.includes('--list')) {
    for (const v of kq.viPham) {
      console.log(`${v.ham}  ←  ${v.nguon}
    bảng: ${v.bang.join(', ')}`);
    }
  }

  if (kq.viPham.length) {
    console.error(
      `❌ ${kq.viPham.length} hàm SECURITY DEFINER cho authenticated đụng bảng tiền/PII mà thân hàm không kiểm phạm vi:`,
    );
    for (const v of kq.viPham) console.error(`   ! ${v.ham}  (${v.bang.join(', ')})  ← ${v.nguon}`);
    console.error(
      `   Vá: thêm ${PRIMITIVE_PHAM_VI.join(' | ')} vào thân hàm; hoặc REVOKE authenticated.`,
    );
    console.error(
      `   Đã xét và THẬT SỰ an toàn ⇒ khai vào "allow" trong ${DUONG_DAN_ALLOWLIST} kèm "reason".`,
    );
    console.error(
      '   Là lỗ THẬT nhưng chưa tới lượt vá ⇒ khai vào "chuaVa" kèm "reason" + "owner". Danh sách đó chỉ được PHÉP NGẮN LẠI.',
    );
  }
  if (kq.thieuLyDo.length) {
    console.error(`❌ ${kq.thieuLyDo.length} mục được tha mà không có "reason":`);
    for (const h of kq.thieuLyDo) console.error('   ! ' + h);
    console.error('   Tha bổng không lý do là ratchet ban phước cho chính cái lỗ nó sinh ra để canh.');
  }
  if (kq.trungHaiDanhSach.length) {
    console.error(`❌ ${kq.trungHaiDanhSach.length} mục nằm ở CẢ "allow" lẫn "chuaVa" — mâu thuẫn:`);
    for (const h of kq.trungHaiDanhSach) console.error('   ! ' + h);
    console.error('   "allow" nghĩa là an toàn, "chuaVa" nghĩa là lỗ thật. Chọn một.');
  }
  if (!kq.dat) return 1;

  if (kq.daSiet.length) {
    console.log(
      `ℹ️  ${kq.daSiet.length} mục trong allow/chuaVa không còn vi phạm (siết chặt — tốt). Gỡ khỏi danh sách.`,
    );
    for (const h of kq.daSiet) console.log('   - ' + h);
  }
  console.log(
    `✅ ${kq.soDefiner} hàm SECURITY DEFINER trong ${soFile} migration · ` +
      `${allowlist.length} mục an toàn có lý do · ${kq.soChuaVa} lỗ thật đã ghi sổ chờ vá · 0 vi phạm mới.`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
