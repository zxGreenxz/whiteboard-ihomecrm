// Thao tác ghi của trang HỢP ĐỒNG (Đợt 2, docs/plans/hermes-crm/HOP-DONG-THAO-TAC-GHI.md mục 3–5). Cắm vào khung chung
// crm_action_* (0 byte tools/list): khuôn tham số nằm trong kết quả crm_action_list. Mọi thao tác đi qua MỘT RPC trang
// public.hermes_contract_action_v1 (20261022022951): vỏ INVOKER → tra cứu dưới RLS người hỏi → bước ghi DEFINER gọi đúng hàm
// ghi web. Toà và phòng luôn bắt buộc (ghi nhầm toà là ghi sai; giải tên ghi chỉ khớp phòng đúng tên/mã).
// Mốc 2: báo trả / dời ngày / huỷ báo trả + khoá tạm / gỡ khoá tạm — đều reversible, ghi thẳng theo Q2 = a (D-HĐ1).
// Khoá contracts.terminate mở cả báo trả lẫn ghi nhận trả phòng (Mốc 4): bản connector nào chưa khai contract.return thì
// bật khoá chỉ mở báo trả.
import { defineAction, param } from './action-catalog.mjs';

const RPC = 'hermes_contract_action_v1';
const place = () => ({ buildingName: param.name('building'), roomName: param.name('room') });

export const CONTRACT_NOTICE_SET = defineAction({ id: 'contract.notice_set', page: 'contract', key: 'contracts.terminate', class: 'reversible', rpc: RPC,
  title: 'Báo trả phòng / dời ngày báo trả: ngày khách dự kiến dọn đi (khác ngày hết hạn HĐ); ghi thẳng',
  params: { ...place(), date: param.date(), datePhrase: param.text(1, 80, { optional: true, hint: 'NGUYÊN VĂN cụm ngày người dùng nói ("thứ hai tuần trước", "cuối tháng"); connector tự đổi ra ngày, ghi đè date' }), note: param.text(3, 500, { optional: true }) },
  reasons: ['room_has_no_active_contract', 'notice_date_past', 'already_returned'] });
export const CONTRACT_NOTICE_CANCEL = defineAction({ id: 'contract.notice_cancel', page: 'contract', key: 'contracts.terminate', class: 'reversible', rpc: RPC,
  title: 'Huỷ báo trả phòng (khách ở tiếp); cần lý do; ghi thẳng',
  params: { ...place(), reason: param.text(8, 500) },
  reasons: ['room_has_no_active_contract', 'already_returned', 'no_notice'] });
export const CONTRACT_ROOM_LOCK = defineAction({ id: 'contract.room_lock', page: 'contract', key: 'sale_phong.lock_room', class: 'reversible', rpc: RPC,
  title: 'Khoá tạm (giữ) phòng trống 6, 12 hoặc 24 giờ: ẩn khỏi danh sách bán, hết giờ tự mở; ghi thẳng',
  params: { ...place(), hours: param.int(6, 24), note: param.text(1, 300, { optional: true }) },
  reasons: ['room_not_lockable', 'room_already_locked'] });
export const CONTRACT_ROOM_UNLOCK = defineAction({ id: 'contract.room_unlock', page: 'contract', key: 'sale_phong.lock_room', class: 'reversible', rpc: RPC,
  title: 'Gỡ khoá tạm (bỏ giữ) phòng; ghi thẳng',
  params: place(), reasons: ['no_open_lock'] });

// Mốc 3: gia hạn giữ nguyên giá (Q21). irreversible ⇒ luôn xem trước. Đúng MỘT trong months (máy chủ cộng tháng bằng hàm dùng
// chung với web) hoặc newEndDate. Không lý do ⇒ SQL hỏi một câu (renew_reason_ask); người dùng nói không có ⇒ noReason=true.
// newRentPrice/newDeposit chỉ để máy chủ đối chiếu: khác giá/cọc hiện tại ⇒ renew_price_change_web_only.
export const CONTRACT_RENEW = defineAction({ id: 'contract.renew', page: 'contract', key: 'contracts.renew', class: 'irreversible', rpc: RPC,
  title: 'Gia hạn HĐ giữ nguyên giá/cọc (months hoặc newEndDate); thiếu lý do hỏi 1 câu, không có ⇒ noReason=true',
  params: { ...place(), months: param.int(1, 60, { optional: true }), newEndDate: param.date({ optional: true }), reason: param.text(8, 1000, { optional: true }),
    noReason: param.bool({ optional: true }), keepMoveOutNotice: param.bool({ optional: true }), newRentPrice: param.vnd({ min: 0, optional: true }),
    newDeposit: param.vnd({ min: 0, optional: true }) },
  reasons: ['room_has_no_active_contract', 'already_returned', 'renew_reason_ask', 'notice_choice_required', 'renew_price_change_web_only'] });

// Mốc 4: ghi nhận khách ĐÃ trả phòng, quyết toán sau (Q20 = a, DEFERRED; migration 20261022061813). irreversible ⇒ luôn xem
// trước; câu xem trước nói rõ HĐ chuyển Đã thanh lý, phòng thành trống, KHÔNG lùi được, quyết toán làm trên web. Loại do máy chủ
// suy từ ngày (D-HĐ6); forfeit=true chỉ khi người dùng nói bỏ cọc. note = nội dung thanh lý (hàm web bắt buộc).
export const CONTRACT_RETURN = defineAction({ id: 'contract.return', page: 'contract', key: 'contracts.terminate', class: 'irreversible', rpc: RPC,
  title: 'Ghi nhận khách ĐÃ trả phòng, quyết toán sau trên web; không lùi được; forfeit=true chỉ khi người dùng nói bỏ cọc',
  params: { ...place(), date: param.date(), datePhrase: param.text(1, 80, { optional: true, hint: 'NGUYÊN VĂN cụm ngày người dùng nói ("thứ hai tuần trước", "cuối tháng"); connector tự đổi ra ngày, ghi đè date' }), note: param.text(3, 1000), forfeit: param.bool({ optional: true }) },
  reasons: ['room_has_no_active_contract', 'already_returned', 'return_date_future'] });

// Mốc 5 (Q22 = a; migration 20261022074815): thêm / bớt người ở (khoá contracts.edit, ghi thẳng; không bỏ được người đại diện) và
// soạn NHÁP HĐ mới (contracts.create; người ký trên web; máy chủ đòi xác nhận khi phòng còn HĐ phủ ngày bắt đầu hoặc trùng nháp 24
// giờ). Khách đã có trong CRM: customerPhone ưu tiên, hoặc customerName; SQL tìm dưới RLS người hỏi, chưa rõ thì hỏi lại.
const customer = () => ({ customerPhone: param.text(6, 20, { optional: true }), customerName: param.name('customer', { optional: true }) });
export const CONTRACT_OCCUPANT_ADD = defineAction({ id: 'contract.occupant_add', page: 'contract', key: 'contracts.edit', class: 'reversible', rpc: RPC,
  title: 'Thêm người ở (khách đã có trong CRM, theo customerPhone hoặc customerName) vào HĐ của phòng; ghi thẳng',
  params: { ...place(), ...customer() }, reasons: ['room_has_no_active_contract', 'already_returned'] });
export const CONTRACT_OCCUPANT_REMOVE = defineAction({ id: 'contract.occupant_remove', page: 'contract', key: 'contracts.edit', class: 'reversible', rpc: RPC,
  title: 'Bớt người ở khỏi HĐ của phòng (không bỏ được người đại diện); customerPhone hoặc customerName; ghi thẳng',
  params: { ...place(), ...customer() },
  reasons: ['room_has_no_active_contract', 'already_returned', 'occupant_not_on_contract', 'cannot_remove_representative'] });
export const CONTRACT_DRAFT = defineAction({ id: 'contract.draft', page: 'contract', key: 'contracts.create', class: 'reversible', rpc: RPC,
  title: 'Soạn NHÁP HĐ mới (ký trên web; không giữ phòng, không tiền): startDate, endDate người dùng nói, giá, cọc, khách tuỳ chọn',
  params: { ...place(), startDate: param.date(), endDate: param.date(), rentPrice: param.vnd(), deposit: param.vnd({ min: 0 }), ...customer(),
    note: param.text(1, 500, { optional: true }) } });

// Mốc 6 (Q23 = a; migration 20261023030305): gia hạn HÀNG LOẠT các HĐ hết hạn trong một tháng, ≤ 20 HĐ một lô, đúng luật
// contract.renew (giữ giá/cọc, months cộng bằng hàm dùng chung, lý do chung). irreversible ⇒ luôn xem trước, một lần đồng ý cho cả
// lô. HĐ đang có báo trả bị loại (D-HĐ7, nêu trong cảnh báo). buildingName tuỳ chọn (vắng = mọi toà trong phạm vi khoá).
export const CONTRACT_RENEW_BATCH = defineAction({ id: 'contract.renew_batch', page: 'contract', key: 'contracts.renew', class: 'irreversible', rpc: RPC,
  title: 'Gia hạn hàng loạt HĐ hết hạn trong tháng endMonth (≤ 20/lô, giữ giá/cọc); thiếu lý do hỏi 1 câu, không có ⇒ noReason',
  params: { buildingName: param.name('building', { optional: true }), endMonth: param.month(), months: param.int(1, 24),
    reason: param.text(8, 1000, { optional: true }), noReason: param.bool({ optional: true }) },
  reasons: ['renew_reason_ask', 'renew_batch_empty'] });

/** Danh mục production của trang (server.mjs nạp cùng các trang khác). */
export const CONTRACT_ACTIONS = Object.freeze([CONTRACT_NOTICE_SET, CONTRACT_NOTICE_CANCEL, CONTRACT_ROOM_LOCK, CONTRACT_ROOM_UNLOCK, CONTRACT_RENEW,
  CONTRACT_RETURN, CONTRACT_OCCUPANT_ADD, CONTRACT_OCCUPANT_REMOVE, CONTRACT_DRAFT, CONTRACT_RENEW_BATCH]);
