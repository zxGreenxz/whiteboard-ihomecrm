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
//   expense.approve — duyệt / duyệt + chi ≤ 10 phiếu (Mốc 5; khoá income_expenses.approve_vouchers seed TẮT).
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

export const EXPENSE_RPC = 'hermes_expense_write_v1';
export const EXPENSE_CREATE_KEY = 'income_expenses.create';
export const EXPENSE_CREATE_MAX_ITEMS = 5;

export const EXPENSE_CREATE = defineAction({ id: 'expense.create', page: 'expense', key: EXPENSE_CREATE_KEY, class: 'money', rpc: EXPENSE_RPC,
  title: 'Lập phiếu CHI (mỗi khoản một phiếu, tối đa 5 khoản một lần đồng ý)',
  params: { items: param.list(param.record({
    buildingName: param.name('building'), roomName: param.name('room', { optional: true }), amount: param.vnd(),
    content: param.text(1, 200), category: param.name('category', { optional: true }), payee: param.text(1, 100, { optional: true }),
    voucherDate: param.date({ optional: true }), voucherDatePhrase: param.text(1, 80, { optional: true, hint: 'NGUYÊN VĂN cụm ngày chi người dùng nói ("thứ hai tuần trước", "cuối tháng trước", "hôm qua"); connector tự đổi ra ngày, ghi đè voucherDate' }),
    period: param.month({ optional: true }), cashbook: param.name('cashbook', { optional: true }),
  }), { min: 1, max: EXPENSE_CREATE_MAX_ITEMS }) },
  // Lượt 13 (20261024094809): khoản thuộc luồng hệ thống (hoa hồng, thanh lý / trả tiền thừa cho khách, cọc, lương, chia lợi nhuận, chuyển
  // nội bộ) ⇒ web_only + link màn gốc. Connector cũ vẫn chuyển mã này (mọi mã rejected toàn cục), danh sách ở đây chỉ để crm_action_list nói đúng.
  reasons: ['system_voucher', 'web_only', 'period_locked', 'cashbook_not_held', 'not_allowed', 'state_changed', 'date_out_of_range', 'amount_out_of_range'] });

// Lượt 16 (nghiệm thu C3d): mã phiếu bị dùng lại giữa các toà ⇒ buildingName (tuỳ chọn) = toà của phiếu, SQL 20261024210500 dùng để chọn đúng
// phiếu khi mã trùng (approve: một toà cho cả lô). SQL cũ bỏ qua khoá này (vẫn hỏi chọn phiếu như trước) ⇒ không phụ thuộc thứ tự phát hành.
export const EXPENSE_NOTE = defineAction({ id: 'expense.note', page: 'expense', key: EXPENSE_CREATE_KEY, class: 'reversible', rpc: EXPENSE_RPC,
  title: 'Ghi chú vào phiếu thu chi (ghi thẳng; mã trùng giữa các toà ⇒ kèm buildingName)',
  params: { voucherCode: param.name('voucher'), note: param.text(1, 1000), buildingName: param.name('building', { optional: true }) },
  reasons: ['not_found', 'not_allowed'] });

// Mốc 4: chỉ khuôn tham số đã có (name/vnd/text/date) — không thêm byte tools/list (khuôn nằm trong kết quả crm_action_list).
export const EXPENSE_EDIT = defineAction({ id: 'expense.edit', page: 'expense', key: 'income_expenses.edit', class: 'money', rpc: EXPENSE_RPC,
  title: 'Sửa phiếu CHI chờ duyệt (nêu ≥ 1 trường đổi; buildingName = toà của phiếu khi mã trùng, toà khác ⇒ chuyển toà)',
  params: { voucherCode: param.name('voucher'), amount: param.vnd({ optional: true }), category: param.name('category', { optional: true }),
    content: param.text(1, 200, { optional: true }), payee: param.text(1, 100, { optional: true }), voucherDate: param.date({ optional: true }),
    voucherDatePhrase: param.text(1, 80, { optional: true, hint: 'NGUYÊN VĂN cụm ngày chi người dùng nói ("thứ hai tuần trước", "cuối tháng trước", "hôm qua"); connector tự đổi ra ngày, ghi đè voucherDate' }),
    cashbook: param.name('cashbook', { optional: true }), buildingName: param.name('building', { optional: true }),
    roomName: param.name('room', { optional: true }), reason: param.text(8, 1000, { optional: true }) },
  reasons: ['not_found', 'not_pending', 'reason_required', 'system_voucher', 'web_only', 'period_locked', 'cashbook_not_held', 'not_allowed', 'state_changed'] });

export const EXPENSE_CANCEL = defineAction({ id: 'expense.cancel', page: 'expense', key: 'income_expenses.cancel', class: 'irreversible', rpc: EXPENSE_RPC,
  title: 'Huỷ phiếu CHI lập tay (bắt lý do; đã vào sổ ⇒ bút toán đảo; mã trùng giữa các toà ⇒ kèm buildingName)',
  params: { voucherCode: param.name('voucher'), reason: param.text(8, 1000), buildingName: param.name('building', { optional: true }) },
  reasons: ['not_found', 'not_pending', 'system_voucher', 'web_only', 'strict_mode', 'period_locked', 'cashbook_not_held', 'not_allowed', 'state_changed'] });

// Mốc 5: duyệt / duyệt + chi ≤ 10 phiếu (Q8). Khoá Hermes income_expenses.approve_vouchers (seed TẮT), quyền CRM giao vào
// income_expenses.approve (Q25). post mặc định true; chưa có ảnh / không giữ sổ ⇒ SQL hạ "chỉ duyệt" và nói rõ trong bản xem trước (TC4).
export const EXPENSE_APPROVE_MAX = 10;
export const EXPENSE_APPROVE = defineAction({ id: 'expense.approve', page: 'expense', key: 'income_expenses.approve_vouchers', class: 'money', rpc: EXPENSE_RPC,
  // Lượt 14: mã trùng giữa các toà ⇒ dùng voucherId của dòng báo cáo expense_vouchers (SQL 20261024120211 nhận UUID).
  title: 'Duyệt phiếu CHI (≤ 10 mã / voucherId của báo cáo; mã trùng ⇒ buildingName; post=false chỉ duyệt, mặc định duyệt và chi)',
  params: { voucherCodes: param.list(param.name('voucher'), { min: 1, max: EXPENSE_APPROVE_MAX }), post: param.bool({ optional: true }),
    buildingName: param.name('building', { optional: true }) },
  reasons: ['not_found', 'not_pending', 'system_voucher', 'web_only', 'evidence_required', 'cashbook_not_held', 'period_locked', 'not_allowed', 'state_changed'] });

export const EXPENSE_ACTIONS = Object.freeze([EXPENSE_CREATE, EXPENSE_NOTE, EXPENSE_EDIT, EXPENSE_CANCEL, EXPENSE_APPROVE]);
// Họ tool phiếu chi cũ đã gỡ khỏi connector (TC1): tên cũ → thao tác thay trên khung chung (…_status ⇒ crm_action_status, còn lại
// ⇒ crm_action_run). Không quảng bá, gọi thẳng bị từ chối (action-tools-budget.test.mjs); catalog-names.mjs liệt kê thành tên nghỉ hưu.
export const EXPENSE_RETIRED_TOOLS = Object.freeze({ crm_expense_input_options: EXPENSE_CREATE.id, crm_expense_create: EXPENSE_CREATE.id,
  crm_expense_status: EXPENSE_CREATE.id });
export const expenseCatalog = () => createActionCatalog(EXPENSE_ACTIONS);
