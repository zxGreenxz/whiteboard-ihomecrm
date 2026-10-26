// Danh mục thao tác ghi của trang HOÁ ĐƠN trên khung chung crm_action_* (Đợt 3; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 3–4).
// Mọi thao tác đi một RPC trang public.hermes_invoice_action_v1 (vỏ INVOKER SQL-standard → tra cứu INVOKER dưới RLS người hỏi → bước ghi
// DEFINER gọi ĐÚNG hàm ghi web). Toà/phòng/sổ là TÊN như người dùng nói; hoá đơn giải bằng toà + phòng + kỳ (D7); hai hoá đơn còn nợ cùng
// kỳ ⇒ hỏi lại, ứng viên mang số hoá đơn, chọn lại bằng invoiceNumber. Tiền là số nguyên VND.
//   invoice.collect — ghi nhận khách đã trả bằng chuyển khoản (TK) hoặc thanh toán (TT — sổ POS của toà, nhãn như web), một phòng hoặc lô
//                     ≤ 10 phòng cùng toà cho MỘT lần đồng ý; luôn xem trước (money). Tiền mặt (TM) bị từ chối, chỉ đường /thu-tien (Q13). Bản xem trước = chạy thử
//                     record_invoice_collection_v5 trong khối con rồi lùi; khách trả dư chưa chọn ⇒ bản xem trước hỏi (choiceRequired).
// Ghi chỉ số (Mốc 4) và điều chỉnh, xác nhận kiểm tra, huỷ/khôi phục (Mốc 5) ở dưới.
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

export const INVOICE_RPC = 'hermes_invoice_action_v1';
// Khoá riêng Hermes (HDN1): quyền CRM giao vào = thu_tien.collect (đúng quyền record_invoice_collection_v5 kiểm); tên nói luôn phạm vi.
export const INVOICE_COLLECT_KEY = 'thu_tien.collect_transfer';
export const INVOICE_COLLECT_MAX_ITEMS = 10;

export const INVOICE_COLLECT = defineAction({ id: 'invoice.collect', page: 'invoice', key: INVOICE_COLLECT_KEY, class: 'money', rpc: INVOICE_RPC,
  title: 'Ghi khách đã trả hoá đơn bằng chuyển khoản / thanh toán POS (1 phòng hoặc ≤ 10 phòng cùng toà; tiền mặt ghi trên web)',
  // Lượt 14 (nghiệm thu C3c): toà tuỳ chọn (một phòng: máy chủ giải phòng duy nhất trong phạm vi, không thấy thì hỏi toà); sổ nhận người dùng nêu
  // vào cashbookName (tên phụ cashbook như expense.create) — máy chủ tìm ở cả sổ TK lẫn TT của toà và chọn hình thức theo sổ; note không chứa tên sổ.
  params: {
    buildingName: param.name('building', { optional: true, hint: 'tên toà như người dùng nói; không nêu ⇒ máy chủ giải theo phòng, không thấy thì hỏi toà (lô phải có toà)' }),
    roomName: param.name('room', { optional: true }), month: param.month({ optional: true }),
    invoiceNumber: param.name('invoice', { optional: true }),
    items: param.list(param.record({ roomName: param.name('room'), month: param.month({ optional: true }), invoiceNumber: param.name('invoice', { optional: true }),
      amount: param.vnd({ optional: true }) }),
      { min: 1, max: INVOICE_COLLECT_MAX_ITEMS, optional: true }),
    method: param.oneOf(['TK', 'TT', 'TM']), amount: param.vnd({ optional: true, hint: 'số tiền VND khách trả (3tr5 = 3500000) — không phải chỉ số công tơ' }),
    date: param.date({ optional: true }),
    datePhrase: param.text(1, 80, { optional: true, hint: 'NGUYÊN VĂN cụm ngày khách trả người dùng nói ("thứ hai tuần trước", "hôm qua"); connector tự đổi ra ngày, ghi đè date' }),
    overpay: param.oneOf(['keep', 'return'], { optional: true }),
    cashbookName: param.name('cashbook', { optional: true, alias: 'cashbook',
      hint: 'sổ/tài khoản NHẬN tiền người dùng nêu (vd "HKD Tâm", "MB"); có nêu thì PHẢI truyền ở đây, không ghi vào note; máy chủ chọn TK/TT theo sổ' }),
    note: param.text(1, 200, { optional: true, hint: 'ghi chú lần thu (1–200 ký tự); KHÔNG ghi tên sổ nhận ở đây' }),
  },
  reasons: ['cash_collection_web_only', 'nothing_to_collect', 'debt_carried', 'overpay_needs_choice', 'invoice_not_collectible',
    'credit_requires_contract', 'receiving_book_missing', 'receiving_book_not_held', 'reconciliation_required', 'period_closed', 'period_locked', 'cashbook_not_held', 'not_allowed',
    'state_changed', 'date_out_of_range', 'amount_out_of_range', 'web_only'] });

// Mốc 4 (mục 4.2, 6.2): ghi chỉ số tháng qua hàm dùng chung với form web (record_meter_readings_v2); khoá meter_readings.create (seed TẮT ở
// 20261021134531, quyền CRM cùng tên; "sửa" cần thêm meter_readings.edit). Ngày chốt theo Q16 = a: tháng trống/tháng này ⇒ hôm nay, tháng
// đã qua ⇒ ngày cuối tháng đó. Dòng không ghi được (trùng tháng, nhỏ hơn số đầu, nhiều công tơ…) bị loại và nêu ở bản xem trước.
export const INVOICE_METER_KEY = 'meter_readings.create';
export const INVOICE_METER_MAX_ROWS = 60;
export const INVOICE_METER_RECORD = defineAction({ id: 'invoice.meter_record', page: 'invoice', key: INVOICE_METER_KEY, class: 'money', rpc: INVOICE_RPC,
  title: 'Ghi chỉ số điện/nước tháng cho 1 hoặc nhiều phòng cùng toà (≤ 60 dòng); tháng đã có thì chỉ thay khi người dùng nói sửa',
  params: {
    buildingName: param.name('building'),
    readings: param.list(param.record({ roomName: param.name('room'), value: param.int(0, 99_999_999, { hint: 'chỉ số đọc trên công tơ (kWh / m³), KHÔNG phải số tiền' }),
      meterCode: param.text(1, 40, { optional: true }) }),
      { max: INVOICE_METER_MAX_ROWS, ceiling: INVOICE_METER_MAX_ROWS }),
    meterType: param.oneOf(['dien', 'nuoc'], { optional: true }), month: param.month({ optional: true }), replace: param.bool({ optional: true }),
  },
  reasons: ['meter_not_found', 'meter_ambiguous', 'meter_duplicate_month', 'meter_lower_than_previous', 'meter_used_by_invoice', 'meter_has_later_reading',
    'not_allowed', 'state_changed', 'date_out_of_range', 'invalid_params'] });

// Mốc 5 (mục 4.3–4.5, 6.3): ba khoá invoices.* (seed TẮT ở 20261021134531, quyền CRM cùng tên). Hoá đơn giải bằng toà + phòng + kỳ, chọn
// đích danh bằng invoiceNumber; kỳ trống ⇒ hoá đơn tháng mới nhất (khôi phục: mới nhất đã huỷ; xác nhận kiểm tra: điều chỉnh chờ duy nhất).
//   invoice.adjust — chạy thử adjust_invoice_v2: giảm THÊM (discount, HDN5), thêm khoản (addItems), đặt lại tiền một khoản theo mô tả
//                    (setItems.match khớp đúng một dòng; dòng điện/nước có chỉ số, cọc, nội bộ ⇒ chỉ đường web). Điều chỉnh chờ người khác kiểm.
//   invoice.adjustment_check — xác nhận ĐÃ KIỂM TRA điều chỉnh do NGƯỜI KHÁC làm (HDN6); không bỏ được (irreversible).
//   invoice.cancel / invoice.restore — huỷ hoá đơn chưa thu (quá hạn huỷ trên web) / khôi phục hoá đơn đã huỷ; lý do chỉ ở biên nhận (HDN8).
const invoiceTarget = () => ({ buildingName: param.name('building'), roomName: param.name('room'), month: param.month({ optional: true }),
  invoiceNumber: param.name('invoice', { optional: true }) });
export const INVOICE_ADJUST = defineAction({ id: 'invoice.adjust', page: 'invoice', key: 'invoices.edit', class: 'money', rpc: INVOICE_RPC,
  title: 'Điều chỉnh hoá đơn (giảm thêm, thêm khoản, đặt tiền khoản không chỉ số; chờ người khác kiểm); gọi ngay, hỏi lý do sau',
  params: { ...invoiceTarget(), reason: param.text(8, 1000, { optional: true }), discount: param.vnd({ optional: true }),
    addItems: param.list(param.record({ description: param.text(1, 200), amount: param.vnd() }), { max: 5, optional: true }),
    setItems: param.list(param.record({ match: param.text(1, 120), amount: param.vnd({ min: 0 }) }), { max: 5, optional: true }) },
  reasons: ['adjust_meter_line_web_only', 'adjust_has_rounding_or_credit', 'adjust_debt_carried', 'adjust_below_collected', 'adjust_no_change',
    'invoice_already_cancelled', 'reconciliation_required', 'period_locked', 'not_allowed', 'state_changed', 'amount_out_of_range', 'reason_required',
    'invalid_params', 'web_only'] });
export const INVOICE_ADJUSTMENT_CHECK = defineAction({ id: 'invoice.adjustment_check', page: 'invoice', key: 'invoices.approve', class: 'irreversible',
  rpc: INVOICE_RPC, title: 'Xác nhận ĐÃ KIỂM TRA điều chỉnh hoá đơn do người khác làm (không bỏ được sau khi xác nhận)',
  params: invoiceTarget(), reasons: ['nothing_to_check', 'adjustment_self_check_web_only', 'not_allowed', 'state_changed'] });
export const INVOICE_CANCEL = defineAction({ id: 'invoice.cancel', page: 'invoice', key: 'invoices.cancel', class: 'money', rpc: INVOICE_RPC,
  title: 'Huỷ hoá đơn chưa thu đồng nào (hoá đơn quá hạn huỷ trên web); gọi ngay, lý do hỏi sau khi máy chủ kiểm chặn',
  params: { ...invoiceTarget(), reason: param.text(8, 500, { optional: true }) },
  reasons: ['cancel_has_payment', 'cancel_overdue_web_only', 'invoice_already_cancelled', 'reconciliation_required', 'period_locked', 'not_allowed',
    'state_changed', 'reason_required', 'web_only'] });
export const INVOICE_RESTORE = defineAction({ id: 'invoice.restore', page: 'invoice', key: 'invoices.cancel', class: 'money', rpc: INVOICE_RPC,
  title: 'Khôi phục hoá đơn đã huỷ (kỳ chưa có hoá đơn tháng khác đang hiệu lực); gọi ngay, lý do hỏi sau khi máy chủ kiểm',
  params: { ...invoiceTarget(), reason: param.text(8, 500, { optional: true }) },
  reasons: ['restore_conflict', 'invoice_not_cancelled', 'reconciliation_required', 'period_locked', 'not_allowed', 'state_changed', 'reason_required'] });

export const INVOICE_ACTIONS = Object.freeze([INVOICE_COLLECT, INVOICE_METER_RECORD, INVOICE_ADJUST, INVOICE_ADJUSTMENT_CHECK, INVOICE_CANCEL, INVOICE_RESTORE]);
export const invoiceCatalog = () => createActionCatalog(INVOICE_ACTIONS);
