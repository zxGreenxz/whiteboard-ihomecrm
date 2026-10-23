// Danh mục thao tác ghi của trang THU CHI trên khung chung crm_action_* (Đợt 2; docs/plans/hermes-crm/THU-CHI-THAO-TAC-GHI.md mục 2).
// Thay họ crm_expense_* cũ (TC1: cùng khoá income_expenses.create, họ cũ đã gỡ khỏi connector). Mọi thao tác đi một RPC trang
// public.hermes_expense_write_v1 (vỏ INVOKER SQL-standard → bước ghi DEFINER gọi ĐÚNG hàm ghi web). Toà/phòng/hạng mục/sổ/mã
// phiếu là TÊN như người dùng nói; SQL giải dưới RLS người hỏi (D7). Tiền là số nguyên VND.
//   expense.create — phiếu CHI lập tay, mỗi khoản một phiếu, ≤ 5 khoản cho MỘT lần đồng ý (Q10); luôn xem trước (money). Bản xem
//                    trước = chạy thử create_income_expense_v1 trong savepoint rồi lùi ⇒ nói đúng "vào sổ ngay" / "chờ duyệt vì …".
//   expense.note   — ghi chú phiếu (append_income_expense_supplement_v1); không dính tiền ⇒ ghi thẳng (Q2, chính sách never).
//   expense.edit   — sửa phiếu CHI lập tay đang chờ duyệt (revise_pending_income_expense_v1); đổi tiền/hạng mục/sổ/toà ⇒ hàm web đòi lý do.
//   expense.cancel — huỷ phiếu CHI lập tay (cancel_income_expense_flex_v1), bắt lý do; phiếu đã vào sổ ⇒ bút toán đảo, không khôi phục được.
//   Phiếu THU / phiếu hệ thống / phiếu con định kỳ (cờ TC5 tắt) ⇒ từ chối, chỉ đường web. Khoá income_expenses.edit/.cancel seed TẮT.
// Duyệt thêm ở Mốc 5 (khoá income_expenses.approve_vouchers đã seed TẮT).
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

// Mốc 4: chỉ khuôn tham số đã có (name/vnd/text/date) — không thêm byte tools/list (khuôn nằm trong kết quả crm_action_list).
export const EXPENSE_EDIT = defineAction({ id: 'expense.edit', page: 'expense', key: 'income_expenses.edit', class: 'money', rpc: EXPENSE_RPC,
  title: 'Sửa phiếu CHI chờ duyệt (nêu ít nhất một trường đổi)',
  params: { voucherCode: param.name('voucher'), amount: param.vnd({ optional: true }), category: param.name('category', { optional: true }),
    content: param.text(1, 200, { optional: true }), payee: param.text(1, 100, { optional: true }), voucherDate: param.date({ optional: true }),
    cashbook: param.name('cashbook', { optional: true }), buildingName: param.name('building', { optional: true }),
    roomName: param.name('room', { optional: true }), reason: param.text(8, 1000, { optional: true }) },
  reasons: ['not_found', 'not_pending', 'reason_required', 'system_voucher', 'web_only', 'period_locked', 'cashbook_not_held', 'not_allowed', 'state_changed'] });

export const EXPENSE_CANCEL = defineAction({ id: 'expense.cancel', page: 'expense', key: 'income_expenses.cancel', class: 'irreversible', rpc: EXPENSE_RPC,
  title: 'Huỷ phiếu CHI lập tay (bắt lý do; đã vào sổ ⇒ bút toán đảo)',
  params: { voucherCode: param.name('voucher'), reason: param.text(8, 1000) },
  reasons: ['not_found', 'not_pending', 'system_voucher', 'web_only', 'strict_mode', 'period_locked', 'cashbook_not_held', 'not_allowed', 'state_changed'] });

export const EXPENSE_ACTIONS = Object.freeze([EXPENSE_CREATE, EXPENSE_NOTE, EXPENSE_EDIT, EXPENSE_CANCEL]);
export const expenseCatalog = () => createActionCatalog(EXPENSE_ACTIONS);
