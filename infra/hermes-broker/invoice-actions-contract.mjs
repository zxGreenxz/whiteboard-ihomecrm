// Danh mục thao tác ghi của trang HOÁ ĐƠN trên khung chung crm_action_* (Đợt 3; docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 3–4).
// Mọi thao tác đi một RPC trang public.hermes_invoice_action_v1 (vỏ INVOKER SQL-standard → tra cứu INVOKER dưới RLS người hỏi → bước ghi
// DEFINER gọi ĐÚNG hàm ghi web). Toà/phòng/sổ là TÊN như người dùng nói; hoá đơn giải bằng toà + phòng + kỳ (D7). Tiền là số nguyên VND.
//   invoice.collect — ghi nhận khách đã trả bằng chuyển khoản (TK) hoặc vào sổ HKD (TT), một phòng hoặc lô ≤ 10 phòng cùng toà cho MỘT lần
//                     đồng ý; luôn xem trước (money). Tiền mặt (TM) bị từ chối, chỉ đường /thu-tien (Q13). Bản xem trước = chạy thử
//                     record_invoice_collection_v5 trong khối con rồi lùi; khách trả dư chưa chọn ⇒ bản xem trước hỏi (choiceRequired).
// Ghi chỉ số, điều chỉnh, xác nhận kiểm tra, huỷ/khôi phục thêm ở Mốc 4–5 (khoá meter_readings.create / invoices.* đã seed TẮT).
import { createActionCatalog, defineAction, param } from './action-catalog.mjs';

export const INVOICE_RPC = 'hermes_invoice_action_v1';
// Khoá riêng Hermes (HDN1): quyền CRM giao vào = thu_tien.collect (đúng quyền record_invoice_collection_v5 kiểm); tên nói luôn phạm vi.
export const INVOICE_COLLECT_KEY = 'thu_tien.collect_transfer';
export const INVOICE_COLLECT_MAX_ITEMS = 10;

export const INVOICE_COLLECT = defineAction({ id: 'invoice.collect', page: 'invoice', key: INVOICE_COLLECT_KEY, class: 'money', rpc: INVOICE_RPC,
  title: 'Ghi nhận khách đã trả hoá đơn bằng chuyển khoản / sổ HKD (1 phòng hoặc tối đa 10 phòng cùng toà; tiền mặt ghi trên web)',
  params: {
    buildingName: param.name('building'), roomName: param.name('room', { optional: true }), month: param.month({ optional: true }),
    items: param.list(param.record({ roomName: param.name('room'), month: param.month({ optional: true }), amount: param.vnd({ optional: true }) }),
      { min: 1, max: INVOICE_COLLECT_MAX_ITEMS, optional: true }),
    method: param.oneOf(['TK', 'TT', 'TM']), amount: param.vnd({ optional: true }), date: param.date({ optional: true }),
    overpay: param.oneOf(['keep', 'return'], { optional: true }), cashbookName: param.name('cashbook', { optional: true }),
    note: param.text(1, 200, { optional: true }),
  },
  reasons: ['cash_collection_web_only', 'nothing_to_collect', 'debt_carried', 'overpay_needs_choice', 'invoice_not_collectible',
    'credit_requires_contract', 'receiving_book_missing', 'reconciliation_required', 'period_locked', 'cashbook_not_held', 'not_allowed',
    'state_changed', 'date_out_of_range', 'amount_out_of_range', 'web_only'] });

export const INVOICE_ACTIONS = Object.freeze([INVOICE_COLLECT]);
export const invoiceCatalog = () => createActionCatalog(INVOICE_ACTIONS);
