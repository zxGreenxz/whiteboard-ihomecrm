// Lưới an toàn của giữ / khoá tạm phòng (PS-K03, ma trận Phòng sale lô ps08 10/11/2026 — ghi sai thật). Người dùng nói "Giữ phòng 303 toà
// 44TL 8 tiếng cho khách xem"; mô hình gọi contract.room_lock hours 8, máy chủ trả invalid_params chung ("sửa theo khuôn"), mô hình tự đổi
// thành 12 rồi gọi lại trong CÙNG lượt — thao tác ghi thẳng nên phòng bị khoá 12 giờ trong khi người dùng nói 8. Lời nhắc "không tự đổi"
// đã có sẵn trong hướng dẫn của invalid_params (review #377) mà không đủ. Ba lớp ở connector:
//   1. (ở đây) số giờ ngoài 6 / 12 / 24 ⇒ needs_input "hỏi lại người dùng" (askUser), nêu đúng ba mức; KHÔNG gửi gì xuống SQL.
//   2. (contract-action-contract.mjs) contract.room_lock khai confirm: 'always' ⇒ lượt gọi không token luôn là phase preview: một lượt
//      gọi không bao giờ khoá phòng, và token chỉ đổi được với ĐÚNG params của bản xem trước (số giờ khác ⇒ confirmation_invalid).
//   3. (consent-guard.mjs) lượt đổi token phải kèm consentText là lời đồng ý rõ: câu yêu cầu ban đầu hay "12 tiếng đi em" không phải.
// Connector không thấy lượt người dùng: mô hình bịa consentText ("ok") vẫn qua lớp 3 — câu đó vào sổ audit của host để lần lại.
// Thuần (không I/O).
export const ROOM_LOCK_ACTION = 'contract.room_lock';
export const ROOM_LOCK_HOURS = Object.freeze([6, 12, 24]);

/** Câu hỏi lại khi số giờ không có (một câu tĩnh, kèm số giờ đã qua khuôn số nguyên của danh mục). */
export const roomLockHoursDetail = hours => `Không giữ phòng được ${hours} giờ: chỉ có mức ${ROOM_LOCK_HOURS.slice(0, -1).join(', ')} hoặc ${ROOM_LOCK_HOURS.at(-1)} giờ. `
  + 'Nói với người dùng mức họ nêu không có và hỏi họ chọn mức nào — KHÔNG tự đổi sang mức khác rồi gọi lại.';

/**
 * contract.room_lock: { offHours } — số giờ (số nguyên) nằm ngoài ba mức ⇒ hỏi lại; null ⇒ cho qua. Thao tác khác ⇒ null.
 */
export function roomLockGuard(actionId, params) {
  if (actionId !== ROOM_LOCK_ACTION || params === null || typeof params !== 'object') return { offHours: null };
  return { offHours: Number.isSafeInteger(params.hours) && !ROOM_LOCK_HOURS.includes(params.hours) ? params.hours : null };
}
