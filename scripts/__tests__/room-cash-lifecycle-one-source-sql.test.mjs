// Vòng đời tiền phòng — MỘT nguồn (20261028203816): chạy THẬT chuỗi thân get_room_cash_lifecycle_v1 trên PGlite
// 20260921085952 → 20261018052932 → file mới (hai lượt). Hàm dùng lại nạp THÂN SỐNG (lần CREATE cuối theo timestamp):
// invoice_direct_paid_v1, invoice_carried_debt_v1, invoice_effective_outstanding_v1, ie_has_commission_item_v1,
// is_commission_voucher_v1, invoice_amount_split_v1/parts_for_v1 (+ nrm_vn, invoice_item_column_v1). Bảng, quyền,
// đoạn cư trú là fixture tổng hợp — KHÔNG chứng minh RLS/JWT production. Mọi id, mã phiếu, số tiền là GIẢ.
//
// Mỗi phòng một nhóm ca:
//   A  tiền thật vs cấn trừ (CT/TM received 0, received NULL, CT có tiền), payment đảo, ngày thu thật (PARTIAL_PAID),
//      hoá đơn thanh lý cấn hết, DRAFT/huỷ/xoá vắng; gia hạn (originalEndDate); thanh lý chưa có phiếu hoàn.
//   B  chuỗi nợ kéo 4 tầng còn mở; nợ cũ không khai nguồn; nguồn nằm ngoài tập (hoá đơn đã xoá).
//   C  nguồn PAID nhờ hoá đơn gánh PAID; dòng cọc trên hoá đơn đã thu / chưa thu; PAID còn lẻ; PAID thu dư.
//   D1/D2  một HĐ hai phòng: money theo phòng ≠ cả HĐ; khách trả thêm khi thanh lý thuộc đúng một phòng.
//   F  thanh lý khi hoá đơn gánh còn mở (cấn trừ kép — lỗi writer; chỉ cần đủ dữ liệu để client cảnh báo).
//   G  bỏ cọc: hoá đơn huỷ còn tiền giữ lại (writer ghi đè total = đã thu, giữ dòng cọc + previous_debt: tiền ≤ dòng
//      doanh thu / vượt dòng doanh thu, hoá đơn gánh huỷ); hoá đơn phạt cấn bằng cọc (via FORFEIT).
//   L  thanh lý kiểu cũ: hoá đơn tổng âm trả qua phiếu '[Hoàn trả thanh lý]' gắn hoá đơn; hoá đơn âm chưa hoàn.
//   P  dòng cọc trên hoá đơn tất toán KHÔNG bằng tiền thật: cấn trừ gạch hết / gạch một phần, hoá đơn gánh trả hộ.
//   R  phiếu hoàn: dòng cọc / dòng khác × duyệt, ghi sổ, sổ ảo, huỷ, đảo, xoá; HĐ có phiếu mà không có thanh lý.
//   K  hoa hồng / thưởng: mọi stage, HHMG, thưởng từ phiếu cọc, trùng cũ, các phiếu phải vắng; hai phiếu cọc cùng ngày.
// Phiếu thu chi chèn theo thứ tự id GIẢM (thứ tự vật lý ≠ thứ tự id) ⇒ khoá phá hoà phải tự xếp, không nhờ heap.
// Payload mẫu phía client (src/lib/__tests__/fixtures/roomCashLifecyclePayload.sample.json) phải bằng đúng đầu ra RPC.
// Cuối file: đột biến — mỗi điều kiện lọc/kẹp phải làm phép kiểm đỏ.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const MIG_DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name) => readFileSync(new URL(name, MIG_DIR), 'utf8');
const NEW_FILE = '20261028203816_vong_doi_tien_phong_mot_nguon.sql';
const NEW = read(NEW_FILE);
const FIX = read('20261018052932_vong_doi_tien_phong_doi_khoa_man_hinh.sql');
const OLD = read('20260921085952_restore_before_contract_settlement.sql');
const POLICY = JSON.parse(readFileSync(new URL('../../supabase/migration-policy.json', import.meta.url), 'utf8'));

const SIG = 'public.get_room_cash_lifecycle_v1';
const ACL = '{postgres=X/postgres,authenticated=X/postgres}';
const RPC_BEFORE = { md5: 'a637b2312d020da2f7de2da01d5b6435', owner: 'postgres', acl: ACL };
const RPC_AFTER = { md5: 'e27f4c4977eaa881b1ffc8b595dbbc45', owner: 'postgres', acl: ACL };
const HELPERS = ['app_private.invoice_lifecycle_parts_v1(uuid[])', 'app_private.contract_commission_vouchers_v1(uuid,uuid[])',
  'app_private.termination_refund_parts_v1(uuid[])'];

// Một câu CREATE FUNCTION (tới hết dollar-quote của thân), lấy lần CREATE cuối trong `sql`.
function createOf(sql, name) {
  const starts = [...sql.matchAll(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'gi'))];
  if (!starts.length) throw new Error(`không thấy CREATE ${name}`);
  const rest = sql.slice(starts.at(-1).index);
  const tag = /AS\s+(\$[a-z_]*\$)/i.exec(rest);
  if (!tag) throw new Error(`không thấy thân ${name}`);
  const close = rest.indexOf(tag[1], tag.index + tag[0].length);
  return `${rest.slice(0, close + tag[1].length)};`;
}
// Định nghĩa SỐNG = lần CREATE cuối theo thứ tự timestamp (khuôn liveDefinitionOf ở src/lib/__tests__).
const corpus = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((file) => ({ file, sql: read(file).replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '') }));
function liveDefinitionOf(name) {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i');
  const hit = corpus.filter((m) => re.test(m.sql)).at(-1);
  if (!hit) throw new Error(`không thấy định nghĩa ${name}`);
  return { file: hit.file, sql: createOf(hit.sql, name) };
}
const REUSED = ['public.nrm_vn', 'public.invoice_item_column_v1', 'public.invoice_amount_split_v1', 'public.invoice_amount_parts_for_v1',
  'app_private.invoice_direct_paid_v1', 'app_private.invoice_carried_debt_v1', 'public.invoice_effective_outstanding_v1',
  'app_private.ie_has_commission_item_v1', 'app_private.is_commission_voucher_v1'];
// Thân RPC ở file witness — cắt đúng như room-cash-lifecycle-module-key-sql.test.mjs (chốt đầu file vá ghim md5 của nó).
function rpcBodyOf(sql) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${SIG}(`);
  const open = sql.indexOf('AS $function$', start);
  const close = sql.indexOf('$function$', open + 13);
  return sql.slice(start, close + 10) + ';';
}
const nghiemThuOf = (sql) => sql.slice(sql.indexOf('DO $nghiem_thu$'), sql.indexOf('$nghiem_thu$;') + 13);

// ───────────────────────────── dữ liệu giả ─────────────────────────────
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = u(1), OTHER_ORG = u(2), BUILDING = u(11), TENANT = u(21), VIEWER = u(31);
const ROOM = { A: u(101), B: u(102), C: u(103), D1: u(104), D2: u(105), F: u(106), G: u(107), R: u(108), K: u(109), L: u(110),
  P: u(111) };
const LABEL = new Map();
const ids = {};
const idOf = (label) => { if (!ids[label]) throw new Error(`thiếu nhãn ${label}`); return ids[label]; };
// Nhãn trùng ⇒ dòng ghi sau đè id dòng trước: hai bảng mang chung một uuid mà không ai biết.
function name(label, n) {
  if (ids[label]) throw new Error(`trùng nhãn ${label}`);
  ids[label] = u(n); LABEL.set(u(n), label); return u(n);
}

// [nhãn, phòng hiện tại, trạng thái, bắt đầu, kết thúc, kết thúc thực]
const CONTRACTS = [
  ['A', 'A', 'TERMINATED', '2026-01-01', '2026-12-31', '2026-03-31'],
  ['B', 'B', 'ACTIVE', '2026-05-01', '2027-04-30', null],
  ['C', 'C', 'ACTIVE', '2026-05-01', '2027-04-30', null],
  ['D', 'D2', 'TERMINATED', '2026-05-01', '2027-04-30', '2026-07-31'],
  ['F', 'F', 'TERMINATED', '2026-05-01', '2027-04-30', '2026-06-30'],
  ['G', 'G', 'TERMINATED', '2026-05-01', '2027-04-30', '2026-06-15'],
  ['R', 'R', 'TERMINATED', '2026-01-01', '2026-12-31', '2026-06-30'],
  ['RB', 'R', 'TERMINATED', '2026-07-15', '2027-07-14', '2026-08-05'],
  ['K', 'K', 'ACTIVE', '2026-01-15', '2027-01-14', null],
  ['L', 'L', 'TERMINATED', '2026-01-01', '2026-12-31', '2026-04-30'],
  ['P1', 'P', 'TERMINATED', '2026-05-01', '2027-04-30', '2026-06-30'],
  ['P6', 'P', 'TERMINATED', '2026-07-01', '2027-06-30', '2026-08-31'],
  ['P2', 'P', 'ACTIVE', '2026-09-01', '2027-08-31', null],
];
CONTRACTS.forEach(([label], i) => name(label, 201 + i));

// [nhãn, HĐ, phòng, kỳ, trạng thái, tổng, paid_amount (sau recompute), thêm]. Thứ tự = created_at (nguồn trước gánh).
const INVOICES = [
  ['A1', 'A', 'A', '2026-01', 'PAID', 3_000_000, 3_000_000, { paidDate: '2026-01-07' }],
  ['A2', 'A', 'A', '2026-02', 'PAID', 3_000_000, 3_000_000, { paidDate: '2026-03-31' }],
  ['A3', 'A', 'A', '2026-03', 'PARTIAL_PAID', 3_000_000, 1_000_000, { updatedAt: '2026-03-25T03:00:00Z' }],
  ['A4', 'A', 'A', '2026-03', 'PAID', 500_000, 500_000, { kind: 'SETTLEMENT', issue: '2026-03-31', paidDate: '2026-03-31' }],
  ['A5', 'A', 'A', '2026-04', 'DRAFT', 3_000_000, 0],
  ['A6', 'A', 'A', '2026-04', 'CANCELLED', 3_000_000, 0],
  ['A7', 'A', 'A', '2026-04', 'PAID', 3_000_000, 3_000_000, { deleted: true }],
  ['B1', 'B', 'B', '2026-05', 'OVERDUE', 1_000_000, 0],
  ['B2', 'B', 'B', '2026-06', 'OVERDUE', 2_100_000, 0, { prev: 1_000_000, src: [['B1', 1_000_000]] }],
  ['B3', 'B', 'B', '2026-07', 'OVERDUE', 3_300_000, 0, { prev: 2_100_000, src: [['B2', 2_100_000]] }],
  ['B4', 'B', 'B', '2026-08', 'APPROVED', 4_600_000, 0, { prev: 3_300_000, src: [['B3', 3_300_000]] }],
  ['B5', 'B', 'B', '2026-09', 'OVERDUE', 1_500_000, 0, { prev: 500_000 }], // nợ cũ nhập tay, không khai nguồn
  ['BX', 'B', 'B', '2026-04', 'OVERDUE', 200_000, 0, { deleted: true }],
  ['B6', 'B', 'B', '2026-10', 'APPROVED', 1_200_000, 0, { prev: 200_000, src: [['BX', 200_000]] }], // nguồn ngoài tập
  ['C1', 'C', 'C', '2026-05', 'PAID', 2_000_000, 2_000_000], // 1.000.000 trả thẳng + 1.000.000 do C2 gánh
  ['C2', 'C', 'C', '2026-06', 'PAID', 3_000_000, 3_000_000, { prev: 1_000_000, src: [['C1', 1_000_000]] }],
  ['C3', 'C', 'C', '2026-07', 'PAID', 6_000_000, 6_000_000],
  ['C4', 'C', 'C', '2026-08', 'OVERDUE', 4_000_000, 0],
  ['C5', 'C', 'C', '2026-09', 'PAID', 3_005_000, 3_000_000], // còn lẻ đã xoá
  ['C6', 'C', 'C', '2026-10', 'PAID', 2_000_000, 2_000_500], // thu dư
  ['D1', 'D', 'D1', '2026-05', 'PAID', 2_000_000, 2_000_000],
  ['D2', 'D', 'D2', '2026-06', 'PAID', 2_500_000, 2_500_000],
  ['D3', 'D', 'D2', '2026-07', 'PAID', 700_000, 700_000, { kind: 'SETTLEMENT', issue: '2026-07-31' }],
  ['F1', 'F', 'F', '2026-05', 'PAID', 1_000_000, 1_000_000],
  ['F2', 'F', 'F', '2026-06', 'PAID', 2_000_000, 2_000_000, { prev: 1_000_000, src: [['F1', 1_000_000]] }],
  // Bỏ cọc: huỷ, total ghi đè = đã thu (dòng gốc 6.000.000 gồm cọc 3.000.000 giữ nguyên) — giữ phần đã thu làm doanh thu.
  ['G1', 'G', 'G', '2026-05', 'CANCELLED', 1_500_000, 1_500_000],
  ['G2', 'G', 'G', '2026-06', 'CANCELLED', 3_000_000, 0],
  ['G3', 'G', 'G', '2026-06', 'PAID', 3_000_000, 3_000_000, { kind: 'SETTLEMENT', issue: '2026-06-15' }],
  ['L1', 'L', 'L', '2026-03', 'PAID', 2_000_000, 2_000_000],
  // Thanh lý kiểu cũ: phạt − hoàn cọc ⇒ tổng âm, "trả" bằng phiếu hoàn gắn hoá đơn (direct âm) / chưa hoàn.
  ['L2', 'L', 'L', '2026-04', 'PAID', -2_800_000, -2_800_000, { kind: 'SETTLEMENT', issue: '2026-04-30', paidDate: '2026-04-30' }],
  ['L3', 'L', 'L', '2026-04', 'OVERDUE', -1_000_000, 0, { kind: 'SETTLEMENT', issue: '2026-04-30' }],
  ['P1a', 'P1', 'P', '2026-05', 'PAID', 4_000_000, 4_000_000], // cọc chưa thu, thanh lý gạch hết bằng cấn trừ
  ['P6a', 'P6', 'P', '2026-07', 'PARTIAL_PAID', 4_000_000, 3_500_000], // cấn trừ gạch một phần (chế độ DEBT)
  ['P6b', 'P6', 'P', '2026-08', 'OVERDUE', 2_000_000, 0], // nợ thật kỳ sau
  ['P2a', 'P2', 'P', '2026-09', 'PAID', 4_000_000, 4_000_000], // 2.000.000 trả thẳng + 2.000.000 do P2b gánh
  ['P2b', 'P2', 'P', '2026-10', 'PAID', 3_000_000, 3_000_000, { prev: 2_000_000, src: [['P2a', 2_000_000]] }],
  // Hoá đơn gánh bị huỷ khi bỏ cọc: thu dở 1.000.000/1.400.000 (800.000 tiền phòng + 600.000 nợ kéo từ G1).
  ['G4', 'G', 'G', '2026-06', 'CANCELLED', 1_000_000, 1_000_000, { prev: 600_000, src: [['G1', 600_000]] }],
  // Huỷ khi bỏ cọc, thu vượt dòng doanh thu: phần vượt là cọc (V5 phân bổ doanh thu trước).
  ['G5', 'G', 'G', '2026-06', 'CANCELLED', 1_500_000, 1_500_000],
];
INVOICES.forEach(([label], i) => name(label, 301 + i));

// [hoá đơn, loại, accounting_class, tiền, mô tả]
const INVOICE_ITEMS = [
  ['A1', 'RENT', 'REVENUE', 3_000_000], ['A2', 'RENT', 'REVENUE', 3_000_000], ['A3', 'RENT', 'REVENUE', 3_000_000],
  ['A4', 'PENALTY', 'REVENUE', 200_000, 'Phạt trả phòng trước hạn'], ['A4', 'OTHER', 'REVENUE', 300_000, 'Phí dọn phòng'],
  ['C1', 'RENT', 'REVENUE', 2_000_000], ['C2', 'RENT', 'REVENUE', 2_000_000],
  ['C3', 'RENT', 'REVENUE', 3_000_000], ['C3', 'OTHER', 'DEPOSIT', 3_000_000, 'Tiền cọc'],
  ['C4', 'RENT', 'REVENUE', 3_000_000], ['C4', 'OTHER', 'DEPOSIT', 1_000_000, 'Cọc bổ sung'],
  ['C4', 'DISCOUNT', 'NON_PNL', 100_000, 'Chi tiết giảm trừ'], // chỉ là chi tiết discount_amount: không phải cọc
  ['C5', 'RENT', 'REVENUE', 3_005_000], ['C6', 'RENT', 'REVENUE', 2_000_000],
  ['D3', 'OTHER', 'REVENUE', 700_000, 'Thu thêm khi thanh lý'],
  ['G1', 'RENT', 'REVENUE', 3_000_000], ['G1', 'OTHER', 'DEPOSIT', 3_000_000, 'Tiền cọc'],
  ['G3', 'PENALTY', 'REVENUE', 3_000_000, 'Phạt bỏ cọc'],
  ['G4', 'RENT', 'REVENUE', 800_000],
  ['G5', 'RENT', 'REVENUE', 1_000_000], ['G5', 'OTHER', 'DEPOSIT', 3_000_000, 'Tiền cọc'],
  ['L1', 'RENT', 'REVENUE', 2_000_000],
  ['L2', 'PENALTY', 'REVENUE', 500_000, 'Phạt trả phòng trước hạn'], ['L2', 'DISCOUNT', 'REVENUE', -3_300_000, 'Hoàn cọc'],
  ['L3', 'DISCOUNT', 'REVENUE', -1_000_000, 'Hoàn cọc'],
  ['P1a', 'RENT', 'REVENUE', 1_000_000], ['P1a', 'OTHER', 'DEPOSIT', 3_000_000, 'Tiền cọc'],
  ['P6a', 'RENT', 'REVENUE', 1_000_000], ['P6a', 'OTHER', 'DEPOSIT', 3_000_000, 'Tiền cọc'],
  ['P6b', 'RENT', 'REVENUE', 2_000_000],
  ['P2a', 'RENT', 'REVENUE', 1_000_000], ['P2a', 'OTHER', 'DEPOSIT', 3_000_000, 'Tiền cọc'],
  ['P2b', 'RENT', 'REVENUE', 1_000_000],
];

// [nhãn, hoá đơn, tiền, received_amount, phương thức, ngày, thêm]
const PAYMENTS = [
  ['pA1a', 'A1', 2_000_000, 2_000_000, 'TM', '2026-01-05'],
  ['pA1b', 'A1', 1_000_000, 1_000_000, 'CT', '2026-01-07'], // CT có tiền thật (vd khấu trừ lương) = tiền
  ['pA1c', 'A1', 500_000, 500_000, 'TM', '2026-01-09', { reversed: true }], // đã đảo: không tính, không lấy ngày
  ['pA2a', 'A2', 2_700_000, null, 'TM', '2026-02-05'], // legacy: received NULL = tiền thật
  ['pA2b', 'A2', 300_000, 0, 'TM', '2026-03-31', { notes: 'Quyết toán khi thanh lý 31/03/2026' }], // TM received 0 = cấn trừ
  ['pA3', 'A3', 1_000_000, 1_000_000, 'TM', '2026-03-05'],
  ['pA4', 'A4', 500_000, 0, 'CT', '2026-03-31', { notes: 'Quyết toán khi thanh lý 31/03/2026 (cấn cọc)' }],
  ['pA7', 'A7', 3_000_000, 3_000_000, 'TM', '2026-04-05'],
  ['pC1', 'C1', 1_000_000, 1_000_000, 'TM', '2026-05-05'],
  ['pC2', 'C2', 3_000_000, 3_000_000, 'TM', '2026-06-05'],
  ['pC3', 'C3', 6_000_000, 6_000_000, 'TK', '2026-07-01'],
  ['pC5', 'C5', 3_000_000, 3_000_000, 'TM', '2026-09-05'],
  ['pC6', 'C6', 2_000_500, 2_000_500, 'TM', '2026-10-05'],
  ['pD1', 'D1', 2_000_000, 2_000_000, 'TM', '2026-05-05'],
  ['pD2', 'D2', 2_500_000, 2_500_000, 'TM', '2026-06-05'],
  ['pD3', 'D3', 700_000, 0, 'CT', '2026-07-31', { notes: 'Quyết toán khi thanh lý 31/07/2026' }],
  ['pF1', 'F1', 1_000_000, 0, 'CT', '2026-06-30', { notes: 'Quyết toán khi thanh lý 30/06/2026' }],
  ['pF2', 'F2', 2_000_000, 0, 'CT', '2026-06-30', { notes: 'Quyết toán khi thanh lý 30/06/2026' }],
  ['pG1', 'G1', 1_500_000, 1_500_000, 'TM', '2026-05-05'],
  ['pG3', 'G3', 3_000_000, 0, 'CT', '2026-06-15', { forfeit: true }],
  ['pL1', 'L1', 2_000_000, 2_000_000, 'TM', '2026-03-05'],
  ['pP1a', 'P1a', 4_000_000, 0, 'CT', '2026-06-30', { notes: 'Quyết toán khi thanh lý 30/06/2026' }],
  ['pP6a', 'P6a', 3_500_000, 0, 'CT', '2026-08-31', { notes: 'Quyết toán khi thanh lý 31/08/2026' }],
  ['pP2a', 'P2a', 2_000_000, 2_000_000, 'TM', '2026-09-05'],
  ['pP2b', 'P2b', 3_000_000, 3_000_000, 'TM', '2026-10-05'],
  ['pG4', 'G4', 1_000_000, 1_000_000, 'TM', '2026-06-05'],
  ['pG5', 'G5', 1_500_000, 1_500_000, 'TM', '2026-06-05'],
];
PAYMENTS.forEach(([label], i) => name(label, 501 + i));

// [nhãn, HĐ, loại, nguồn hệ thống, ngày, tiền, duyệt, ghi sổ, thêm]. Ghi sổ POSTED có active_posting_id_v2 trừ khi active: false.
const VOUCHERS = [
  ['depA', 'A', 'INCOME', 'contract.deposit', '2025-12-28', 2_000_000, 'APPROVED', 'POSTED'],
  ['offA', 'A', 'INCOME', 'termination.offset', '2026-03-31', 800_000, 'APPROVED', 'POSTED'],
  ['E1', 'D', 'INCOME', 'termination.extra_receipt', '2026-07-31', 100_000, 'APPROVED', 'POSTED', { inv: 'D3', room: 'D1' }],
  ['E2', 'D', 'INCOME', 'termination.extra_receipt', '2026-07-31', 50_000, 'APPROVED', 'UNPOSTED'],
  ['E4', 'D', 'INCOME', 'termination.extra_receipt', '2026-07-31', 500, 'APPROVED', 'POSTED', { room: 'D1' }],
  ['E5', 'D', 'INCOME', 'termination.extra_receipt', '2026-07-31', 9_000, 'UNAPPROVED', 'UNPOSTED', { inv: 'D3' }],
  ['rroD', 'D', 'EXPENSE', 'termination.rent_refund_offset', '2026-07-31', 20_000, 'APPROVED', 'POSTED'],
  ['offF', 'F', 'INCOME', 'termination.offset', '2026-06-30', 2_000_000, 'APPROVED', 'POSTED'],
  ['forG', 'G', 'INCOME', 'termination.forfeit_offset', '2026-06-15', 3_000_000, 'APPROVED', 'POSTED'],
  ['R1', 'R', 'EXPENSE', 'termination.refund', '2026-07-01', 1_900_000, 'APPROVED', 'POSTED'],
  ['R2', 'R', 'EXPENSE', 'termination.refund', '2026-07-02', 500_000, 'APPROVED', 'NOT_APPLICABLE'],
  ['R3', 'R', 'EXPENSE', 'termination.refund', '2026-07-03', 300_000, 'UNAPPROVED', 'UNPOSTED'],
  ['R4', 'R', 'EXPENSE', 'termination.refund', '2026-07-04', 999_000, 'CANCELLED', 'UNPOSTED'],
  ['R5', 'R', 'EXPENSE', 'termination.refund', '2026-07-05', 400_000, 'APPROVED', 'REVERSED'],
  ['R6', 'R', 'EXPENSE', 'termination.refund', '2026-07-06', 888_000, 'APPROVED', 'POSTED', { deleted: true }],
  ['R7', 'RB', 'EXPENSE', 'termination.refund', '2026-08-10', 700_000, 'APPROVED', 'POSTED'],
  ['DEP1', 'K', 'INCOME', 'contract.deposit', '2026-01-15', 100_000, 'APPROVED', 'POSTED'],
  ['DEP2', 'K', 'INCOME', 'contract.deposit', '2026-01-16', 100_000, 'APPROVED', 'POSTED'],
  ['DEP3', 'K', 'INCOME', 'contract.deposit', '2026-01-17', 100_000, 'APPROVED', 'POSTED'],
  ['DEP4', 'K', 'INCOME', 'contract.deposit', '2026-01-18', 100_000, 'APPROVED', 'POSTED'],
  ['K1', 'K', 'EXPENSE', null, '2026-02-01', 1_000_000, 'APPROVED', 'POSTED', { kind: 'broker' }], // lập tay, đã chi
  ['K2', 'K', 'EXPENSE', null, '2026-02-02', 900_000, 'UNAPPROVED', 'UNPOSTED', { typeOf: 'HHMG' }], // HHMG: kind NULL
  ['K3', 'K', 'EXPENSE', 'contract.commission', '2026-02-03', 800_000, 'APPROVED', 'REVERSED', { kind: 'broker' }],
  ['K4', 'K', 'EXPENSE', null, '2026-02-04', 700_000, 'APPROVED', 'NOT_APPLICABLE', { kind: 'broker' }],
  ['K5', 'K', 'EXPENSE', null, '2026-02-05', 600_000, 'APPROVED', 'UNPOSTED', { kind: 'sale' }],
  ['K6', 'K', 'EXPENSE', null, '2026-02-06', 500_000, 'APPROVED', 'POSTED', { kind: 'broker', active: false }],
  ['K7', null, 'EXPENSE', null, '2026-02-07', 400_000, 'APPROVED', 'POSTED', { kind: 'sale' }], // thưởng từ phiếu cọc
  ['K8', 'K', 'EXPENSE', null, '2026-02-08', 300_000, 'APPROVED', 'POSTED', { kind: 'sale' }], // gắn HĐ VÀ có claim
  ['K9', 'K', 'EXPENSE', null, '2026-02-09', 250_000, 'CANCELLED', 'UNPOSTED', { kind: 'broker' }],
  ['K10', 'K', 'EXPENSE', null, '2026-02-09', 240_000, 'APPROVED', 'POSTED', { kind: 'broker', deleted: true }],
  ['K11', 'K', 'INCOME', null, '2026-02-09', 230_000, 'APPROVED', 'POSTED', { kind: 'broker' }],
  ['K12', 'K', 'EXPENSE', null, '2026-02-09', 220_000, 'APPROVED', 'POSTED', { kind: 'broker', org: OTHER_ORG }],
  ['K13', 'K', 'EXPENSE', null, '2026-02-10', 200_000, 'APPROVED', 'POSTED', { kind: 'broker', dup: true }],
  ['K14', 'K', 'EXPENSE', null, '2026-02-10', 200_000, 'APPROVED', 'POSTED', { kind: 'broker', dup: true }],
  ['K15', 'K', 'EXPENSE', null, '2026-02-11', 150_000, 'APPROVED', 'POSTED', { typeOf: 'SUA' }], // không phải hoa hồng
  ['K16', null, 'EXPENSE', null, '2026-02-12', 140_000, 'CANCELLED', 'UNPOSTED', { kind: 'sale' }], // thưởng từ cọc đã huỷ
  // Hoàn trả thanh lý kiểu cũ: phiếu hoàn gắn hoá đơn tổng âm — invoice_direct_paid_v1 trừ nó khỏi hoá đơn.
  ['RL', 'L', 'EXPENSE', 'termination.refund', '2026-04-30', 2_800_000, 'APPROVED', 'POSTED',
    { inv: 'L2', notes: '[Hoàn trả thanh lý] Phiếu giả' }],
  ['DEP5', 'K', 'INCOME', 'contract.deposit', '2026-01-20', 50_000, 'APPROVED', 'POSTED'], // hai phiếu cọc cùng ngày
  ['DEP6', 'K', 'INCOME', 'contract.deposit', '2026-01-20', 60_000, 'APPROVED', 'POSTED'],
];
VOUCHERS.forEach(([label], i) => name(label, 701 + i));

// Dòng phiếu: [phiếu, accounting_class, tiền | null, đơn giá, số lượng, hạng mục]
const VOUCHER_ITEMS = [
  // Ba loại dòng của writer: hoàn cọc (DEPOSIT), hoàn tiền thừa (PNL), hoàn tiền phòng (legacy: accounting_class NULL).
  ['R1', 'DEPOSIT', 1_500_000], ['R1', 'PNL', 300_000], ['R1', null, 100_000],
  ['R2', 'DEPOSIT', null, 250_000, 2],
  ['R3', 'PNL', 200_000], ['R3', 'DEPOSIT', 100_000],
  ['R4', 'DEPOSIT', 999_000],
  ['R5', 'DEPOSIT', 400_000],
  ['R6', 'DEPOSIT', 888_000],
  ['R7', 'DEPOSIT', 700_000],
  ['RL', 'DEPOSIT', 2_800_000],
  ['K2', 'PNL', 900_000, null, null, 'HHMG'],
  ['K15', 'PNL', 150_000, null, null, 'SUA'],
];
const EXPENSE_TYPES = { HHMG: [u(801), 'HHMG', null], SUA: [u(802), 'Sửa điện', 'SỬA CHỮA'] };
// [phiếu thưởng, phiếu cọc, lúc tạo]
const CLAIMS = [['K7', 'DEP1', '2026-02-07T03:00:00Z'], ['K7', 'DEP2', '2026-02-07T02:00:00Z'], ['K8', 'DEP3', '2026-02-08T02:00:00Z'],
  ['K16', 'DEP4', '2026-02-12T02:00:00Z']];
// [HĐ, ngày, refund_amount, trạng thái, loại]
const TERMINATIONS = [
  ['A', '2026-03-31', 1_200_000, 'APPROVED', 'EARLY_TENANT'],
  ['G', '2026-06-15', 0, 'APPROVED', 'FORFEIT'],
  ['R', '2026-06-01', 1_000_000, 'COMPLETED', 'EARLY_TENANT'], // hiệu lực nhưng cũ hơn
  ['R', '2026-06-30', 2_000_000, 'APPROVED', 'EARLY_TENANT'], // hiệu lực mới nhất ⇒ "Phải hoàn cọc"
  ['R', '2026-07-15', 9_999_000, 'REJECTED', 'EARLY_TENANT'],
  ['R', '2026-07-20', null, 'PENDING', 'EARLY_TENANT'],
  ['RB', '2026-08-05', 700_000, 'PENDING', 'EARLY_TENANT'],
];
TERMINATIONS.forEach((_, i) => name(`TERM${i + 1}`, 601 + i)); // id cố định: meta terminationId nằm trong payload mẫu
// Gia hạn của HĐ A: [trạng thái, hạn cũ]. Hạn gốc = min trên APPROVED/COMPLETED.
const EXTENSIONS = [['APPROVED', '2026-09-30'], ['COMPLETED', '2026-06-30'], ['REJECTED', '2026-03-31'], ['PENDING', '2026-02-28']];

let db;
let before;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TYPE public.invoice_status AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','PAID','PARTIAL_PAID','OVERDUE','CANCELLED');
    CREATE TYPE public.invoice_item_type AS ENUM ('RENT','SERVICE','PENALTY','DISCOUNT','OTHER');
    CREATE TYPE public.payment_method AS ENUM ('TM','TK','TT','CT');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY, name text, organization_id uuid);
    CREATE TABLE public.rooms(id uuid PRIMARY KEY, name text, building_id uuid, deleted_at timestamptz);
    CREATE TABLE public.tenants(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.contracts(id uuid PRIMARY KEY, room_id uuid, tenant_id uuid, contract_number text, status text,
      start_date date, end_date date, actual_end_date date, rent_price numeric, total_deposit numeric, deleted_at timestamptz);
    CREATE TABLE public.contract_transfers(id uuid PRIMARY KEY, contract_id uuid, status text, old_room_id uuid, new_room_id uuid,
      move_out_date date, transfer_date date);
    CREATE TABLE public.contract_extensions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid, old_end_date date,
      new_end_date date, status text);
    CREATE TABLE public.contract_terminations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid, termination_date date,
      created_at timestamptz DEFAULT now(), refund_amount numeric(15,2), status text, termination_type text);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, room_id uuid, kind text NOT NULL DEFAULT 'MONTHLY',
      billing_month text, issue_date date, status public.invoice_status, total_amount numeric(15,2), paid_amount numeric(15,2) DEFAULT 0,
      remaining_amount numeric(15,2) GENERATED ALWAYS AS (total_amount - COALESCE(paid_amount, 0)) STORED, paid_date date,
      previous_debt numeric(15,2) NOT NULL DEFAULT 0, previous_debt_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      discount_amount numeric(15,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL, updated_at timestamptz, deleted_at timestamptz);
    CREATE TABLE public.services(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.invoice_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id uuid, type public.invoice_item_type,
      accounting_class text NOT NULL DEFAULT 'REVENUE', amount numeric(15,2), description text, service_id uuid);
    CREATE TABLE public.payments(id uuid PRIMARY KEY, invoice_id uuid, amount numeric(15,2), received_amount numeric(15,2),
      payment_method public.payment_method, payment_date date, reversed_at timestamptz, notes text);
    CREATE TABLE public.income_expenses(id uuid PRIMARY KEY, organization_id uuid, contract_id uuid, room_id uuid, invoice_id uuid,
      type text, code text, name text, voucher_date date, total_amount numeric(15,2), approval_status text, posting_status text,
      active_posting_id_v2 uuid, system_source text, commission_kind text, commission_legacy_dup boolean NOT NULL DEFAULT false,
      payment_collection_id uuid, notes text, deleted_at timestamptz);
    CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY, name text, category text);
    CREATE TABLE public.income_expense_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), income_expense_id uuid,
      income_expense_type_id uuid, accounting_class text, amount numeric(15,2), unit_price numeric(15,2), quantity numeric);
    CREATE TABLE app_private.sale_bonus_claims(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
      deposit_voucher_id uuid, contract_id uuid, bonus_voucher_id uuid, created_at timestamptz NOT NULL);
    CREATE TABLE app_private.termination_forfeit_authorizations(revenue_voucher_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_id uuid UNIQUE, contract_id uuid, invoice_id uuid);
    -- Đoạn cư trú giả theo khuôn hàm thật (sự kiện tiền không phụ thuộc đoạn; payload mẫu của client cần đủ đoạn):
    -- không chuyển phòng ⇒ một đoạn ở phòng hiện tại từ start_date; có chuyển (fixture: một lượt) ⇒ đoạn 0 ở phòng
    -- cũ, mốc vào NULL như hàm thật, tới ngày chuyển; đoạn 1 ở phòng mới từ ngày chuyển.
    CREATE FUNCTION public.get_room_residence_segments_v1(uuid[]) RETURNS TABLE(contract_id uuid, contract_number text, room_id uuid,
      seg_index integer, from_date date, to_date date, source_path text, trusted boolean, diagnostic text)
      LANGUAGE sql STABLE AS $$
        SELECT c.id, c.contract_number, COALESCE(t.old_room_id, c.room_id), 0, CASE WHEN t.id IS NULL THEN c.start_date END,
               COALESCE(t.move_out_date, t.transfer_date), 'CONTRACT_START', true, NULL::text
          FROM public.contracts c
          LEFT JOIN public.contract_transfers t ON t.contract_id = c.id AND t.status IN ('APPROVED', 'COMPLETED')
         WHERE c.id = ANY ($1)
        UNION ALL
        SELECT c.id, c.contract_number, t.new_room_id, 1, t.transfer_date, NULL::date, 'TRIGGER_APPROVED', true, NULL::text
          FROM public.contracts c JOIN public.contract_transfers t ON t.contract_id = c.id AND t.status IN ('APPROVED', 'COMPLETED')
         WHERE c.id = ANY ($1) $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-10-29' $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_do_on_building(text, text, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.super', true) = 'true' $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.is_super_admin() $$;
    GRANT USAGE ON SCHEMA public, auth, app_private TO authenticated;`);
  for (const fnName of REUSED) await db.exec(liveDefinitionOf(fnName).sql);

  await db.query(`INSERT INTO buildings VALUES ($1, 'Toà giả', $2)`, [BUILDING, ORG]);
  for (const [key, id] of Object.entries(ROOM)) await db.query(`INSERT INTO rooms VALUES ($1, $2, $3, null)`, [id, `P-${key}`, BUILDING]);
  await db.query(`INSERT INTO tenants VALUES ($1, 'Khách Giả')`, [TENANT]);
  for (const [label, room, status, start, end, actualEnd] of CONTRACTS) {
    await db.query(`INSERT INTO contracts VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 3000000, 2000000, null)`,
      [idOf(label), ROOM[room], TENANT, `HD-GIA-${label}`, status, start, end, actualEnd]);
  }
  await db.query(`INSERT INTO contract_transfers VALUES ($1, $2, 'APPROVED', $3, $4, DATE '2026-06-01', DATE '2026-06-01')`,
    [u(199), idOf('D'), ROOM.D1, ROOM.D2]);
  for (const [status, oldEnd] of EXTENSIONS) {
    await db.query(`INSERT INTO contract_extensions(contract_id, old_end_date, new_end_date, status) VALUES ($1, $2, DATE '2026-12-31', $3)`,
      [idOf('A'), oldEnd, status]);
  }
  for (const [index, [label, date, refund, status, type]] of TERMINATIONS.entries()) {
    await db.query(`INSERT INTO contract_terminations(id, contract_id, termination_date, refund_amount, status, termination_type)
      VALUES ($1, $2, $3, $4, $5, $6)`, [idOf(`TERM${index + 1}`), idOf(label), date, refund, status, type]);
  }
  for (const [index, [label, hd, room, month, status, total, paid, x = {}]] of INVOICES.entries()) {
    await db.query(`INSERT INTO invoices(id, organization_id, contract_id, room_id, kind, billing_month, issue_date, status, total_amount,
        paid_amount, paid_date, previous_debt, previous_debt_sources, created_at, updated_at, deleted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::public.invoice_status, $9, $10, $11, $12, $13::jsonb,
        timestamptz '2026-01-01 00:00+07' + make_interval(hours => $14::int), COALESCE($15::timestamptz, now()), $16)`,
      [idOf(label), ORG, idOf(hd), ROOM[room], x.kind ?? 'MONTHLY', month, x.issue ?? `${month}-01`, status, total, paid,
        x.paidDate ?? null, x.prev ?? 0, JSON.stringify((x.src ?? []).map(([s, a]) => ({ type: 'invoice', id: idOf(s), amount: a, label: 'nợ kỳ trước' }))),
        index, x.updatedAt ?? null, x.deleted ? '2026-10-01T00:00:00Z' : null]);
  }
  for (const [inv, type, cls, amount, desc = null] of INVOICE_ITEMS) {
    await db.query(`INSERT INTO invoice_items(invoice_id, type, accounting_class, amount, description) VALUES ($1, $2::public.invoice_item_type, $3, $4, $5)`,
      [idOf(inv), type, cls, amount, desc]);
  }
  for (const [label, inv, amount, received, method, date, x = {}] of PAYMENTS) {
    await db.query(`INSERT INTO payments VALUES ($1, $2, $3, $4, $5::public.payment_method, $6, $7, $8)`,
      [idOf(label), idOf(inv), amount, received, method, date, x.reversed ? '2026-01-10T00:00:00Z' : null,
        x.forfeit ? `[CẤN CỌC BỎ CỌC PAYMENT ${idOf('forG')}]` : x.notes ?? null]);
    if (x.forfeit) {
      await db.query(`INSERT INTO app_private.termination_forfeit_authorizations(revenue_voucher_id, payment_id, contract_id, invoice_id)
        VALUES ($1, $2, $3, $4)`, [idOf('forG'), idOf(label), idOf('G'), idOf(inv)]);
    }
  }
  for (const [id, label, category] of Object.values(EXPENSE_TYPES)) {
    await db.query(`INSERT INTO income_expense_types VALUES ($1, $2, $3)`, [id, label, category]);
  }
  for (const [index, [label, hd, type, source, date, total, approval, posting, x = {}]] of [...VOUCHERS.entries()].reverse()) {
    await db.query(`INSERT INTO income_expenses(id, organization_id, contract_id, room_id, invoice_id, type, code, name, voucher_date,
        total_amount, approval_status, posting_status, active_posting_id_v2, system_source, commission_kind, commission_legacy_dup,
        notes, deleted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [idOf(label), x.org ?? ORG, hd ? idOf(hd) : null, x.room ? ROOM[x.room] : null, x.inv ? idOf(x.inv) : null, type,
        `PC-GIA-${label}`, `Phiếu giả ${label}`, date, total, approval, posting,
        posting === 'POSTED' && x.active !== false ? u(9001 + index) : null, source, x.kind ?? null, x.dup ?? false,
        x.notes ?? null, x.deleted ? '2026-10-01T00:00:00Z' : null]);
  }
  for (const [ie, cls, amount, unitPrice = null, quantity = null, typeKey = null] of VOUCHER_ITEMS) {
    await db.query(`INSERT INTO income_expense_items(income_expense_id, income_expense_type_id, accounting_class, amount, unit_price, quantity)
      VALUES ($1, $2, $3, $4, $5, $6)`, [idOf(ie), typeKey ? EXPENSE_TYPES[typeKey][0] : null, cls, amount, unitPrice, quantity]);
  }
  for (const [bonus, deposit, at] of CLAIMS) {
    await db.query(`INSERT INTO app_private.sale_bonus_claims(organization_id, deposit_voucher_id, bonus_voucher_id, created_at)
      VALUES ($1, $2, $3, $4)`, [ORG, idOf(deposit), idOf(bonus), at]);
  }

  // Chuỗi thân sống: witness 20260921085952 → vá 20261018052932 → file mới hai lượt (idempotent).
  await db.exec(rpcBodyOf(OLD));
  await db.exec(`GRANT EXECUTE ON FUNCTION ${SIG}(uuid,date,date) TO authenticated, service_role`);
  await db.exec(FIX);
  before = await tx(() => rpc(ROOM.A));
  await db.exec(NEW);
  await db.exec(NEW);
}, 60_000);
afterAll(async () => { await db?.close(); });

async function tx(fn) {
  await db.exec('BEGIN');
  try { return await fn(); } finally { await db.exec('ROLLBACK'); }
}
// Gọi RPC như người dùng đã đăng nhập (super admin giả — cửa quyền đã có test riêng ở module-key).
async function rpc(roomId, from = null, to = null) {
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('test.super', 'true', true)`, [VIEWER]);
  await db.exec('SET LOCAL ROLE authenticated');
  try {
    const { rows } = await db.query(`SELECT ${SIG}($1, $2, $3) AS out`, [roomId, from, to]);
    return rows[0].out;
  } finally { await db.exec('RESET ROLE'); }
}
const call = (roomId, from, to) => tx(() => rpc(roomId, from, to));

// Thu gọn payload để so: sự kiện (bỏ đoạn cư trú — fixture giả) thành một dòng chữ, HĐ thành {originalEndDate, money}.
const SEGMENT_EVENTS = new Set(['CONTRACT_OPENED', 'CONTRACT_CLOSED', 'ROOM_CHANGED_IN', 'ROOM_CHANGED_OUT']);
function observe(out) {
  return {
    events: out.events.filter((e) => !SEGMENT_EVENTS.has(e.type)).map((e) => {
      const ref = e.meta?.voucherId ?? e.meta?.invoiceId;
      return [e.date, e.type, LABEL.get(e.contractId), e.amount ?? '-', e.trusted ? 'T' : 'F', ...(ref ? [LABEL.get(ref)] : [])].join(' ');
    }),
    contracts: Object.fromEntries(out.contracts.map((c) => [LABEL.get(c.id), { originalEndDate: c.originalEndDate, money: c.money }])),
  };
}
const M = (issued, paidCash, offset, debt, overpaid, invoiceCount, roomCount, depositOnInvoices) =>
  ({ issued, paidCash, offset, debt, overpaid, invoiceCount, roomCount, depositOnInvoices });
const ZERO = M(0, 0, 0, 0, 0, 0, 0, 0);
const refund = (depositDue, depositPaid, depositOnVouchers, otherDue, otherPaid, owed, offbook, warnings = []) =>
  ({ depositDue, depositPaid, depositOnVouchers, otherDue, otherPaid, owed, offbook, warnings });

const D_CONTRACT = M(5_200_000, 4_650_500, 549_500, 0, 0, 3, 2, 0);
const EXPECT = {
  A: {
    events: [
      '2025-12-28 DEPOSIT_RECEIVED A 2000000 T depA',
      '2026-01-01 INVOICE_ISSUED A 3000000 T A1',
      '2026-01-07 INVOICE_COLLECTION_POSTED A 3000000 T A1',
      '2026-02-01 INVOICE_ISSUED A 3000000 T A2',
      '2026-02-05 INVOICE_COLLECTION_POSTED A 2700000 T A2',
      '2026-03-01 INVOICE_ISSUED A 3000000 T A3',
      '2026-03-05 INVOICE_COLLECTION_POSTED A 1000000 T A3',
      '2026-03-31 INVOICE_ISSUED A 500000 T A4',
      '2026-03-31 INVOICE_TERMINATION_OFFSET A 300000 T A2',
      '2026-03-31 INVOICE_TERMINATION_OFFSET A 500000 T A4',
      '2026-03-31 SETTLEMENT_OFFSET_POSTED A 800000 T offA',
      '2026-03-31 TERMINATION_REQUESTED A 1200000 T',
    ],
    contracts: { A: { originalEndDate: '2026-06-30', money: {
      contract: M(9_500_000, 6_700_000, 800_000, 2_000_000, 0, 4, 1, 0), room: M(9_500_000, 6_700_000, 800_000, 2_000_000, 0, 4, 1, 0),
      refund: refund(1_200_000, 0, 0, 0, 0, 1_200_000, 0) } } },
  },
  B: {
    events: [
      '2026-05-01 INVOICE_ISSUED B 1000000 T B1',
      '2026-06-01 INVOICE_ISSUED B 1100000 T B2',
      '2026-07-01 INVOICE_ISSUED B 1200000 T B3',
      '2026-08-01 INVOICE_ISSUED B 1300000 T B4',
      '2026-09-01 INVOICE_ISSUED B 1500000 T B5',
      '2026-10-01 INVOICE_ISSUED B 1200000 T B6',
    ],
    contracts: { B: { originalEndDate: null, money: {
      contract: M(7_300_000, 0, 0, 7_300_000, 0, 6, 1, 0), room: M(7_300_000, 0, 0, 7_300_000, 0, 6, 1, 0), refund: null } } },
  },
  C: {
    events: [
      '2026-05-01 INVOICE_ISSUED C 2000000 T C1',
      '2026-05-05 INVOICE_COLLECTION_POSTED C 1000000 T C1',
      '2026-06-01 INVOICE_ISSUED C 2000000 T C2',
      '2026-06-05 INVOICE_COLLECTION_POSTED C 3000000 T C2',
      '2026-07-01 INVOICE_COLLECTION_POSTED C 3000000 T C3',
      '2026-07-01 INVOICE_ISSUED C 3000000 T C3',
      '2026-08-01 INVOICE_ISSUED C 3000000 T C4',
      '2026-09-01 INVOICE_ISSUED C 3005000 T C5',
      '2026-09-05 INVOICE_COLLECTION_POSTED C 3000000 T C5',
      '2026-10-01 INVOICE_ISSUED C 2000000 T C6',
      '2026-10-05 INVOICE_COLLECTION_POSTED C 2000500 T C6',
    ],
    contracts: { C: { originalEndDate: null, money: {
      contract: M(15_005_000, 12_000_500, 0, 2_999_500, 0, 6, 1, 4_000_000),
      room: M(15_005_000, 12_000_500, 0, 2_999_500, 0, 6, 1, 4_000_000), refund: null } } },
  },
  D1: {
    events: [
      '2026-05-01 INVOICE_ISSUED D 2000000 T D1',
      '2026-05-05 INVOICE_COLLECTION_POSTED D 2000000 T D1',
      '2026-07-31 TERMINATION_EXTRA_RECEIPT_POSTED D 500 T E4',
      '2026-07-31 TERMINATION_REFUND_OFFSET_POSTED D 20000 T rroD',
    ],
    contracts: { D: { originalEndDate: null, money: { contract: D_CONTRACT, room: M(2_000_000, 2_000_500, 0, 0, 0, 1, 1, 0), refund: null } } },
  },
  D2: {
    events: [
      '2026-06-01 INVOICE_ISSUED D 2500000 T D2',
      '2026-06-05 INVOICE_COLLECTION_POSTED D 2500000 T D2',
      '2026-07-31 INVOICE_ISSUED D 700000 T D3',
      '2026-07-31 INVOICE_TERMINATION_OFFSET D 700000 T D3',
      '2026-07-31 TERMINATION_EXTRA_RECEIPT_POSTED D 100000 T E1',
      '2026-07-31 TERMINATION_EXTRA_RECEIPT_POSTED D 50000 F E2',
      '2026-07-31 TERMINATION_REFUND_OFFSET_POSTED D 20000 T rroD',
    ],
    contracts: { D: { originalEndDate: null, money: { contract: D_CONTRACT, room: M(3_200_000, 2_650_000, 550_000, 0, 0, 2, 1, 0), refund: null } } },
  },
  F: {
    events: [
      '2026-05-01 INVOICE_ISSUED F 1000000 T F1',
      '2026-06-01 INVOICE_ISSUED F 1000000 T F2',
      '2026-06-30 INVOICE_TERMINATION_OFFSET F 1000000 T F1',
      '2026-06-30 INVOICE_TERMINATION_OFFSET F 2000000 T F2',
      '2026-06-30 SETTLEMENT_OFFSET_POSTED F 2000000 T offF',
    ],
    contracts: { F: { originalEndDate: null, money: {
      contract: M(2_000_000, 0, 3_000_000, 0, 0, 2, 1, 0), room: M(2_000_000, 0, 3_000_000, 0, 0, 2, 1, 0), refund: null } } },
  },
  G: {
    events: [
      '2026-05-01 INVOICE_ISSUED G 1500000 T G1',
      '2026-05-05 INVOICE_COLLECTION_POSTED G 1500000 T G1',
      '2026-06-01 INVOICE_ISSUED G 1000000 T G4',
      '2026-06-01 INVOICE_ISSUED G 1000000 T G5',
      '2026-06-05 INVOICE_COLLECTION_POSTED G 1000000 T G4',
      '2026-06-05 INVOICE_COLLECTION_POSTED G 1000000 T G5',
      '2026-06-15 DEPOSIT_FORFEIT_POSTED G 3000000 T forG',
      '2026-06-15 INVOICE_ISSUED G 3000000 T G3',
      '2026-06-15 INVOICE_TERMINATION_OFFSET G 3000000 T G3',
      '2026-06-15 TERMINATION_REQUESTED G 0 T',
    ],
    // Huỷ khi bỏ cọc: phát sinh = tiền đã thu (không âm, không trừ nợ kéo); G5 thu vượt dòng doanh thu 500.000 ⇒ cọc.
    contracts: { G: { originalEndDate: null, money: {
      contract: M(6_500_000, 3_500_000, 3_000_000, 0, 0, 4, 1, 500_000), room: M(6_500_000, 3_500_000, 3_000_000, 0, 0, 4, 1, 500_000),
      refund: refund(0, 0, 0, 0, 0, 0, 0) } } },
  },
  L: {
    // Hoá đơn tổng âm vắng: khoản trả khách chỉ ở phiếu hoàn (một lần), "khách đã nộp" không bị trừ.
    events: [
      '2026-03-01 INVOICE_ISSUED L 2000000 T L1',
      '2026-03-05 INVOICE_COLLECTION_POSTED L 2000000 T L1',
      '2026-04-30 DEPOSIT_REFUND_POSTED L 2800000 T RL',
    ],
    contracts: { L: { originalEndDate: null, money: {
      contract: M(2_000_000, 2_000_000, 0, 0, 0, 1, 1, 0), room: M(2_000_000, 2_000_000, 0, 0, 0, 1, 1, 0),
      refund: refund(null, 2_800_000, 2_800_000, 0, 0, null, 0, ['NO_EFFECTIVE_TERMINATION']) } } },
  },
  P: {
    // Dòng cọc tất toán bằng cấn trừ / hoá đơn gánh: không thành thu dư ảo, không che nợ thật của kỳ sau.
    events: [
      '2026-05-01 INVOICE_ISSUED P1 1000000 T P1a',
      '2026-06-30 INVOICE_TERMINATION_OFFSET P1 1000000 T P1a',
      '2026-07-01 INVOICE_ISSUED P6 1000000 T P6a',
      '2026-08-01 INVOICE_ISSUED P6 2000000 T P6b',
      '2026-08-31 INVOICE_TERMINATION_OFFSET P6 500000 T P6a',
      '2026-09-01 INVOICE_ISSUED P2 1000000 T P2a',
      '2026-10-01 INVOICE_ISSUED P2 1000000 T P2b',
      '2026-10-05 INVOICE_COLLECTION_POSTED P2 2000000 T P2b',
    ],
    contracts: {
      P1: { originalEndDate: null, money: { contract: M(1_000_000, 0, 1_000_000, 0, 0, 1, 1, 3_000_000),
        room: M(1_000_000, 0, 1_000_000, 0, 0, 1, 1, 3_000_000), refund: null } },
      P6: { originalEndDate: null, money: { contract: M(3_000_000, 0, 500_000, 2_500_000, 0, 2, 1, 3_000_000),
        room: M(3_000_000, 0, 500_000, 2_500_000, 0, 2, 1, 3_000_000), refund: null } },
      P2: { originalEndDate: null, money: { contract: M(2_000_000, 2_000_000, 0, 0, 0, 2, 1, 3_000_000),
        room: M(2_000_000, 2_000_000, 0, 0, 0, 2, 1, 3_000_000), refund: null } },
    },
  },
  R: {
    events: [
      '2026-06-01 TERMINATION_REQUESTED R 1000000 T',
      '2026-06-30 TERMINATION_REQUESTED R 2000000 T',
      '2026-07-01 CUSTOMER_REFUND_POSTED R 400000 T R1',
      '2026-07-01 DEPOSIT_REFUND_POSTED R 1500000 T R1',
      '2026-07-02 DEPOSIT_REFUND_POSTED R 500000 F R2',
      '2026-07-15 TERMINATION_REQUESTED R 9999000 F',
      '2026-07-20 TERMINATION_REQUESTED R - F',
      '2026-08-05 TERMINATION_REQUESTED RB 700000 F',
      '2026-08-10 DEPOSIT_REFUND_POSTED RB 700000 T R7',
    ],
    contracts: {
      // Phải hoàn = refund_amount của thanh lý hiệu lực mới nhất; dòng cọc trên phiếu lệch ⇒ chỉ cảnh báo.
      R: { originalEndDate: null, money: { contract: ZERO, room: ZERO,
        refund: refund(2_000_000, 2_000_000, 2_500_000, 600_000, 400_000, 200_000, 500_000, ['DEPOSIT_LINE_MISMATCH']) } },
      RB: { originalEndDate: null, money: { contract: ZERO, room: ZERO,
        refund: refund(null, 700_000, 700_000, 0, 0, null, 0, ['NO_EFFECTIVE_TERMINATION']) } },
    },
  },
  K: {
    events: [
      '2026-01-15 DEPOSIT_RECEIVED K 100000 T DEP1',
      '2026-01-16 DEPOSIT_RECEIVED K 100000 T DEP2',
      '2026-01-17 DEPOSIT_RECEIVED K 100000 T DEP3',
      '2026-01-18 DEPOSIT_RECEIVED K 100000 T DEP4',
      '2026-01-20 DEPOSIT_RECEIVED K 50000 T DEP5',
      '2026-01-20 DEPOSIT_RECEIVED K 60000 T DEP6',
      '2026-02-01 COMMISSION_PAID K 1000000 T K1',
      '2026-02-02 COMMISSION_PENDING K 900000 F K2',
      '2026-02-03 COMMISSION_REVERSED K 800000 F K3',
      '2026-02-04 COMMISSION_OFFBOOK K 700000 F K4',
      '2026-02-05 SALE_BONUS_UNPOSTED K 600000 F K5',
      '2026-02-06 COMMISSION_UNPOSTED K 500000 F K6',
      '2026-02-07 SALE_BONUS_PAID K 400000 T K7',
      '2026-02-08 SALE_BONUS_PAID K 300000 T K8',
      '2026-02-10 COMMISSION_PAID K 200000 T K13',
      '2026-02-10 COMMISSION_PAID K 200000 T K14',
    ],
    contracts: { K: { originalEndDate: null, money: { contract: ZERO, room: ZERO, refund: null } } },
  },
};

// Hành vi gom lại để đột biến dùng chung: phòng nào lệch kỳ vọng.
async function behaviour() {
  const bad = [];
  for (const [room, want] of Object.entries(EXPECT)) {
    if (!isDeepStrictEqual(observe(await rpc(ROOM[room])), want)) bad.push(room);
  }
  return bad;
}
async function witness() {
  const { rows: [fn] } = await db.query(`SELECT md5(pg_get_functiondef(p.oid)) AS md5, pg_get_userbyid(p.proowner) AS owner,
      p.proacl::text AS acl FROM pg_proc p WHERE p.oid = to_regprocedure('${SIG}(uuid,date,date)')`);
  const helpers = {};
  for (const sig of HELPERS) {
    const { rows: [h] } = await db.query(`SELECT p.prosecdef, p.provolatile, p.proconfig, p.proacl::text AS acl,
        pg_get_userbyid(p.proowner) AS owner,
        p.prosrc ~* '\\mfor\\s+(update|no\\s+key\\s+update|share|key\\s+share)\\M|\\mlock\\M' AS locks,
        has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE') AS client
      FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig]);
    helpers[sig] = h;
  }
  return { rpc: fn, helpers };
}
const HELPER_WITNESS = { prosecdef: false, provolatile: 's', proconfig: ['search_path=""'], acl: '{postgres=X/postgres}', owner: 'postgres',
  locks: false, client: false };

test('witness: thân mới chạy hai lượt; md5/owner/ACL khớp after; helper INVOKER/STABLE/search_path rỗng, không cho client, không khoá dòng', async () => {
  const w = await witness();
  expect(w.rpc).toEqual(RPC_AFTER);
  for (const sig of HELPERS) expect(w.helpers[sig], sig).toEqual(HELPER_WITNESS);
  // Người dùng không gọi thẳng được helper (chỉ RPC DEFINER owner postgres gọi).
  await expect(tx(async () => {
    await db.exec('SET LOCAL ROLE authenticated');
    await db.query(`SELECT * FROM app_private.invoice_lifecycle_parts_v1('{}'::uuid[])`);
  })).rejects.toMatchObject({ code: '42501' });
  // Sổ retirement: forward succession kế tiếp của hàm này phải nối đúng chuỗi md5 (khai sau khi apply).
  const group = POLICY.idempotencyRetirements.find((g) => g.id === 'restore-before-contract-settlement-2026-09-21');
  const mine = group.forwardSuccessions.find((s) => s.file === NEW_FILE);
  if (mine) {
    expect(mine.sha256).toBe(createHash('sha256').update(NEW).digest('hex'));
    expect(mine.functions).toEqual([{ signature: `${SIG}(uuid,date,date)`, before: RPC_BEFORE, after: RPC_AFTER }]);
  }
});

test('chốt đầu: từ chối thân RPC lạ và thiếu nguồn dùng chung', async () => {
  await expect(tx(async () => {
    await db.exec(createOf(NEW, SIG).replace('v_today := public.org_today_v1', '-- lạ\n  v_today := public.org_today_v1'));
    await db.exec(NEW);
  })).rejects.toThrow(/chot: get_room_cash_lifecycle_v1 da bi doi/);
  await expect(tx(async () => {
    await db.exec('ALTER TABLE public.contract_extensions RENAME TO contract_extensions_x');
    await db.exec(NEW);
  })).rejects.toThrow(/chot: thieu ham\/bang nguon dung chung/);
});

test('TRƯỚC (thân 20261018052932): COLLECTION là paid_amount — gồm cấn trừ, ngày trôi theo paid_date/updated_at', () => {
  // Thân cũ chỉ xếp (date, type): hai dòng cùng ngày không tất định ⇒ so sau khi sắp.
  const coll = before.events.filter((e) => e.type === 'INVOICE_COLLECTION_POSTED').map((e) => `${e.date} ${e.amount} ${e.meta.billingMonth}`);
  expect(coll.sort()).toEqual(['2026-01-07 3000000 2026-01', '2026-03-25 1000000 2026-03', '2026-03-31 3000000 2026-02', '2026-03-31 500000 2026-03']);
});

for (const room of Object.keys(EXPECT)) {
  test(`phòng ${room}: sự kiện tiền và contracts[].money đúng một nguồn`, async () => {
    expect(observe(await call(ROOM[room]))).toEqual(EXPECT[room]);
  });
}

test('meta hoá đơn: phát sinh mới, nợ kéo, cọc, cấn trừ, ngày thu thật', async () => {
  const issued = {};
  const others = {};
  for (const room of ['A', 'B', 'C', 'D2', 'G', 'P']) {
    for (const e of (await call(ROOM[room])).events) {
      if (e.type === 'INVOICE_ISSUED') issued[LABEL.get(e.meta.invoiceId)] = e.meta;
      else if (e.meta?.invoiceId) others[`${e.type}:${LABEL.get(e.meta.invoiceId)}`] = e.meta;
    }
  }
  const id = (label) => idOf(label);
  expect(issued.B4).toEqual({ invoiceId: id('B4'), billingMonth: '2026-08', status: 'APPROVED', kind: 'MONTHLY', total: 4_600_000,
    carriedIn: 3_300_000, depositPart: 0, penalty: 0, outstanding: 1_300_000, carriedOpen: 0, carriedPaid: 0, sourceInvoiceIds: [id('B3')] });
  expect(issued.B1).toMatchObject({ carriedIn: 0, outstanding: 1_000_000, carriedOpen: 1_000_000, sourceInvoiceIds: [] });
  expect(issued.B5).toMatchObject({ carriedIn: 0, total: 1_500_000, sourceInvoiceIds: [] }); // không khai nguồn ⇒ là phát sinh mới
  expect(issued.B6).toMatchObject({ carriedIn: 0, sourceInvoiceIds: [] }); // nguồn đã xoá ⇒ không thuộc tập
  expect(issued.C1).toMatchObject({ status: 'PAID', carriedPaid: 1_000_000, outstanding: 0 });
  expect(issued.C2).toMatchObject({ carriedIn: 1_000_000, sourceInvoiceIds: [id('C1')] });
  expect(issued.C3).toMatchObject({ depositPart: 3_000_000, outstanding: 0 });
  expect(others['INVOICE_COLLECTION_POSTED:C3']).toEqual({ invoiceId: id('C3'), billingMonth: '2026-07', kind: 'MONTHLY', depositPaid: 3_000_000 });
  expect(issued.C4).toMatchObject({ depositPart: 1_000_000, outstanding: 3_000_000 });
  expect(issued.C5).toMatchObject({ status: 'PAID', outstanding: 0 });
  expect(issued.C6).toMatchObject({ outstanding: -500 });
  expect(issued.A4).toMatchObject({ kind: 'SETTLEMENT', penalty: 200_000, outstanding: 0 });
  expect(others['INVOICE_TERMINATION_OFFSET:A4']).toEqual({ invoiceId: id('A4'), billingMonth: '2026-03', kind: 'SETTLEMENT', via: 'MOVE_OUT', penalty: 200_000,
    depositOffset: 0 });
  expect(others['INVOICE_TERMINATION_OFFSET:A2']).toMatchObject({ kind: 'MONTHLY', via: 'MOVE_OUT', penalty: 0 });
  expect(others['INVOICE_TERMINATION_OFFSET:G3']).toMatchObject({ via: 'FORFEIT', penalty: 3_000_000 });
  expect(issued.D3).toMatchObject({ kind: 'SETTLEMENT', outstanding: 0 });
  // Huỷ khi bỏ cọc (total ghi đè = đã thu, dòng gốc còn cọc / nợ kéo): phát sinh = tiền đã thu, doanh thu trước.
  expect(issued.G1).toMatchObject({ status: 'CANCELLED', total: 1_500_000, carriedIn: 0, depositPart: 0, outstanding: 0 });
  expect(others['INVOICE_COLLECTION_POSTED:G1']).toMatchObject({ depositPaid: 0 });
  expect(issued.G4).toMatchObject({ status: 'CANCELLED', total: 1_000_000, carriedIn: 0, sourceInvoiceIds: [id('G1')] });
  expect(issued.G5).toMatchObject({ total: 1_500_000, depositPart: 500_000 });
  expect(others['INVOICE_COLLECTION_POSTED:G5']).toMatchObject({ depositPaid: 500_000 });
  // Dòng cọc tất toán không bằng tiền thật: không còn "cọc chưa thu" ⇒ không thu dư ảo, nợ thật kỳ sau còn nguyên.
  expect(issued.P1a).toMatchObject({ status: 'PAID', depositPart: 3_000_000, outstanding: 0 });
  expect(others['INVOICE_TERMINATION_OFFSET:P1a']).toMatchObject({ via: 'MOVE_OUT', depositOffset: 3_000_000 });
  expect(issued.P6a).toMatchObject({ status: 'PARTIAL_PAID', depositPart: 3_000_000, outstanding: 500_000 });
  expect(others['INVOICE_TERMINATION_OFFSET:P6a']).toMatchObject({ depositOffset: 3_000_000 });
  expect(issued.P6b).toMatchObject({ outstanding: 2_000_000 });
  expect(issued.P2a).toMatchObject({ depositPart: 3_000_000, carriedPaid: 2_000_000, outstanding: 0 });
  expect(others['INVOICE_COLLECTION_POSTED:P2a']).toBeUndefined(); // 2.000.000 tiền thật đều vào dòng cọc
  expect(issued.P2b).toMatchObject({ carriedIn: 2_000_000, depositPart: 0, sourceInvoiceIds: [id('P2a')] });
  expect(others['INVOICE_COLLECTION_POSTED:P2b']).toMatchObject({ depositPaid: 1_000_000 }); // phần cọc P2a do P2b trả hộ
});

test('meta phiếu: khách trả thêm, hoàn cọc/ trả khách, hoa hồng', async () => {
  const meta = {};
  for (const room of ['D2', 'R', 'K']) {
    for (const e of (await call(ROOM[room])).events) if (e.meta?.voucherId) meta[`${e.type}:${LABEL.get(e.meta.voucherId)}`] = e.meta;
  }
  expect(meta['TERMINATION_EXTRA_RECEIPT_POSTED:E1']).toEqual({ voucherId: idOf('E1'), code: 'PC-GIA-E1', invoiceId: idOf('D3'), billingMonth: '2026-07' });
  expect(meta['TERMINATION_EXTRA_RECEIPT_POSTED:E2']).toEqual({ voucherId: idOf('E2'), code: 'PC-GIA-E2', invoiceId: null, billingMonth: null });
  expect(meta['DEPOSIT_REFUND_POSTED:R1']).toEqual({ code: 'PC-GIA-R1', voucherId: idOf('R1'), offbook: false });
  expect(meta['DEPOSIT_REFUND_POSTED:R2']).toEqual({ code: 'PC-GIA-R2', voucherId: idOf('R2'), offbook: true });
  expect(meta['SALE_BONUS_PAID:K7']).toEqual({ voucherId: idOf('K7'), code: 'PC-GIA-K7', name: 'Phiếu giả K7', kind: 'sale', link: 'deposit_claim',
    stage: 'PAID', approvalStatus: 'APPROVED', postingStatus: 'POSTED', legacyDup: false });
  expect(meta['SALE_BONUS_PAID:K8']).toMatchObject({ link: 'direct', kind: 'sale' });
  expect(meta['COMMISSION_PENDING:K2']).toMatchObject({ kind: 'broker', link: 'direct', approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED' });
  expect(meta['COMMISSION_UNPOSTED:K6']).toMatchObject({ stage: 'UNPOSTED', postingStatus: 'POSTED' });
  expect([meta['COMMISSION_PAID:K13'].legacyDup, meta['COMMISSION_PAID:K14'].legacyDup, meta['COMMISSION_PAID:K1'].legacyDup]).toEqual([true, true, false]);
});

test('bất biến một nguồn (range null): Σ sự kiện = money.room; các phòng cộng lại = money.contract', async () => {
  const sum = (events, type, pick = (e) => e.amount) => events.filter((e) => e.type === type).reduce((s, e) => s + pick(e), 0);
  const byContract = new Map();
  for (const room of Object.keys(EXPECT)) {
    const out = await call(ROOM[room]);
    for (const c of out.contracts) {
      const ev = out.events.filter((e) => e.contractId === c.id);
      const r = c.money.room;
      const outstanding = sum(ev, 'INVOICE_ISSUED', (e) => e.meta.outstanding);
      const extra = sum(ev, 'TERMINATION_EXTRA_RECEIPT_POSTED');
      expect(sum(ev, 'INVOICE_COLLECTION_POSTED') + extra, `${room} paidCash`).toBe(r.paidCash);
      expect(sum(ev, 'INVOICE_ISSUED'), `${room} issued`).toBe(r.issued);
      expect(sum(ev, 'INVOICE_ISSUED', (e) => e.meta.depositPart), `${room} cọc`).toBe(r.depositOnInvoices);
      expect(ev.filter((e) => e.type === 'INVOICE_ISSUED').length, `${room} số hoá đơn`).toBe(r.invoiceCount);
      expect(Math.max(sum(ev, 'INVOICE_TERMINATION_OFFSET') - extra, 0), `${room} cấn trừ`).toBe(r.offset);
      expect([Math.max(outstanding, 0), Math.max(-outstanding, 0)], `${room} nợ/thu dư`).toEqual([r.debt, r.overpaid]);
      // Phát sinh ≈ đã nộp + cấn trừ + còn nợ − thu dư (lẻ làm tròn ≤ 1.000/hoá đơn). Phòng F cố ý lệch: cấn trừ kép
      // của writer khi hoá đơn gánh còn mở — dữ liệu để client cảnh báo "cấn trừ vượt các phiếu quyết toán".
      if (room !== 'F') {
        expect(Math.abs(r.issued - (r.paidCash + r.offset + r.debt - r.overpaid)), `${room} cân`).toBeLessThanOrEqual(1_000 * r.invoiceCount);
      }
      const acc = byContract.get(c.id) ?? { contract: c.money.contract, rooms: [] };
      acc.rooms.push(r);
      byContract.set(c.id, acc);
    }
  }
  for (const [id, { contract, rooms }] of byContract) {
    for (const key of ['issued', 'paidCash', 'invoiceCount', 'depositOnInvoices']) {
      if (rooms.length > 1 || contract.roomCount <= 1) expect(rooms.reduce((s, r) => s + r[key], 0), `${LABEL.get(id)} ${key}`).toBe(contract[key]);
    }
  }
  // Thanh lý khi hoá đơn gánh còn mở: Σ cấn trừ vượt phiếu cấn cọc (r > 5.000) — có dữ liệu để client cảnh báo.
  const f = await call(ROOM.F);
  expect(f.contracts[0].money.room.offset - sum(f.events, 'SETTLEMENT_OFFSET_POSTED')).toBeGreaterThan(5_000);
});

test('H1: cash + cấn trừ = invoice_direct_paid_v1; phát sinh mới + nợ kéo + cọc = tổng; cọc khớp invoice_amount_parts_for_v1', async () => {
  const { rows } = await db.query(`SELECT p.*, p.cash_date::text AS cash_d, p.offset_date::text AS off_d,
      app_private.invoice_direct_paid_v1(p.invoice_id) AS live_direct, i.total_amount AS inv_total,
      (public.invoice_amount_parts_for_v1(p.invoice_id, i.total_amount)->>'invoice_amount')::numeric AS parts_invoice_amount
    FROM app_private.invoice_lifecycle_parts_v1(ARRAY(SELECT id FROM public.invoices)) p JOIN public.invoices i ON i.id = p.invoice_id`);
  const got = Object.fromEntries(rows.map((r) => [LABEL.get(r.invoice_id), r]));
  // Tập S: bỏ DRAFT, huỷ không tiền, đã xoá, tổng âm; giữ huỷ còn tiền.
  expect(Object.keys(got).sort()).toEqual(INVOICES.map(([l]) => l).filter((l) => !['A5', 'A6', 'A7', 'BX', 'G2', 'L2', 'L3'].includes(l)).sort());
  for (const [label, r] of Object.entries(got)) {
    expect(Number(r.cash) + Number(r.offset_paid), `${label} direct`).toBe(Number(r.live_direct));
    expect(Number(r.direct), label).toBe(Number(r.live_direct));
    expect(Number(r.new_amount) + Number(r.carried_in) + Number(r.non_rev), `${label} tổng`).toBe(Number(r.inv_total));
    // Hoá đơn huỷ khi bỏ cọc: total đã bị ghi đè nên không đối chiếu được với dòng gốc (phần cọc theo doanh thu trước).
    if (r.parts_invoice_amount !== null && r.status !== 'CANCELLED') {
      expect(Number(r.parts_invoice_amount), `${label} phần doanh thu`).toBe(Number(r.inv_total) - Number(r.non_rev));
    }
    // Phần cọc cấn trừ + chưa tất toán không vượt phần cọc; cấn trừ dòng cọc không vượt cấn trừ.
    expect(Number(r.dep_offset) + Number(r.dep_unpaid), `${label} cọc`).toBeLessThanOrEqual(Number(r.non_rev));
    expect(Number(r.dep_offset), `${label} cấn cọc`).toBeLessThanOrEqual(Number(r.offset_paid));
  }
  expect(['C2', 'C3', 'C4'].every((l) => got[l].parts_invoice_amount !== null)).toBe(true);
  expect([got.A1.cash_d, got.A2.cash_d, got.A2.off_d, got.A3.cash_d]).toEqual(['2026-01-07', '2026-02-05', '2026-03-31', '2026-03-05']);
  // carried_paid lấy từ invoice_carried_debt_v1 (một nguồn), chỉ khi paid_amount vượt tiền trực tiếp.
  const { rows: [carried] } = await db.query(`SELECT app_private.invoice_carried_debt_v1($1) AS v`, [idOf('C1')]);
  expect(Number(got.C1.carried_paid)).toBe(Number(carried.v));
});

test('money không phụ thuộc p_from/p_to; sự kiện lọc theo khoảng', async () => {
  const all = await call(ROOM.A);
  const feb = await call(ROOM.A, '2026-02-01', '2026-02-28');
  expect(observe(feb).events).toEqual(['2026-02-01 INVOICE_ISSUED A 3000000 T A2', '2026-02-05 INVOICE_COLLECTION_POSTED A 2700000 T A2']);
  expect(feb.contracts.map((c) => c.money)).toEqual(all.contracts.map((c) => c.money));
});

test('thứ tự sự kiện tất định: cùng ngày cùng type xếp theo contractId rồi voucherId/invoiceId/terminationId', async () => {
  const one = await call(ROOM.K);
  const two = await call(ROOM.K);
  expect(two.events).toEqual(one.events);
  // Phiếu chèn theo id giảm: thứ tự id tăng ở đây là do khoá phá hoà, không phải thứ tự vật lý.
  const tie = (date, type) => one.events.filter((e) => e.date === date && e.type === type).map((e) => e.meta.voucherId);
  expect(tie('2026-02-10', 'COMMISSION_PAID')).toEqual([idOf('K13'), idOf('K14')]);
  expect(tie('2026-01-20', 'DEPOSIT_RECEIVED')).toEqual([idOf('DEP5'), idOf('DEP6')]);
  const r = await call(ROOM.R);
  expect(r.events.filter((e) => e.type === 'TERMINATION_REQUESTED').map((e) => LABEL.get(e.meta.terminationId)))
    .toEqual(['TERM3', 'TERM4', 'TERM5', 'TERM6', 'TERM7']);
});

// Payload mẫu phía client: roomCashLifecyclePayloadContract.test.ts đưa nó qua buildContractDetail/buildRoomYear/
// buildBalances. Tệp phải là ĐÚNG đầu ra của RPC trên fixture này (chỉ generatedAt cố định) ⇒ client được kiểm trên
// payload thật, không phải payload tự dựng. Đổi thân SQL hoặc fixture ⇒ ghi lại: GHI_PAYLOAD_MAU=1 rồi chạy test này.
const SAMPLE = new URL('../../src/lib/__tests__/fixtures/roomCashLifecyclePayload.sample.json', import.meta.url);
const SAMPLE_GENERATED_AT = '2026-10-29T00:00:00+07:00';
// Mỗi phần tử mảng (HĐ, đoạn, sự kiện) một dòng cho dễ soát diff.
const pretty = (v, pad = '') => (Array.isArray(v)
  ? (v.length ? `[\n${v.map((x) => `${pad}  ${JSON.stringify(x)}`).join(',\n')}\n${pad}]` : '[]')
  : v && typeof v === 'object'
    ? `{\n${Object.entries(v).map(([k, x]) => `${pad}  ${JSON.stringify(k)}: ${pretty(x, `${pad}  `)}`).join(',\n')}\n${pad}}`
    : JSON.stringify(v));

test('payload mẫu của client khớp đúng đầu ra RPC (mọi phòng)', async () => {
  const payloads = {};
  for (const [room, id] of Object.entries(ROOM)) payloads[room] = { ...(await call(id)), generatedAt: SAMPLE_GENERATED_AT };
  if (process.env.GHI_PAYLOAD_MAU === '1') {
    writeFileSync(SAMPLE, `${pretty({
      note: `Đầu ra get_room_cash_lifecycle_v1 (${NEW_FILE}) trên fixture PGlite của scripts/__tests__/`
        + 'room-cash-lifecycle-one-source-sql.test.mjs — số, mã, id đều GIẢ. labels: id → nhãn trong fixture. '
        + 'Ghi lại bằng GHI_PAYLOAD_MAU=1; test SQL đó đỏ khi tệp lệch RPC.',
      rooms: ROOM, labels: Object.fromEntries(LABEL), payloads,
    })}\n`);
  }
  const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  expect(sample.rooms).toEqual(ROOM);
  expect(sample.labels).toEqual(Object.fromEntries(LABEL));
  expect(sample.payloads).toEqual(payloads);
});

// ───────────────────────────── đột biến ─────────────────────────────
const H1 = createOf(NEW, 'app_private.invoice_lifecycle_parts_v1');
const H2 = createOf(NEW, 'app_private.contract_commission_vouchers_v1');
const H3 = createOf(NEW, 'app_private.termination_refund_parts_v1');
const RPC = createOf(NEW, SIG);
// [thân gốc, phép sửa]. Mỗi phép sửa phải đổi được thân (kiểm bên dưới) rồi làm ít nhất một phòng lệch kỳ vọng.
const MUTANTS = {
  'cấn trừ đòi phương thức CT': [H1, (s) => s.replace('SELECT COALESCE(p.received_amount = 0, false) AS off',
    "SELECT COALESCE(p.payment_method::text = 'CT' AND p.received_amount = 0, false) AS off")],
  'received NULL coi là cấn trừ': [H1, (s) => s.replace('SELECT COALESCE(p.received_amount = 0, false) AS off',
    'SELECT COALESCE(p.received_amount, 0) = 0 AS off')],
  'bỏ hoá đơn huỷ còn tiền': [H1, (s) => s.replace("(x.status <> 'CANCELLED' OR x.direct > 0)", "x.status <> 'CANCELLED'")],
  'bỏ kẹp PAID': [H1, (s) => s.replace("WHEN m.status = 'PAID' THEN LEAST(m.eff, 0)", "WHEN m.status = 'PAID' THEN m.eff")],
  'giữ hoá đơn tổng âm': [H1, (s) => s.replace(' AND COALESCE(x.total_amount, 0) >= 0', '')],
  'cọc không nhận cấn trừ': [H1, (s) => s.replace('LEAST(d.dep - p.dep_paid, GREATEST(b.off_amount, 0)) AS dep_offset',
    '0::numeric AS dep_offset')],
  'cọc không nhận phần hoá đơn gánh trả': [H1, (s) => s.replaceAll('GREATEST(b.carried_paid, 0)', '0')],
  'phần cọc nguồn không sang hoá đơn gánh': [H1, (s) => s.replace('COALESCE(cin.dep_in, 0)', '0')],
  'huỷ: vẫn trừ nợ kéo': [H1, (s) => s.replace(
    /CASE WHEN s\.status = 'CANCELLED' THEN 0\s+ELSE (LEAST\(COALESCE\(s\.previous_debt, 0\), COALESCE\(src\.amount, 0\)\)) END/, '$1')],
  'huỷ: cọc trước như hoá đơn thường': [H1, (s) => s.replace('THEN LEAST(b.non_rev, GREATEST(c.cash - b.rev_lines, 0))', 'THEN b.non_rev')],
  'cấn trừ gồm dòng cọc': [RPC, (s) => s.replace('ip.offset_paid - ip.dep_offset AS offset_paid', 'ip.offset_paid')],
  'khoá phá hoà không theo phiếu': [RPC, (s) => s.replace(
    "COALESCE(e.meta->>'voucherId', e.meta->>'invoiceId', e.meta->>'terminationId', '')", "COALESCE(e.meta->>'invoiceId', '')")],
  'bỏ phần cọc': [H1, (s) => s.replace(/sum\(COALESCE\(ii\.amount, 0\)\) FILTER \(WHERE ii\.accounting_class::text IS DISTINCT FROM 'REVENUE'\s+AND ii\.type::text <> 'DISCOUNT'\) AS non_rev/,
    '0::numeric AS non_rev')],
  'bỏ điều kiện nguồn ∈ S': [H1, (s) => s.replace('WHERE r.source_id IN (SELECT y.id FROM s y)', 'WHERE r.source_id IS NOT NULL')],
  'lọc EXTRA theo HĐ': [RPC, (s) => s.replace('FROM ex\n     WHERE ex.room_id = p_room_id', 'FROM ex\n     WHERE true')],
  'bỏ is_commission_voucher_v1': [H2, (s) => s.replace(/\s+AND app_private\.is_commission_voucher_v1\(v\.id\)/, '')],
  'bỏ v.contract_id IS NULL ở nhánh claim': [H2, (s) => s.replace(/\s+AND v\.contract_id IS NULL/, '')],
  'bỏ lọc CANCELLED của hoa hồng': [H2, (s) => s.replace(/\s+AND v\.approval_status::text IS DISTINCT FROM 'CANCELLED'/g, '')],
  // Hai vế REVERSED/PAID loại trừ nhau (posting_status khác nhau) nên đổi THỨ TỰ không đổi kết quả; đột biến có
  // nghĩa là tráo NHÃN của hai vế.
  'tráo nhãn REVERSED/PAID': [H2, (s) => s.replace("IS NOT NULL THEN 'PAID'", "IS NOT NULL THEN 'REVERSED'")
    .replace("= 'REVERSED' THEN 'REVERSED'", "= 'REVERSED' THEN 'PAID'")],
  'trusted hoa hồng cố định true': [RPC, (s) => s.replace("cv.voucher_date, cv.contract_id, cv.total_amount, (cv.stage = 'PAID'),",
    'cv.voucher_date, cv.contract_id, cv.total_amount, true,')],
  'NOT_APPLICABLE không tính đã hoàn': [H3, (s) => s.replace(/\s+OR v\.posting_status::text = 'NOT_APPLICABLE'\), false\) AS posted/,
    '), false) AS posted')],
};

test('đột biến: bỏ từng điều kiện lọc/kẹp thì phép kiểm hành vi phải đỏ', async () => {
  expect(await tx(behaviour)).toEqual([]);
  const report = {};
  for (const [label, [base, edit]] of Object.entries(MUTANTS)) {
    const mutant = edit(base);
    expect(mutant, label).not.toBe(base);
    report[label] = await tx(async () => { await db.exec(mutant); return behaviour(); });
  }
  for (const [label, bad] of Object.entries(report)) expect(bad, label).not.toEqual([]);
}, 120_000);

test('đột biến: cấp EXECUTE helper cho authenticated thì witness và nghiệm thu của migration phải đỏ', async () => {
  for (const sig of HELPERS) {
    await tx(async () => {
      await db.exec(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`);
      expect((await witness()).helpers[sig], sig).not.toEqual(HELPER_WITNESS);
      await expect(db.exec(nghiemThuOf(NEW)), sig).rejects.toThrow(/khong duoc cap EXECUTE cho client/);
    });
  }
});
