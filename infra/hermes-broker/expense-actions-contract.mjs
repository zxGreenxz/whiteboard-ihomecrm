// Danh mục thao tác ghi của trang THU CHI trên khung chung crm_action_* (Đợt 2; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 2).
// Thay họ crm_expense_* cũ (TC1: cùng khoá income_expenses.create, họ cũ đã gỡ khỏi connector). Mọi thao tác đi một RPC trang
// public.hermes_expense_write_v1 (vỏ INVOKER SQL-standard → bước ghi DEFINER gọi ĐÚNG hàm ghi web). Toà/phòng/hạng mục/sổ/mã
// phiếu là TÊN như người dùng nói; SQL giải dưới RLS người hỏi (D7). Tiền là số nguyên VND.
//   expense.create — phiếu CHI lập tay, mỗi khoản một phiếu, ≤ 5 khoản cho MỘT lần đồng ý (Q10); luôn xem trước (money). Bản xem
//                    trước = chạy thử create_income_expense_v1 trong savepoint rồi lùi ⇒ nói đúng "vào sổ ngay" / "chờ duyệt vì …".
//   expense.note   — ghi chú phiếu (append_income_expense_supplement_v1); không dính tiền ⇒ ghi thẳng (Q2, chính sách never).
// Sửa / huỷ / duyệt thêm ở Mốc 3–4 (khoá income_expenses.edit/.cancel/.approve_vouchers đã seed TẮT).
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

export const EXPENSE_RPC = 'hermes_expense_write_v1';
export const EXPENSE_CREATE_KEY = 'income_expenses.create';
export const EXPENSE_CREATE_MAX_ITEMS = 5;

export const EXPENSE_CREATE = defineAction({ id: 'expense.create', page: 'expense', key: EXPENSE_CREATE_KEY, class: 'money', rpc: EXPENSE_RPC,
  title: 'Lập phiếu CHI (mỗi khoản một phiếu, tối đa 5 khoản một lần đồng ý)',
  params: { items: param.list(param.record({
    buildingName: param.name('building'), roomName: param.name('room', { optional: true }), amount: param.vnd(),
    content: param.text(1, 200), category: param.name('category', { optional: true }), payee: param.text(1, 100, { optional: true }),
    voucherDate: param.date({ optional: true }), period: param.month({ optional: true }), cashbook: param.name('cashbook', { optional: true }),
  }), { min: 1, max: EXPENSE_CREATE_MAX_ITEMS }) },
  reasons: ['system_voucher', 'period_locked', 'cashbook_not_held', 'not_allowed', 'state_changed', 'date_out_of_range', 'amount_out_of_range'] });

export const EXPENSE_NOTE = defineAction({ id: 'expense.note', page: 'expense', key: EXPENSE_CREATE_KEY, class: 'reversible', rpc: EXPENSE_RPC,
  title: 'Ghi chú vào phiếu thu chi (ghi thẳng)',
  params: { voucherCode: param.name('voucher'), note: param.text(1, 1000) },
  reasons: ['not_found', 'not_allowed'] });

export const EXPENSE_ACTIONS = Object.freeze([EXPENSE_CREATE, EXPENSE_NOTE]);
export const expenseCatalog = () => createActionCatalog(EXPENSE_ACTIONS);
